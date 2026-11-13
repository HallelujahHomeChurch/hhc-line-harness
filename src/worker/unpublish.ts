import type { Store } from "../persistence/store.ts";
import type { Publication, PublicationRecord } from "./publication.ts";
export class UnpublishWorker {
  readonly store: Store;
  readonly ports: {
    lookup: (p: Publication) => Promise<PublicationRecord | undefined>;
    remove: (p: Publication) => Promise<void>;
  };
  constructor(store: Store, ports: UnpublishWorker["ports"]) {
    this.store = store;
    this.ports = ports;
  }
  async processOne(): Promise<boolean> {
    const task = await this.store.transaction(async (c) => {
      const runtime = (await c.query("SELECT * FROM runtime_state FOR SHARE"))
        .rows[0];
      if (!runtime || runtime.mode === "restoring") return;
      const candidate = (
        await c.query(
          `SELECT j.id,s.group_id,s.id AS source_id FROM jobs j JOIN sources s ON s.id=j.source_id JOIN groups g ON g.id=s.group_id WHERE j.kind='unpublish' AND j.runtime_generation=$1 AND g.channel_id=$2 AND (j.state IN ('queued','retry_wait') AND j.available_at<=$3 OR j.state='leased' AND j.lease_until<=$3) ORDER BY j.created_at LIMIT 1`,
          [runtime.generation, this.store.channelId, this.store.now()],
        )
      ).rows[0];
      if (!candidate) return;
      await c.query("SELECT id FROM groups WHERE id=$1 FOR SHARE", [
        candidate.group_id,
      ]);
      const source = (
        await c.query(
          "SELECT asset_id,expires_at FROM sources WHERE id=$1 FOR SHARE",
          [candidate.source_id],
        )
      ).rows[0];
      const job = (
        await c.query(
          "UPDATE jobs SET state='leased',fence=fence+1,lease_until=$2 WHERE id=$1 AND (state IN ('queued','retry_wait') OR state='leased' AND lease_until<=$3) RETURNING fence",
          [
            candidate.id,
            new Date(this.store.now().getTime() + 60_000),
            this.store.now(),
          ],
        )
      ).rows[0];
      if (!job) return;
      const publications = (
        await c.query<Publication>(
          "SELECT * FROM publications WHERE source_id=$1 AND state='revoked' AND removed_at IS NULL",
          [candidate.source_id],
        )
      ).rows;
      return { ...candidate, ...job, source, publications };
    });
    if (!task) return false;
    let complete = true;
    for (const publication of task.publications) {
      try {
        const remote = await this.ports.lookup(publication);
        if (remote) {
          if (
            remote.revision !== publication.id ||
            remote.collectionId !== publication.collection_id ||
            (remote.state !== "deleted" &&
              remote.assetId !== task.source.asset_id) ||
            (publication.item_id && publication.item_id !== remote.itemId)
          )
            throw new Error("publication_identity_mismatch");
          publication.item_id = remote.itemId;
          await this.store.pool.query(
            "UPDATE publications SET item_id=$2 WHERE id=$1",
            [publication.id, remote.itemId],
          );
          if (remote.state !== "deleted") await this.ports.remove(publication);
        } else if (
          this.store.now().getTime() <=
          task.source.expires_at.getTime() + 60_000
        ) {
          complete = false;
          continue;
        }
        await this.store.pool.query(
          "UPDATE publications SET removed_at=$2 WHERE id=$1 AND state='revoked'",
          [publication.id, this.store.now()],
        );
      } catch {
        complete = false;
      }
    }
    await this.store.pool.query(
      "UPDATE jobs SET state=$3,available_at=$4,lease_until=NULL WHERE id=$1 AND fence=$2 AND state='leased'",
      [
        task.id,
        task.fence,
        complete ? "completed" : "retry_wait",
        new Date(this.store.now().getTime() + 60_000),
      ],
    );
    return true;
  }
}
