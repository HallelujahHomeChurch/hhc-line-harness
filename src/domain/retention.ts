import type { Store } from "../persistence/store.ts";
const DAY = 86400000;
export class Retention {
  readonly store: Store;
  constructor(store: Store) {
    this.store = store;
  }
  async sweep() {
    await this.store.transaction(async (c) => {
      const runtime = (
        await c.query("SELECT mode FROM runtime_state FOR UPDATE")
      ).rows[0];
      if (runtime?.mode === "restoring") return;
      const now = this.store.now(),
        day = new Date(now.getTime() - DAY),
        idle = new Date(now.getTime() - 30 * 60000),
        metadata = new Date(now.getTime() - 120 * DAY);
      await c.query(
        "UPDATE runtime_state SET ingest_floor=GREATEST(ingest_floor,$1),floor_enforced=true",
        [day],
      );
      await c.query(
        "UPDATE deliveries SET token_ciphertext=NULL,body=NULL,actions=NULL,state=CASE WHEN state='pending' THEN 'expired' WHEN state='attempt_reserved' THEN 'unknown' ELSE state END WHERE id IN (SELECT id FROM deliveries WHERE expires_at<=$1 AND (token_ciphertext IS NOT NULL OR body IS NOT NULL OR actions IS NOT NULL OR state IN ('pending','attempt_reserved')) LIMIT 100)",
        [now],
      );
      await c.query(
        "UPDATE interactions SET state=CASE WHEN state IN ('queued','running') THEN 'failed' ELSE state END,fence=fence+1,payload_ciphertext=NULL,lease_until=NULL WHERE id IN (SELECT id FROM interactions WHERE expires_at<=$1 AND (payload_ciphertext IS NOT NULL OR state IN ('queued','running')) LIMIT 100)",
        [now],
      );
      await c.query(
        "UPDATE conversations SET checkpoint_ciphertext=NULL,checkpoint_sources='{}' WHERE id IN (SELECT id FROM conversations WHERE last_interaction_at<=$1 AND checkpoint_ciphertext IS NOT NULL LIMIT 100)",
        [idle],
      );
      await c.query(
        "UPDATE admin_conversations SET last_result_id=NULL WHERE id IN (SELECT id FROM admin_conversations WHERE last_interaction_at<=$1 AND last_result_id IS NOT NULL LIMIT 100)",
        [idle],
      );
      await c.query(
        "UPDATE search_jobs SET request_ciphertext=NULL,result_ciphertext=NULL,source_ids='{}',state='cancelled',fence=fence+1,lease_until=NULL WHERE id IN (SELECT id FROM search_jobs WHERE expires_at<=$1 AND (request_ciphertext IS NOT NULL OR result_ciphertext IS NOT NULL OR state IN ('queued','running')) LIMIT 100)",
        [now],
      );
      await c.query(
        "UPDATE admin_queries SET query_ciphertext=NULL,result_ciphertext=NULL,state='cancelled',fence=fence+1,lease_until=NULL WHERE id IN (SELECT id FROM admin_queries WHERE expires_at<=$1 AND (query_ciphertext IS NOT NULL OR result_ciphertext IS NOT NULL OR state IN ('queued','running')) LIMIT 100)",
        [now],
      );
      await c.query(
        "UPDATE source_edits SET state=CASE WHEN state='preview' THEN 'cancelled' ELSE state END,text_ciphertext=NULL WHERE id IN (SELECT id FROM source_edits WHERE expires_at<=$1 AND (state='preview' OR text_ciphertext IS NOT NULL) LIMIT 100)",
        [now],
      );
      const runs = (
        await c.query(
          "SELECT id FROM model_runs WHERE created_at<=$1 AND (actor_id IS NOT NULL OR cardinality(source_ids)>0 OR state='running' OR EXISTS(SELECT 1 FROM model_steps WHERE run_id=model_runs.id) OR EXISTS(SELECT 1 FROM agent_tools WHERE run_id=model_runs.id)) ORDER BY created_at LIMIT 100",
          [day],
        )
      ).rows.map((r) => r.id);
      if (runs.length) {
        await c.query("DELETE FROM model_steps WHERE run_id=ANY($1::uuid[])", [
          runs,
        ]);
        await c.query("DELETE FROM agent_tools WHERE run_id=ANY($1::uuid[])", [
          runs,
        ]);
        await c.query(
          "UPDATE model_runs SET actor_id=NULL,source_ids='{}',state=CASE WHEN state='running' THEN 'cancelled' ELSE state END WHERE id=ANY($1::uuid[])",
          [runs],
        );
      }
      await c.query(
        "UPDATE sources SET upload_file_name=NULL,body=NULL,file_name=NULL,author_id=NULL,description=NULL WHERE id IN (SELECT id FROM sources WHERE state IN ('revoked','expired') AND (upload_file_name IS NOT NULL OR body IS NOT NULL OR file_name IS NOT NULL OR author_id IS NOT NULL OR description IS NOT NULL) LIMIT 100)",
      );
      await c.query(
        "DELETE FROM event_receipts WHERE (channel_id,event_id) IN (SELECT channel_id,event_id FROM event_receipts WHERE expires_at<=$1 AND published_at<(SELECT ingest_floor FROM runtime_state) LIMIT 100)",
        [now],
      );
      await c.query(
        "DELETE FROM source_tombstones WHERE source_key IN (SELECT source_key FROM source_tombstones WHERE expires_at<=$1 AND revoked_at<(SELECT ingest_floor FROM runtime_state) LIMIT 100)",
        [now],
      );
      await c.query(
        "DELETE FROM audit_outbox WHERE id IN (SELECT id FROM audit_outbox WHERE state='delivered' AND delivered_at<=$1 LIMIT 100)",
        [metadata],
      );
      await c.query(
        "DELETE FROM interactions WHERE id IN (SELECT id FROM interactions WHERE expires_at<=$1 AND state IN ('completed','failed') LIMIT 100)",
        [metadata],
      );
      await c.query(
        "DELETE FROM deliveries WHERE id IN (SELECT d.id FROM deliveries d WHERE d.expires_at<=$1 AND NOT EXISTS(SELECT 1 FROM interactions i WHERE i.delivery_id=d.id) AND NOT EXISTS(SELECT 1 FROM setup_intents i WHERE i.delivery_id=d.id) LIMIT 100)",
        [metadata],
      );
      await c.query(
        "DELETE FROM source_edits WHERE id IN (SELECT id FROM source_edits WHERE expires_at<=$1 AND state<>'preview' LIMIT 100)",
        [metadata],
      );
      await c.query(
        "DELETE FROM search_jobs WHERE id IN (SELECT j.id FROM search_jobs j WHERE j.expires_at<=$1 AND NOT EXISTS(SELECT 1 FROM deliveries d WHERE d.search_result_id=j.id) LIMIT 100)",
        [metadata],
      );
      await c.query(
        "DELETE FROM admin_queries WHERE id IN (SELECT j.id FROM admin_queries j WHERE j.expires_at<=$1 AND NOT EXISTS(SELECT 1 FROM deliveries d WHERE d.admin_query_id=j.id) AND NOT EXISTS(SELECT 1 FROM admin_conversations a WHERE a.last_result_id=j.id) LIMIT 100)",
        [metadata],
      );
      await c.query(
        "DELETE FROM conversations WHERE id IN (SELECT s.id FROM conversations s WHERE s.last_interaction_at<=$1 AND NOT EXISTS(SELECT 1 FROM search_jobs j WHERE j.conversation_id=s.id) AND NOT EXISTS(SELECT 1 FROM source_edits e WHERE e.conversation_id=s.id) AND NOT EXISTS(SELECT 1 FROM deliveries d WHERE d.conversation_id=s.id) AND NOT EXISTS(SELECT 1 FROM interactions i WHERE i.conversation_id=s.id) LIMIT 100)",
        [metadata],
      );
      await c.query(
        "DELETE FROM admin_conversations WHERE id IN (SELECT s.id FROM admin_conversations s WHERE s.last_interaction_at<=$1 AND NOT EXISTS(SELECT 1 FROM admin_queries j WHERE j.conversation_id=s.id) AND NOT EXISTS(SELECT 1 FROM deliveries d WHERE d.admin_conversation_id=s.id) LIMIT 100)",
        [metadata],
      );
      const removable = (
        await c.query(
          `SELECT s.id FROM sources s WHERE s.state IN ('revoked','expired') AND s.published_at<=$1
        AND EXISTS(SELECT 1 FROM jobs j WHERE j.source_id=s.id AND j.kind='cleanup' AND j.state='completed')
        AND NOT EXISTS(SELECT 1 FROM publications p WHERE p.source_id=s.id AND p.removed_at IS NULL)
        AND NOT EXISTS(SELECT 1 FROM orphan_assets o WHERE o.source_id=s.id AND o.removed_at IS NULL)
        AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.source_id=s.id AND j.state NOT IN ('completed','failed','cancelled'))
        AND NOT EXISTS(SELECT 1 FROM search_jobs j WHERE j.excluded_source_id=s.id)
        AND NOT EXISTS(SELECT 1 FROM source_edits e WHERE e.source_id=s.id)
        ORDER BY s.group_id,s.id LIMIT 50 FOR UPDATE`,
          [metadata],
        )
      ).rows.map((r) => r.id);
      if (removable.length) {
        await c.query(
          "DELETE FROM job_wakes WHERE job_id IN (SELECT id FROM jobs WHERE source_id=ANY($1::uuid[]))",
          [removable],
        );
        await c.query("DELETE FROM jobs WHERE source_id=ANY($1::uuid[])", [
          removable,
        ]);
        await c.query(
          "DELETE FROM orphan_assets WHERE source_id=ANY($1::uuid[])",
          [removable],
        );
        await c.query(
          "DELETE FROM publications WHERE source_id=ANY($1::uuid[])",
          [removable],
        );
        await c.query(
          "DELETE FROM source_indexes WHERE source_id=ANY($1::uuid[])",
          [removable],
        );
        await c.query(
          "DELETE FROM embedding_documents WHERE source_id=ANY($1::uuid[])",
          [removable],
        );
        await c.query(
          "DELETE FROM source_relations WHERE source_id=ANY($1::uuid[]) OR related_source_id=ANY($1::uuid[]) OR evidence_source_id=ANY($1::uuid[])",
          [removable],
        );
        await c.query("DELETE FROM sources WHERE id=ANY($1::uuid[])", [
          removable,
        ]);
      }
    });
  }
}
