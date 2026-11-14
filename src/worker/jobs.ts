import type { PoolClient } from "pg";
import type { Store } from "../persistence/store.ts";
export interface Job {
  id: string;
  source_id: string;
  group_id: string;
  kind: string;
  fence: string;
  runtime_generation: string;
  source_revision: string;
  attempts: number;
}
export class Jobs {
  readonly store: Store;
  constructor(store: Store) {
    this.store = store;
  }
  async claim(
    kind: "download" | "index" | "publish",
  ): Promise<Job | undefined> {
    return this.store.transaction(async (c) => {
      const runtime = (await c.query("SELECT * FROM runtime_state FOR SHARE"))
        .rows[0];
      if (runtime?.mode !== "open") return;
      const candidate = (
        await c.query(
          `SELECT j.id,s.group_id,j.source_id FROM jobs j JOIN sources s ON s.id=j.source_id JOIN groups g ON g.id=s.group_id
    WHERE j.kind=$1 AND (j.kind<>'publish' OR (g.sharing_enabled AND NOT EXISTS (SELECT 1 FROM setup_intents i WHERE i.group_id=g.id AND i.group_revision=g.revision AND i.state IN ('announcing','unknown')))) AND j.runtime_generation=$2 AND g.channel_id=$3 AND g.state='active' AND s.state NOT IN ('revoked','expired','failed') AND s.expires_at>$4
    AND j.attempts<5 AND (j.deadline IS NULL OR j.deadline>$4) AND (j.state IN ('queued','retry_wait') AND j.available_at<=$4 OR j.state='leased' AND j.lease_until<=$4)
    ORDER BY j.created_at,j.id LIMIT 1`,
          [kind, runtime.generation, this.store.channelId, this.store.now()],
        )
      ).rows[0];
      if (!candidate) return;
      const group = (
        await c.query(
          "SELECT g.sharing_enabled,EXISTS (SELECT 1 FROM setup_intents i WHERE i.group_id=g.id AND i.group_revision=g.revision AND i.state IN ('announcing','unknown')) AS publication_pending FROM groups g WHERE g.id=$1 FOR SHARE",
          [candidate.group_id],
        )
      ).rows[0];
      if (
        kind === "publish" &&
        (!group?.sharing_enabled || group.publication_pending)
      )
        return;
      await c.query("SELECT id FROM sources WHERE id=$1 FOR UPDATE", [
        candidate.source_id,
      ]);
      const row = (
        await c.query(
          `UPDATE jobs SET lease_recoveries=lease_recoveries+CASE WHEN state='leased' THEN 1 ELSE 0 END,state='leased',fence=fence+1,attempts=attempts+1,lease_until=$2 WHERE id=$1
    AND attempts<5 AND (deadline IS NULL OR deadline>$3) AND (state IN ('queued','retry_wait') AND available_at<=$3 OR state='leased' AND lease_until<=$3) RETURNING *`,
          [
            candidate.id,
            new Date(this.store.now().getTime() + 60_000),
            this.store.now(),
          ],
        )
      ).rows[0];
      if (!row) return;
      const job = { ...row, group_id: candidate.group_id } as Job;
      await this.guard(job, c);
      return job;
    });
  }
  async guard(job: Job, client?: PoolClient): Promise<void> {
    const check = async (c: PoolClient) => {
      const runtime = (await c.query("SELECT * FROM runtime_state FOR SHARE"))
        .rows[0];
      const g = (
        await c.query("SELECT state FROM groups WHERE id=$1 FOR SHARE", [
          job.group_id,
        ])
      ).rows[0];
      const s = (
        await c.query("SELECT * FROM sources WHERE id=$1 FOR UPDATE", [
          job.source_id,
        ])
      ).rows[0];
      const j = (
        await c.query("SELECT * FROM jobs WHERE id=$1 FOR UPDATE", [job.id])
      ).rows[0];
      if (
        runtime?.mode !== "open" ||
        runtime.generation !== job.runtime_generation ||
        g?.state !== "active" ||
        !s ||
        ["revoked", "expired", "failed"].includes(s.state) ||
        s.expires_at <= this.store.now() ||
        s.revision !== job.source_revision ||
        j?.state !== "leased" ||
        j.fence !== job.fence ||
        j.lease_until <= this.store.now() ||
        (j.deadline && j.deadline <= this.store.now())
      )
        throw new Error("job_fenced");
    };
    if (client) await check(client);
    else await this.store.transaction(check);
  }
  async finish(job: Job): Promise<void> {
    await this.store.transaction(async (c) => {
      await this.guard(job, c);
      await c.query(
        "UPDATE jobs SET state='completed',lease_until=NULL WHERE id=$1",
        [job.id],
      );
    });
  }
  async fail(job: Job, permanent = false): Promise<void> {
    await this.store.transaction(async (c) => {
      await this.guard(job, c);
      const failed = permanent || job.attempts >= 5;
      const delays = [2000, 10000, 60000, 300000];
      await c.query(
        "UPDATE jobs SET state=$2,lease_until=NULL,available_at=$3,failure_code=$4 WHERE id=$1",
        [
          job.id,
          failed ? "failed" : "retry_wait",
          new Date(
            this.store.now().getTime() + (delays[job.attempts - 1] ?? 300000),
          ),
          permanent ? "permanent_failure" : "dependency_unavailable",
        ],
      );
      if (failed && job.kind === "download")
        await c.query("UPDATE sources SET state='failed' WHERE id=$1", [
          job.source_id,
        ]);
    });
  }
}
