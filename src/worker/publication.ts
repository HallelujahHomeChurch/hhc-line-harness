import { isAssetId } from "../domain/asset-id.ts";
import type { PoolClient } from "pg";
import type { Store } from "../persistence/store.ts";
import type { Source } from "./original.ts";
import { PermanentSourceError } from "./original.ts";
import { Jobs } from "./jobs.ts";
import type { Job } from "./jobs.ts";
export interface Publication {
  id: string;
  source_id: string;
  collection_id: string;
  item_id: string | null;
  source_revision: string;
  group_revision: string;
  acl_revision: string;
  binding_generation: string;
  state: string;
}
export interface PublicationRecord {
  itemId: string;
  collectionId: string;
  assetId: string;
  revision: string;
  state: "staged" | "active" | "deleted";
}
export interface PublicationPorts {
  lookup: (publication: Publication) => Promise<PublicationRecord | undefined>;
  stage: (
    publication: Publication,
    source: Source,
  ) => Promise<PublicationRecord>;
  activate: (publication: Publication) => Promise<PublicationRecord>;
}
export class PublicationWorker {
  readonly store: Store;
  readonly ports: PublicationPorts;
  readonly jobs: Jobs;
  constructor(store: Store, ports: PublicationPorts) {
    this.store = store;
    this.ports = ports;
    this.jobs = new Jobs(store);
  }
  async approved(
    c: PoolClient,
    job: Job,
    source: Source,
    p?: Publication,
  ): Promise<void> {
    await this.jobs.guard(job, c);
    if (p) {
      const current = (
        await c.query<Publication>(
          "SELECT * FROM publications WHERE id=$1 FOR UPDATE",
          [p.id],
        )
      ).rows[0];
      if (!current) throw new PermanentSourceError();
      p = current;
    }
    const g = (
      await c.query("SELECT * FROM groups WHERE id=$1", [source.group_id])
    ).rows[0];
    if (
      !g.sharing_enabled ||
      g.collection_id !== source.publication_collection_id ||
      g.acl_revision !== source.publication_acl_revision ||
      g.binding_generation !== source.publication_binding_generation ||
      (p &&
        (p.state === "revoked" ||
          p.source_revision !== source.revision ||
          p.collection_id !== g.collection_id ||
          p.acl_revision !== g.acl_revision ||
          p.binding_generation !== g.binding_generation))
    )
      throw new PermanentSourceError();
  }
  matches(p: Publication, s: Source, r: PublicationRecord) {
    if (
      r.collectionId !== p.collection_id ||
      r.assetId !== s.asset_id ||
      r.revision !== p.id ||
      !isAssetId(r.itemId) ||
      (p.item_id && p.item_id !== r.itemId)
    )
      throw new PermanentSourceError();
  }
  async processOne(): Promise<boolean> {
    const job = await this.jobs.claim("publish");
    if (!job) return false;
    try {
      const source = (
        await this.store.pool.query<Source>(
          "SELECT * FROM sources WHERE id=$1",
          [job.source_id],
        )
      ).rows[0]!;
      let p = await this.store.transaction(async (c) => {
        await this.approved(c, job, source);
        await c.query(
          `INSERT INTO publications(source_id,collection_id,source_revision,group_revision,acl_revision,binding_generation,created_at)
     SELECT s.id,s.publication_collection_id,s.revision,g.revision,s.publication_acl_revision,s.publication_binding_generation,$2 FROM sources s JOIN groups g ON g.id=s.group_id WHERE s.id=$1 ON CONFLICT DO NOTHING`,
          [source.id, this.store.now()],
        );
        return (
          await c.query<Publication>(
            "SELECT * FROM publications WHERE source_id=$1 AND collection_id=$2 AND binding_generation=$3",
            [
              source.id,
              source.publication_collection_id,
              source.publication_binding_generation,
            ],
          )
        ).rows[0]!;
      });
      let remote = await this.ports.lookup(p);
      if (!remote) {
        await this.store.transaction((c) => this.approved(c, job, source, p));
        remote = await this.ports.stage(p, source);
      }
      if (remote.state === "deleted") throw new PermanentSourceError();
      this.matches(p, source, remote);
      // Keep the external ID even if revocation won while the request was in flight.
      await this.store.pool.query(
        "UPDATE publications SET item_id=$2 WHERE id=$1 AND (item_id IS NULL OR item_id=$2)",
        [p.id, remote.itemId],
      );
      p = { ...p, item_id: remote.itemId };
      await this.store.transaction(async (c) => {
        const current = (
          await c.query<Publication>("SELECT * FROM publications WHERE id=$1", [
            p.id,
          ])
        ).rows[0]!;
        await this.approved(c, job, source, current);
        if (
          remote!.state === "active" &&
          !["approved", "active"].includes(current.state)
        )
          throw new PermanentSourceError();
        await c.query(
          "UPDATE publications SET state='approved' WHERE id=$1 AND state<>'active'",
          [p.id],
        );
      });
      if (remote.state !== "active") remote = await this.ports.activate(p);
      if (remote.state === "deleted") throw new PermanentSourceError();
      this.matches(p, source, remote);
      if (remote.state !== "active") throw new Error("publication_unavailable");
      await this.store.transaction(async (c) => {
        const current = (
          await c.query<Publication>("SELECT * FROM publications WHERE id=$1", [
            p.id,
          ])
        ).rows[0]!;
        await this.approved(c, job, source, current);
        await c.query("UPDATE publications SET state='active' WHERE id=$1", [
          p.id,
        ]);
        await c.query(
          "UPDATE jobs SET state='completed',lease_until=NULL WHERE id=$1",
          [job.id],
        );
      });
    } catch (error) {
      try {
        await this.jobs.fail(job, error instanceof PermanentSourceError);
      } catch (fenced) {
        if (!(fenced instanceof Error && fenced.message === "job_fenced"))
          throw fenced;
      }
    }
    return true;
  }
}
