import { applyLegacyLifecycle, expireLegacy } from "./legacy.ts";
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import type { LineEvent } from "./events.ts";
import type { Store } from "../persistence/store.ts";
export const sourceKey = (channel: string, group: string, message: string) =>
  createHash("sha256")
    .update(JSON.stringify([channel, group, message]))
    .digest("hex");
export async function invalidate(
  c: PoolClient,
  id: string,
  now: Date,
  state: "revoked" | "expired",
) {
  const source = (
    await c.query(
      "UPDATE sources SET state=$2,revision=revision+1,body=NULL,file_name=NULL,upload_file_name=NULL,author_id=NULL,description=NULL WHERE id=$1 AND state NOT IN ('revoked','expired') RETURNING id,asset_id,revision",
      [id, state],
    )
  ).rows[0];
  if (!source) return;
  await c.query(
    "UPDATE source_edits SET state='cancelled',text_ciphertext=NULL WHERE source_id=$1 AND state='preview'",
    [id],
  );
  await c.query(
    "UPDATE search_jobs SET state='cancelled',fence=fence+1,result_ciphertext=NULL,request_ciphertext=NULL,source_ids='{}' WHERE $1::uuid=ANY(source_ids) OR excluded_source_id=$1",
    [id],
  );
  await c.query(
    "UPDATE conversations SET checkpoint_ciphertext=NULL,checkpoint_sources='{}' WHERE $1::uuid=ANY(checkpoint_sources)",
    [id],
  );
  await c.query(
    "UPDATE model_runs SET state='cancelled' WHERE $1::uuid=ANY(source_ids)",
    [id],
  );
  await c.query(
    "DELETE FROM model_steps s USING model_runs r WHERE s.run_id=r.id AND $1::uuid=ANY(r.source_ids)",
    [id],
  );
  await c.query(
    "DELETE FROM agent_tools t USING model_runs r WHERE t.run_id=r.id AND $1::uuid=ANY(r.source_ids)",
    [id],
  );
  await c.query("DELETE FROM embedding_documents WHERE source_id=$1", [id]);
  await c.query("DELETE FROM source_indexes WHERE source_id=$1", [id]);
  await c.query(
    "DELETE FROM source_relations WHERE source_id=$1 OR related_source_id=$1 OR evidence_source_id=$1",
    [id],
  );
  await c.query(
    "UPDATE jobs SET state='cancelled',fence=fence+1 WHERE source_id=$1 AND kind NOT IN ('cleanup','unpublish') AND state NOT IN ('completed','failed','cancelled')",
    [id],
  );
  await c.query("UPDATE publications SET state='revoked' WHERE source_id=$1", [
    id,
  ]);
  if (source.asset_id)
    await c.query(
      "INSERT INTO orphan_assets(asset_id,source_id,created_at) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
      [source.asset_id, id, now],
    );
  const job = (
    await c.query(
      "INSERT INTO jobs(source_id,kind,runtime_generation,source_revision,created_at,available_at) SELECT $1,'cleanup',generation,$2,$3,$3 FROM runtime_state ON CONFLICT DO NOTHING RETURNING id",
      [id, source.revision, now],
    )
  ).rows[0];
  if (job)
    await c.query("INSERT INTO job_wakes(job_id,created_at) VALUES($1,$2)", [
      job.id,
      now,
    ]);
}
export async function applyLifecycle(
  c: PoolClient,
  channel: string,
  event: LineEvent,
  now: Date,
): Promise<boolean> {
  if (
    event.scope !== "group" ||
    !["unsend", "leave", "memberLeft"].includes(event.type)
  )
    return false;
  await applyLegacyLifecycle(c, channel, event);
  const group = (
    await c.query(
      "SELECT id FROM groups WHERE channel_id=$1 AND line_group_id=$2 FOR UPDATE",
      [channel, event.scopeId],
    )
  ).rows[0];
  if (event.type === "unsend" && event.unsentMessageId) {
    await c.query(
      "INSERT INTO source_tombstones(source_key,revoked_at,expires_at) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
      [
        sourceKey(channel, event.scopeId, event.unsentMessageId),
        now,
        new Date(now.getTime() + 120 * 86400000),
      ],
    );
    if (group) {
      const source = (
        await c.query(
          "SELECT id FROM sources WHERE group_id=$1 AND message_id=$2",
          [group.id, event.unsentMessageId],
        )
      ).rows[0];
      if (source) await invalidate(c, source.id, now, "revoked");
    }
  } else if (group) {
    if (event.type === "leave") {
      await c.query(
        "UPDATE groups SET state='left',revision=revision+1 WHERE id=$1 AND state NOT IN ('deleting','deleted')",
        [group.id],
      );
      await c.query(
        "UPDATE jobs SET state='held',fence=fence+1 FROM sources s WHERE jobs.source_id=s.id AND s.group_id=$1 AND jobs.kind NOT IN ('cleanup','unpublish') AND jobs.state IN ('queued','retry_wait','leased')",
        [group.id],
      );
    } else
      await c.query("UPDATE groups SET revision=revision+1 WHERE id=$1", [
        group.id,
      ]);
    await c.query(
      "UPDATE deliveries SET state='cancelled',token_ciphertext=NULL,body=NULL,actions=NULL WHERE group_id=$1 AND state='pending'",
      [group.id],
    );
  }
  return true;
}
export async function sweepExpired(store: Store): Promise<number> {
  const expired = await store.transaction(async (c) => {
    const runtime = (await c.query("SELECT * FROM runtime_state FOR SHARE"))
      .rows[0];
    if (runtime?.mode === "restoring") return 0;
    await expireLegacy(c, store.now());
    if (runtime?.mode !== "open") return 0;
    const candidates = (
      await c.query(
        "SELECT s.id,s.group_id FROM sources s JOIN groups g ON g.id=s.group_id WHERE g.channel_id=$1 AND s.state NOT IN ('revoked','expired') AND (s.expires_at<=$2 OR g.state IN ('deleting','deleted')) ORDER BY s.group_id,s.id LIMIT 50",
        [store.channelId, store.now()],
      )
    ).rows;
    for (const s of candidates) {
      const g = (
        await c.query("SELECT state FROM groups WHERE id=$1 FOR UPDATE", [
          s.group_id,
        ])
      ).rows[0];
      await invalidate(
        c,
        s.id,
        store.now(),
        ["deleting", "deleted"].includes(g.state) ? "revoked" : "expired",
      );
    }
    return candidates.length;
  });
  await store.transaction(async (c) => {
    const runtime = (await c.query("SELECT * FROM runtime_state FOR SHARE"))
      .rows[0];
    if (runtime?.mode !== "open") return;
    const obsolete = (
      await c.query(
        `SELECT p.id,p.source_id,s.group_id,s.revision FROM publications p JOIN sources s ON s.id=p.source_id JOIN groups g ON g.id=s.group_id
      WHERE g.channel_id=$1 AND p.removed_at IS NULL AND (p.state='revoked' OR g.collection_id IS DISTINCT FROM p.collection_id OR g.binding_generation IS DISTINCT FROM p.binding_generation) ORDER BY s.group_id,p.id LIMIT 50`,
        [store.channelId],
      )
    ).rows;
    for (const p of obsolete) {
      await c.query("SELECT id FROM groups WHERE id=$1 FOR UPDATE", [
        p.group_id,
      ]);
      const changed = await c.query(
        `UPDATE publications p SET state='revoked' FROM groups g
        WHERE p.id=$1 AND g.id=$2 AND p.removed_at IS NULL AND (p.state='revoked' OR g.collection_id IS DISTINCT FROM p.collection_id OR g.binding_generation IS DISTINCT FROM p.binding_generation) RETURNING p.id`,
        [p.id, p.group_id],
      );
      if (!changed.rowCount) continue;
      const job = (
        await c.query(
          "INSERT INTO jobs(source_id,kind,runtime_generation,source_revision,created_at,available_at) VALUES($1,'unpublish',$2,$3,$4,$4) ON CONFLICT(source_id,kind) DO UPDATE SET state='queued',runtime_generation=EXCLUDED.runtime_generation,source_revision=EXCLUDED.source_revision,available_at=EXCLUDED.available_at,lease_until=NULL,fence=jobs.fence+1 WHERE jobs.state IN ('held','cancelled','completed','failed') RETURNING id",
          [p.source_id, runtime.generation, p.revision, store.now()],
        )
      ).rows[0];
      if (job)
        await c.query(
          "INSERT INTO job_wakes(job_id,created_at) VALUES($1,$2) ON CONFLICT(job_id) DO UPDATE SET delivered_at=NULL",
          [job.id, store.now()],
        );
    }
    await c.query(
      "UPDATE deliveries SET state=CASE WHEN state='pending' THEN 'expired' ELSE 'unknown' END,token_ciphertext=NULL,body=NULL,actions=NULL WHERE state IN ('pending','attempt_reserved') AND expires_at<=$1",
      [store.now()],
    );
  });
  await settleJobs(store);
  await store.transaction(async (c) => {
    const runtime = (await c.query("SELECT mode FROM runtime_state FOR SHARE"))
      .rows[0];
    if (runtime?.mode !== "open") return;
    await c.query(
      `UPDATE groups SET state='deleted',revision=revision+1 WHERE id IN (
      SELECT g.id FROM groups g WHERE g.channel_id=$1 AND g.state='deleting'
      AND NOT EXISTS(SELECT 1 FROM sources s WHERE s.group_id=g.id AND (s.state NOT IN ('revoked','expired') OR NOT EXISTS(SELECT 1 FROM jobs j WHERE j.source_id=s.id AND j.kind='cleanup' AND j.state='completed')))
      AND NOT EXISTS(SELECT 1 FROM jobs j JOIN sources s ON s.id=j.source_id WHERE s.group_id=g.id AND j.state NOT IN ('completed','failed','cancelled'))
      AND NOT EXISTS(SELECT 1 FROM publications p JOIN sources s ON s.id=p.source_id WHERE s.group_id=g.id AND p.removed_at IS NULL)
      AND NOT EXISTS(SELECT 1 FROM orphan_assets o JOIN sources s ON s.id=o.source_id WHERE s.group_id=g.id AND o.removed_at IS NULL)
      ORDER BY g.id LIMIT 50 FOR UPDATE)`,
      [store.channelId],
    );
  });
  return expired;
}

