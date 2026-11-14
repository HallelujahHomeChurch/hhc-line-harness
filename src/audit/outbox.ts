import { z } from "zod";
import type { Store } from "../persistence/store.ts";
import { DependencyError, ServiceClient } from "../providers/http.ts";
const uuid = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
const actor = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
export const auditActions = [
  "line.group.configure",
  "line.group.activate",
  "line.group.pause",
  "line.group.delete",
  "line.group.acl_revoke_requested",
  "line.group.acl_revoke",
  "line.source.description",
  "line.source.delete",
] as const;
const revision = z
  .string()
  .regex(/^[1-9][0-9]{0,18}$/)
  .refine((v) => BigInt(v) <= 9223372036854775807n);
export const auditEventSchema = z
  .object({
    schemaVersion: z.literal(1),
    eventId: uuid,
    occurredAt: z.iso.datetime(),
    requestId: z.string().regex(/^[0-9a-f]{32}$/),
    sourceService: z.literal("hhc-line-harness"),
    actorType: z.enum(["user", "anonymous"]),
    actorId: z.union([actor, z.literal("")]),
    action: z.enum(auditActions),
    category: z.literal("line"),
    resourceOwnerService: z.literal("hhc-line-harness"),
    resourceType: z.enum(["line_group", "line_source"]),
    resourceId: uuid,
    outcome: z.literal("success"),
    severity: z.literal("info"),
    metadataClassification: z.literal("internal"),
    retentionClass: z.literal("security"),
    metadata: z.union([
      z.object({ revision }).strict(),
      z
        .object({
          revision,
          actorKind: z.enum(["line_author", "website_admin"]),
        })
        .strict(),
    ]),
  })
  .strict()
  .refine((e) => {
    if (e.action.startsWith("line.group."))
      return (
        e.resourceType === "line_group" &&
        e.actorType === "user" &&
        actor.safeParse(e.actorId).success &&
        !("actorKind" in e.metadata)
      );
    return (
      e.resourceType === "line_source" &&
      "actorKind" in e.metadata &&
      (e.metadata.actorKind === "line_author"
        ? e.actorType === "anonymous" && e.actorId === ""
        : e.actorType === "user" && actor.safeParse(e.actorId).success)
    );
  });
export type AuditEvent = z.infer<typeof auditEventSchema>;
export function auditEvent(value: unknown): AuditEvent {
  const r = z
    .object({
      id: uuid,
      action: z.enum(auditActions),
      actor_user_id: actor.nullable(),
      target_id: uuid,
      target_revision: revision,
      occurred_at: z.date(),
    })
    .parse(value);
  return auditEventSchema.parse({
    schemaVersion: 1,
    eventId: r.id,
    occurredAt: r.occurred_at.toISOString(),
    requestId: r.id.replaceAll("-", ""),
    sourceService: "hhc-line-harness",
    actorType: r.actor_user_id === null ? "anonymous" : "user",
    actorId: r.actor_user_id ?? "",
    action: r.action,
    category: "line",
    resourceOwnerService: "hhc-line-harness",
    resourceType: r.action.startsWith("line.source.")
      ? "line_source"
      : "line_group",
    resourceId: r.target_id,
    outcome: "success",
    severity: "info",
    metadataClassification: "internal",
    retentionClass: "security",
    metadata: r.action.startsWith("line.source.")
      ? {
          revision: r.target_revision,
          actorKind: r.actor_user_id === null ? "line_author" : "website_admin",
        }
      : { revision: r.target_revision },
  });
}
export class AuditClient {
  readonly http: ServiceClient;
  constructor(origin: string, token: string, fetcher: typeof fetch = fetch) {
    if (!/^[0-9a-f]{64}$/.test(token)) throw new Error("invalid_audit_token");
    this.http = new ServiceClient(
      origin,
      { "X-HHC-Audit-Caller": "hhc-line-harness", "X-Audit-Token": token },
      fetcher,
    );
  }
  async append(event: AuditEvent) {
    const response = await this.http.json(
      "/priv/audit/events",
      "POST",
      auditEventSchema.parse(event),
    );
    if (response.status !== "accepted" && response.status !== "duplicate")
      throw new DependencyError();
  }
}
const delays = [30_000, 120_000, 300_000, 900_000, 3600_000, 6 * 3600_000];
export class AuditDispatcher {
  readonly store: Store;
  readonly append: (event: AuditEvent) => Promise<void>;
  constructor(store: Store, append: (event: AuditEvent) => Promise<void>) {
    this.store = store;
    this.append = append;
  }
  async processOne(): Promise<boolean> {
    const row = await this.store.transaction(async (c) => {
      // Audit facts remain deliverable while business intake is paused.
      const r = (
        await c.query(
          "SELECT * FROM audit_outbox WHERE state='pending' AND next_attempt_at<=$1 AND (lease_until IS NULL OR lease_until<=$1) ORDER BY occurred_at,id FOR UPDATE SKIP LOCKED LIMIT 1",
          [this.store.now()],
        )
      ).rows[0];
      if (!r) return;
      let payload: AuditEvent;
      try {
        payload = r.payload ? auditEventSchema.parse(r.payload) : auditEvent(r);
      } catch {
        await c.query(
          "UPDATE audit_outbox SET state='dead_letter',error_code='invalid_event' WHERE id=$1",
          [r.id],
        );
        return { invalid: true };
      }
      return (
        await c.query(
          "UPDATE audit_outbox SET payload=$2,fence=fence+1,attempts=attempts+1,lease_until=$3 WHERE id=$1 RETURNING *",
          [r.id, payload, new Date(this.store.now().getTime() + 10000)],
        )
      ).rows[0];
    });
    if (!row) return false;
    if (row.invalid) return true;
    let state = "delivered",
      code: string | null = null;
    try {
      await this.append(auditEventSchema.parse(row.payload));
    } catch (error) {
      const status = error instanceof DependencyError ? error.status : 0;
      state =
        [400, 403, 409, 413, 415, 422].includes(status) ||
        (row.attempts >= 20 && status !== 401 && status !== 404)
          ? "dead_letter"
          : "pending";
      code =
        status === 409
          ? "conflict"
          : state === "dead_letter"
            ? "rejected_or_exhausted"
            : "dependency_unavailable";
    }
    const delay = delays[Math.min(row.attempts - 1, delays.length - 1)]!;
    await this.store.pool.query(
      "UPDATE audit_outbox SET state=$3,error_code=$4,lease_until=NULL,delivered_at=CASE WHEN $3='delivered' THEN $5::timestamptz ELSE NULL END,next_attempt_at=$6 WHERE id=$1 AND fence=$2 AND state='pending'",
      [
        row.id,
        row.fence,
        state,
        code,
        this.store.now(),
        new Date(this.store.now().getTime() + delay),
      ],
    );
    return true;
  }
  async retry(id: string) {
    uuid.parse(id);
    // Operator retries the identical fact after resolving the receiver problem.
    const result = await this.store.pool.query(
      "UPDATE audit_outbox SET state='pending',attempts=0,error_code=NULL,next_attempt_at=$2,fence=fence+1,lease_until=NULL WHERE id=$1 AND state='dead_letter'",
      [id, this.store.now()],
    );
    if (result.rowCount !== 1) throw new Error("audit_retry_conflict");
  }
}
