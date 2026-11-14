import type { Store } from "../persistence/store.ts";
export class WakeDispatcher {
  readonly store: Store;
  readonly send: (jobId: string) => Promise<void>;
  constructor(store: Store, send: (jobId: string) => Promise<void>) {
    this.store = store;
    this.send = send;
  }
  async processOne(): Promise<boolean> {
    const wake = await this.store.transaction(async (c) => {
      const runtime = (await c.query("SELECT * FROM runtime_state FOR SHARE"))
        .rows[0];
      if (!runtime || runtime.mode === "restoring") return;
      const row = (
        await c.query(
          `SELECT w.job_id FROM job_wakes w JOIN jobs j ON j.id=w.job_id JOIN sources s ON s.id=j.source_id JOIN groups g ON g.id=s.group_id
    WHERE j.runtime_generation=$1 AND g.channel_id=$2 AND (j.kind IN ('cleanup','unpublish') OR ($5::boolean AND s.expires_at>$3 AND g.state='active' AND (j.kind<>'publish' OR (g.sharing_enabled AND NOT EXISTS (SELECT 1 FROM setup_intents i WHERE i.group_id=g.id AND i.group_revision=g.revision AND i.state IN ('announcing','unknown'))))))
    AND (j.state IN ('queued','retry_wait') AND j.available_at<=$3 OR j.state='leased' AND j.lease_until<=$3)
    AND (w.lease_until IS NULL OR w.lease_until<=$3) AND (w.delivered_at IS NULL OR w.delivered_at<j.available_at OR w.delivered_at<$4)
    ORDER BY w.created_at FOR UPDATE OF w SKIP LOCKED LIMIT 1`,
          [
            runtime.generation,
            this.store.channelId,
            this.store.now(),
            new Date(this.store.now().getTime() - 60_000),
            runtime.mode === "open",
          ],
        )
      ).rows[0];
      if (!row) return;
      return (
        await c.query(
          "UPDATE job_wakes SET fence=fence+1,lease_until=$2 WHERE job_id=$1 RETURNING job_id,fence",
          [row.job_id, new Date(this.store.now().getTime() + 10_000)],
        )
      ).rows[0];
    });
    if (!wake) return false;
    await this.send(wake.job_id);
    await this.store.pool.query(
      "UPDATE job_wakes SET delivered_at=$3,lease_until=NULL WHERE job_id=$1 AND fence=$2",
      [wake.job_id, wake.fence, this.store.now()],
    );
    return true;
  }
}