async function settleJobs(store: Store): Promise<void> {
  await store.transaction(async (c) => {
    const runtime = (await c.query("SELECT * FROM runtime_state FOR SHARE"))
      .rows[0];
    if (runtime?.mode !== "open") return;
    const candidates = (
      await c.query(
        `SELECT j.id,j.source_id,s.group_id FROM jobs j JOIN sources s ON s.id=j.source_id JOIN groups g ON g.id=s.group_id
      WHERE g.channel_id=$1 AND j.kind IN ('download','index','publish') AND j.state IN ('queued','retry_wait','leased','held')
      AND (j.deadline<=$2 OR j.attempts>=5 AND (j.state<>'leased' OR j.lease_until<=$2)) ORDER BY s.group_id,j.source_id,j.id LIMIT 50`,
        [store.channelId, store.now()],
      )
    ).rows;
    for (const j of candidates) {
      await c.query("SELECT id FROM groups WHERE id=$1 FOR UPDATE", [
        j.group_id,
      ]);
      await c.query("SELECT id FROM sources WHERE id=$1 FOR UPDATE", [
        j.source_id,
      ]);
      const changed = (
        await c.query(
          `UPDATE jobs SET state='failed',fence=fence+1,lease_until=NULL,failure_code='retry_exhausted'
        WHERE id=$1 AND state IN ('queued','retry_wait','leased','held') AND (deadline<=$2 OR attempts>=5 AND (state<>'leased' OR lease_until<=$2)) RETURNING kind`,
          [j.id, store.now()],
        )
      ).rows[0];
      if (changed?.kind === "download")
        await c.query(
          "UPDATE sources SET state='failed' WHERE id=$1 AND state NOT IN ('ready','revoked','expired')",
          [j.source_id],
        );
    }
    // Failed downloads may have created an Asset before their final response was lost.
    const cleanup = (
      await c.query(
        `INSERT INTO jobs(source_id,kind,runtime_generation,source_revision,created_at,available_at)
      SELECT s.id,'cleanup',$1,s.revision,$2,$2 FROM sources s JOIN groups g ON g.id=s.group_id
      WHERE g.channel_id=$3 AND s.state='failed' AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.source_id=s.id AND j.kind='cleanup') ORDER BY s.id LIMIT 50
      ON CONFLICT DO NOTHING RETURNING id`,
        [runtime.generation, store.now(), store.channelId],
      )
    ).rows;
    for (const j of cleanup)
      await c.query("INSERT INTO job_wakes(job_id,created_at) VALUES($1,$2)", [
        j.id,
        store.now(),
      ]);
  });
}
