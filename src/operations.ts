import type { Store } from "./persistence/store.ts";
export class Operations {
  readonly store: Store;
  constructor(store: Store) {
    this.store = store;
  }
  async snapshot() {
    const now = this.store.now();
    const jobs = (
      await this.store.pool.query(
        `SELECT
   count(*) FILTER(WHERE j.kind='download' AND j.state='completed')::int AS "originalCompleted",
   count(*) FILTER(WHERE j.kind='download' AND j.state='failed')::int AS "originalFailed",
   count(*) FILTER(WHERE j.kind='download' AND j.state IN ('queued','retry_wait','leased'))::int AS "originalPending",
   COALESCE(max(GREATEST(0,EXTRACT(EPOCH FROM ($2::timestamptz-j.created_at)))) FILTER(WHERE j.kind='download' AND j.state IN ('queued','retry_wait','leased')),0)::float8 AS "oldestDownloadSeconds",
   COALESCE(max(GREATEST(0,EXTRACT(EPOCH FROM ($2::timestamptz-j.created_at)))) FILTER(WHERE j.kind='index' AND j.state IN ('queued','retry_wait','leased')),0)::float8 AS "oldestIndexSeconds",
   count(*) FILTER(WHERE j.kind IN ('cleanup','unpublish') AND j.state NOT IN ('completed','cancelled'))::int AS "deletionBacklog",
   COALESCE(sum(j.lease_recoveries),0)::int AS "leaseRecoveries"
   FROM jobs j JOIN sources s ON s.id=j.source_id JOIN groups g ON g.id=s.group_id WHERE g.channel_id=$1`,
        [this.store.channelId, now],
      )
    ).rows[0];
    const replies = (
      await this.store.pool.query(
        `SELECT count(*) FILTER(WHERE state='unknown' OR state='attempt_reserved' AND expires_at<=$2)::int AS "replyUnknown",count(*) FILTER(WHERE state='expired' OR state='pending' AND expires_at<=$2)::int AS "replyExpired" FROM deliveries WHERE channel_id=$1`,
        [this.store.channelId, now],
      )
    ).rows[0];
    const audit = (
      await this.store.pool.query(
        `SELECT count(*) FILTER(WHERE state='pending')::int AS "auditPending",count(*) FILTER(WHERE state='dead_letter')::int AS "auditDeadLetter",COALESCE(max(GREATEST(0,EXTRACT(EPOCH FROM ($1::timestamptz-occurred_at)))) FILTER(WHERE state='pending'),0)::float8 AS "oldestAuditSeconds" FROM audit_outbox`,
        [now],
      )
    ).rows[0];
    const alerts = (
      await this.store.pool.query(
        "SELECT count(*) FILTER(WHERE state='pending')::int AS \"alertPending\" FROM model_budget_alerts",
      )
    ).rows[0];
    const costs = (
      await this.store.pool.query(
        'SELECT provider,month,charged_micros::text AS "chargedMicros",reserved_micros::text AS "reservedMicros" FROM model_months ORDER BY month DESC,provider LIMIT 24',
      )
    ).rows;
    const missing = (
      await this.store.pool.query(
        "SELECT count(*)::int AS n FROM sources s JOIN groups g ON g.id=s.group_id WHERE g.channel_id=$1 AND s.state='failed' AND s.expires_at>$2",
        [this.store.channelId, now],
      )
    ).rows[0].n;
    return {
      ...jobs,
      ...replies,
      ...audit,
      ...alerts,
      knownMissing: missing,
      costs,
    };
  }
}
export interface BudgetAlert {
  event: "line_harness_budget_alert";
  alertId: string;
  provider: string;
  month: string;
  kind: string;
}
export class BudgetAlerts {
  readonly store: Store;
  readonly emit: (event: BudgetAlert) => Promise<void>;
  constructor(store: Store, emit: (event: BudgetAlert) => Promise<void>) {
    this.store = store;
    this.emit = emit;
  }
  async processOne(): Promise<boolean> {
    const row = await this.store.transaction(async (c) => {
      const r = (
        await c.query(
          "SELECT id FROM model_budget_alerts WHERE state='pending' AND next_attempt_at<=$1 AND (lease_until IS NULL OR lease_until<=$1) ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1",
          [this.store.now()],
        )
      ).rows[0];
      if (!r) return;
      return (
        await c.query(
          "UPDATE model_budget_alerts SET attempts=attempts+1,fence=fence+1,lease_until=$2 WHERE id=$1 RETURNING *",
          [r.id, new Date(this.store.now().getTime() + 10000)],
        )
      ).rows[0];
    });
    if (!row) return false;
    if (
      !["openai", "azure"].includes(row.provider) ||
      !/^\d{4}-\d{2}$/.test(row.month) ||
      !["azure_threshold", "reservation_overrun"].includes(row.kind)
    )
      throw new Error("invalid_budget_alert");
    await this.emit({
      event: "line_harness_budget_alert",
      alertId: row.id,
      provider: row.provider,
      month: row.month,
      kind: row.kind,
    });
    // Export is not notification receipt: retry until an operator confirms Monitor delivery.
    await this.store.pool.query(
      "UPDATE model_budget_alerts SET lease_until=NULL,next_attempt_at=$3 WHERE id=$1 AND fence=$2 AND state='pending'",
      [row.id, row.fence, new Date(this.store.now().getTime() + 3600000)],
    );
    return true;
  }
  async acknowledge(id: string, confirmation: string) {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        id,
      ) ||
      confirmation !== "azure-monitor-confirmed"
    )
      throw new Error("invalid_alert_acknowledgement");
    const r = await this.store.pool.query(
      "UPDATE model_budget_alerts SET state='delivered',acknowledged_at=$2,lease_until=NULL,fence=fence+1 WHERE id=$1 AND state='pending'",
      [id, this.store.now()],
    );
    if (r.rowCount !== 1) throw new Error("alert_acknowledgement_conflict");
  }
}
