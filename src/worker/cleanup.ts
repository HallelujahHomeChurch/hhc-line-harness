import type { Store } from "../persistence/store.ts";
import type { AssetRecord, Source } from "./original.ts";
export class CleanupWorker {
  readonly store: Store;
  readonly ports: {
    lookup: (operation: string) => Promise<AssetRecord | undefined>;
    remove: (assetId: string) => Promise<void>;
  };
  constructor(store: Store, ports: CleanupWorker["ports"]) {
    this.store = store;
    this.ports = ports;
  }
  async processOne(): Promise<boolean> {
    const task = await this.store.transaction(async (c) => {
      const runtime = (await c.query("SELECT * FROM runtime_state FOR SHARE"))
        .rows[0];
      if (!runtime || runtime.mode === "restoring") return;
      const next = (
        await c.query(
          `SELECT j.id,s.group_id,j.source_id FROM jobs j JOIN sources s ON s.id=j.source_id JOIN groups g ON g.id=s.group_id
    WHERE j.kind='cleanup' AND g.channel_id=$1 AND j.runtime_generation=$2 AND s.state IN ('revoked','expired','failed')
    AND (j.state IN ('queued','retry_wait') AND j.available_at<=$3 OR j.state='leased' AND j.lease_until<=$3) ORDER BY j.created_at LIMIT 1`,
          [this.store.channelId, runtime.generation, this.store.now()],
        )
      ).rows[0];
      if (!next) return;
      await c.query("SELECT id FROM groups WHERE id=$1 FOR SHARE", [
        next.group_id,
      ]);
      const source = (
        await c.query<Source>("SELECT * FROM sources WHERE id=$1 FOR UPDATE", [
          next.source_id,
        ])
      ).rows[0]!;
      const job = (
        await c.query(
          "UPDATE jobs SET lease_recoveries=lease_recoveries+CASE WHEN state='leased' THEN 1 ELSE 0 END,state='leased',fence=fence+1,attempts=attempts+1,lease_until=$2 WHERE id=$1 AND (state IN ('queued','retry_wait') OR state='leased' AND lease_until<=$3) RETURNING id,fence",
          [
            next.id,
            new Date(this.store.now().getTime() + 60_000),
            this.store.now(),
          ],
        )
      ).rows[0];
      if (job) return { ...job, source };
    });
    if (!task) return false;
    let complete = false;
    try {
      let id = task.source.asset_id;
      if (!id && task.source.upload_state !== "none") {
        const asset = await this.ports.lookup(task.source.id);
        if (asset) {
          if (
            asset.ref !== task.source.id ||
            asset.revision !== task.source.asset_source_revision
          )
            throw new Error("cleanup_identity_mismatch");
          id = asset.id;
          await this.store.pool.query(
            "INSERT INTO orphan_assets(asset_id,source_id,created_at) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
            [id, task.source.id, this.store.now()],
          );
        }
      }
      if (id) {
        await this.ports.remove(id);
        await this.store.pool.query(
          "UPDATE orphan_assets SET removed_at=$2 WHERE asset_id=$1",
          [id, this.store.now()],
        );
        complete = true;
      } else
        complete =
          task.source.upload_state === "none" ||
          this.store.now().getTime() >
            task.source.expires_at.getTime() + 60_000;
    } catch {
      /* Retain the operation until metadata recovery and deletion are confirmed. */
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
