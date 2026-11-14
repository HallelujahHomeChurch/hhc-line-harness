import { isAssetId } from "./asset-id.ts";
import {
  legacySnapshotSchema,
  legacySnapshot,
  restoreLegacy,
} from "./legacy.ts";
import { auditEvent, auditEventSchema } from "../audit/outbox.ts";
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { Store } from "../persistence/store.ts";
import { invalidate } from "./lifecycle.ts";
const number = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,18})$/)
  .refine((v) => BigInt(v) <= 9223372036854775807n);
const positive = number.refine((v) => BigInt(v) > 0n),
  id = z.uuid(),
  date = z.iso.datetime();
const groupSchema = z
  .object({
    id,
    state: z.enum([
      "pending",
      "active",
      "paused",
      "left",
      "deleting",
      "deleted",
    ]),
    revision: positive,
    collection_id: z.string().refine(isAssetId).nullable(),
    acl_revision: positive.nullable(),
    binding_generation: positive.nullable(),
    sharing_enabled: z.boolean(),
  })
  .strict();
const sourceSchema = z
  .object({
    id,
    group_id: id,
    revision: positive,
    description_revision: positive,
    asset_source_revision: id,
    expires_at: date,
    state: z.enum(["queued", "ready", "held", "revoked", "expired", "failed"]),
  })
  .strict();
const publicationSchema = z
  .object({
    id,
    source_id: id,
    collection_id: z.string().refine(isAssetId),
    item_id: z.string().refine(isAssetId).nullable(),
    source_revision: positive,
    group_revision: positive,
    acl_revision: positive,
    binding_generation: positive,
    state: z.enum(["intent", "staged", "approved", "active", "revoked"]),
    created_at: date,
    removed_at: date.nullable(),
  })
  .strict();
const journalSchema = z
  .object({
    version: z.literal(2),
    legacy: legacySnapshotSchema,
    installationId: id,
    generation: positive,
    asOf: date,
    ingestFloor: date,
    groups: z.array(groupSchema).max(100000),
    sources: z.array(sourceSchema).max(100000),
    publications: z.array(publicationSchema).max(100000),
    tombstones: z
      .array(
        z
          .object({
            source_key: z.string().regex(/^[0-9a-f]{64}$/),
            revoked_at: date,
            expires_at: date,
          })
          .strict(),
      )
      .max(100000),
    audit: z
      .array(
        z
          .object({
            event: auditEventSchema,
            state: z.enum(["pending", "delivered", "dead_letter"]),
            deliveredAt: date.nullable(),
          })
          .strict(),
      )
      .max(100000),
    alerts: z
      .array(
        z
          .object({
            id,
            provider: z.enum(["openai", "azure"]),
            month: z.string().regex(/^\d{4}-\d{2}$/),
            kind: z.enum(["azure_threshold", "reservation_overrun"]),
            created_at: date,
            state: z.enum(["pending", "delivered"]),
            acknowledged_at: date.nullable(),
          })
          .strict(),
      )
      .max(10000),
    months: z
      .array(
        z
          .object({
            provider: z.enum(["openai", "azure"]),
            month: z.string().regex(/^\d{4}-\d{2}$/),
            charged_micros: number,
            reserved_micros: number,
          })
          .strict(),
      )
      .max(240),
  })
  .strict();
export interface SignedJournal {
  payload: string;
  signature: string;
}
export class Recovery {
  readonly store: Store;
  private readonly key: Buffer;
  constructor(store: Store, key: string) {
    if (!/^[0-9a-f]{64}$/.test(key)) throw new Error("invalid_journal_key");
    this.store = store;
    this.key = Buffer.from(key, "hex");
  }
  private sign(payload: string) {
    return createHmac("sha256", this.key).update(payload).digest("hex");
  }
  async quiesce() {
    const r = await this.store.pool.query(
      "UPDATE runtime_state SET mode='closed' WHERE mode IN ('open','closed')",
    );
    if (r.rowCount !== 1) throw new Error("restore_in_progress");
  }
  async exportJournal(): Promise<SignedJournal> {
    return this.store.transaction(async (c) => {
      const runtime = (await c.query("SELECT * FROM runtime_state FOR UPDATE"))
        .rows[0];
      if (runtime.mode !== "closed")
        throw new Error("journal_requires_quiescence");
      const groups = (
        await c.query(
          "SELECT id,state,revision,collection_id,acl_revision,binding_generation,sharing_enabled FROM groups ORDER BY id",
        )
      ).rows;
      const sources = (
        await c.query(
          "SELECT id,group_id,revision,description_revision,asset_source_revision,expires_at,state FROM sources ORDER BY id",
        )
      ).rows;
      const publications = (
        await c.query(
          "SELECT id,source_id,collection_id,item_id,source_revision,group_revision,acl_revision,binding_generation,state,created_at,removed_at FROM publications ORDER BY id",
        )
      ).rows;
      const tombstones = (
        await c.query(
          "SELECT source_key,revoked_at,expires_at FROM source_tombstones ORDER BY source_key",
        )
      ).rows;
      const months = (
        await c.query(
          "SELECT provider,month,charged_micros,reserved_micros FROM model_months ORDER BY provider,month",
        )
      ).rows;
      const audit = (
        await c.query("SELECT * FROM audit_outbox ORDER BY occurred_at,id")
      ).rows.map((r) => ({
        event: r.payload ? auditEventSchema.parse(r.payload) : auditEvent(r),
        state: r.state,
        deliveredAt: r.delivered_at,
      }));
      const alerts = (
        await c.query(
          "SELECT id,provider,month,kind,created_at,state,acknowledged_at FROM model_budget_alerts ORDER BY id",
        )
      ).rows;
      const payload = JSON.stringify({
        version: 2,
        legacy: await legacySnapshot(c),
        installationId: runtime.installation_id,
        generation: runtime.generation,
        asOf: this.store.now().toISOString(),
        ingestFloor: runtime.ingest_floor.toISOString(),
        groups,
        sources,
        publications,
        tombstones,
        months,
        audit,
        alerts,
      });
      if (Buffer.byteLength(payload) > 64 * 1024 * 1024)
        throw new Error("journal_limit");
      journalSchema.parse(JSON.parse(payload));
      return { payload, signature: this.sign(payload) };
    });
  }
  async restore(
    envelope: SignedJournal,
    minimumAsOf: Date,
    newGeneration: string,
  ) {
    // Restore is an operator action: invalid evidence must never leave intake open.
    await this.store.pool.query(
      "UPDATE runtime_state SET mode='closed' WHERE mode='open'",
    );
    if (
      typeof envelope.payload !== "string" ||
      Buffer.byteLength(envelope.payload) > 64 * 1024 * 1024 ||
      !/^([0-9a-f]{64})$/.test(envelope.signature) ||
      !timingSafeEqual(
        Buffer.from(envelope.signature, "hex"),
        Buffer.from(this.sign(envelope.payload), "hex"),
      )
    )
      throw new Error("invalid_journal");
    const journal = journalSchema.parse(JSON.parse(envelope.payload));
    positive.parse(newGeneration);
    if (
      !Number.isFinite(minimumAsOf.getTime()) ||
      new Date(journal.asOf) < minimumAsOf ||
      new Date(journal.asOf) > this.store.now() ||
      BigInt(newGeneration) <= BigInt(journal.generation)
    )
      throw new Error("stale_journal");
    for (const rows of [journal.groups, journal.sources, journal.publications])
      if (new Set(rows.map((r) => r.id)).size !== rows.length)
        throw new Error("duplicate_journal_identity");
    const groups = new Map(journal.groups.map((g) => [g.id, g])),
      sources = new Map(journal.sources.map((s) => [s.id, s]));
    // Commit closed admission before reconciliation; a failed replay stays unavailable.
    await this.store.transaction(async (c) => {
      const r = (await c.query("SELECT * FROM runtime_state FOR UPDATE"))
        .rows[0];
      const previous = (
        await c.query("SELECT * FROM recovery_records WHERE generation=$1", [
          newGeneration,
        ])
      ).rows[0];
      if (
        r.mode === "restoring" &&
        r.generation === newGeneration &&
        previous?.journal_signature === envelope.signature &&
        !previous.reconciled_at
      )
        return;
      if (
        r.installation_id !== journal.installationId ||
        BigInt(newGeneration) <= BigInt(r.generation)
      )
        throw new Error("restore_generation_conflict");
      await c.query(
        "UPDATE runtime_state SET mode='restoring',generation=$1,ingest_floor=GREATEST(ingest_floor,$2),floor_enforced=true",
        [newGeneration, this.store.now()],
      );
      await c.query(
        "INSERT INTO recovery_records(generation,journal_signature,journal_as_of,restored_at) VALUES($1,$2,$3,$4)",
        [newGeneration, envelope.signature, journal.asOf, this.store.now()],
      );
    });
    await this.store.transaction(async (c) => {
      const runtime = (await c.query("SELECT * FROM runtime_state FOR UPDATE"))
        .rows[0];
      if (runtime.mode !== "restoring" || runtime.generation !== newGeneration)
        throw new Error("restore_generation_conflict");
      // A backup cannot discharge cleanup obligations for identities it never contained.
      // Keep the exact signed journal as the recovery handoff; admission stays fenced.
      const sourceIDs = new Set(
        (await c.query("SELECT id FROM sources")).rows.map((r) => r.id),
      );
      const publicationIDs = new Set(
        (await c.query("SELECT id FROM publications")).rows.map((r) => r.id),
      );
      if (
        journal.sources.some((s) => !sourceIDs.has(s.id)) ||
        journal.publications.some((p) => !publicationIDs.has(p.id))
      )
        throw new Error("journal_identities_missing_from_backup");
      const existingGroups = (
        await c.query("SELECT * FROM groups ORDER BY id FOR UPDATE")
      ).rows;
      for (const g of existingGroups) {
        const current = groups.get(g.id);
        const state =
          !current ||
          ["deleting", "deleted"].includes(current.state) ||
          ["deleting", "deleted"].includes(g.state)
            ? "deleted"
            : current.state === "left"
              ? "left"
              : "paused";
        await c.query(
          "UPDATE groups SET state=$2,revision=GREATEST(revision,$3::bigint)+1,collection_id=$4,acl_revision=$5,binding_generation=$6,sharing_enabled=$7 WHERE id=$1",
          [
            g.id,
            state,
            current?.revision ?? g.revision,
            current?.collection_id ?? g.collection_id,
            current?.acl_revision ?? g.acl_revision,
            current?.binding_generation ?? g.binding_generation,
            current?.sharing_enabled ?? false,
          ],
        );
      }
      const oldSources = (
        await c.query("SELECT * FROM sources ORDER BY group_id,id FOR UPDATE")
      ).rows;
      for (const s of oldSources) {
        const current = sources.get(s.id),
          group = groups.get(s.group_id);
        const preserve =
          current?.state === "ready" &&
          s.state === "ready" &&
          current.group_id === s.group_id &&
          current.revision === s.revision &&
          current.description_revision === s.description_revision &&
          current.asset_source_revision === s.asset_source_revision &&
          current.expires_at === s.expires_at.toISOString() &&
          s.expires_at > this.store.now() &&
          group &&
          !["deleting", "deleted"].includes(group.state);
        if (!preserve)
          await invalidate(
            c,
            s.id,
            this.store.now(),
            s.expires_at <= this.store.now() ? "expired" : "revoked",
          );
      }
      // Restore only completed, exact identities. Unknown publication outcomes stay denied for reconciliation.
      const livePublications = new Map(
        journal.publications.map((p) => [p.id, p]),
      );
      for (const p of (await c.query("SELECT * FROM publications FOR UPDATE"))
        .rows) {
        const current = livePublications.get(p.id);
        const s = (
          await c.query("SELECT state,revision FROM sources WHERE id=$1", [
            p.source_id,
          ])
        ).rows[0];
        const matching =
          current &&
          current.state === "active" &&
          s?.state === "ready" &&
          current.source_id === p.source_id &&
          current.collection_id === p.collection_id &&
          current.binding_generation === p.binding_generation &&
          current.source_revision === s.revision &&
          current.item_id !== null &&
          (p.item_id === null || current.item_id === p.item_id);
        if (matching)
          await c.query(
            "UPDATE publications SET state='active',item_id=$2,acl_revision=$3,group_revision=$4 WHERE id=$1 AND state<>'revoked'",
            [
              p.id,
              current.item_id,
              current.acl_revision,
              current.group_revision,
            ],
          );
        else
          await c.query("UPDATE publications SET state='revoked' WHERE id=$1", [
            p.id,
          ]);
      }
      for (const t of journal.tombstones)
        await c.query(
          "INSERT INTO source_tombstones(source_key,revoked_at,expires_at) VALUES($1,$2,$3) ON CONFLICT(source_key) DO UPDATE SET revoked_at=LEAST(source_tombstones.revoked_at,EXCLUDED.revoked_at),expires_at=GREATEST(source_tombstones.expires_at,EXCLUDED.expires_at)",
          [t.source_key, t.revoked_at, t.expires_at],
        );
      for (const m of journal.months)
        await c.query(
          "INSERT INTO model_months(provider,month,charged_micros,reserved_micros) VALUES($1,$2,$3,$4) ON CONFLICT(provider,month) DO UPDATE SET charged_micros=GREATEST(model_months.charged_micros,EXCLUDED.charged_micros),reserved_micros=GREATEST(model_months.reserved_micros,EXCLUDED.reserved_micros)",
          [m.provider, m.month, m.charged_micros, m.reserved_micros],
        );
      for (const entry of journal.audit) {
        const e = entry.event,
          existing = (
            await c.query("SELECT * FROM audit_outbox WHERE id=$1 FOR UPDATE", [
              e.eventId,
            ])
          ).rows[0];
        if (
          existing &&
          JSON.stringify(
            existing.payload
              ? auditEventSchema.parse(existing.payload)
              : auditEvent(existing),
          ) !== JSON.stringify(e)
        )
          throw new Error("audit_restore_conflict");
        await c.query(
          "INSERT INTO audit_outbox(id,action,actor_user_id,target_id,target_revision,occurred_at,payload,state,delivered_at,next_attempt_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(id) DO UPDATE SET state=CASE WHEN audit_outbox.state='delivered' THEN 'delivered' ELSE EXCLUDED.state END,delivered_at=COALESCE(audit_outbox.delivered_at,EXCLUDED.delivered_at),lease_until=NULL,fence=audit_outbox.fence+1,next_attempt_at=EXCLUDED.next_attempt_at",
          [
            e.eventId,
            e.action,
            e.actorType === "anonymous" ? null : e.actorId,
            e.resourceId,
            e.metadata.revision,
            e.occurredAt,
            e,
            entry.state,
            entry.deliveredAt,
            this.store.now(),
          ],
        );
      }
      for (const a of journal.alerts) {
        const existing = (
          await c.query(
            "SELECT id FROM model_budget_alerts WHERE provider=$1 AND month=$2 AND kind=$3",
            [a.provider, a.month, a.kind],
          )
        ).rows[0];
        if (existing && existing.id !== a.id)
          throw new Error("alert_restore_conflict");
        await c.query(
          "INSERT INTO model_budget_alerts(id,provider,month,kind,created_at,state,acknowledged_at,next_attempt_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(id) DO UPDATE SET state=CASE WHEN model_budget_alerts.state='delivered' THEN 'delivered' ELSE EXCLUDED.state END,acknowledged_at=COALESCE(model_budget_alerts.acknowledged_at,EXCLUDED.acknowledged_at),fence=model_budget_alerts.fence+1,lease_until=NULL,next_attempt_at=EXCLUDED.next_attempt_at",
          [
            a.id,
            a.provider,
            a.month,
            a.kind,
            a.created_at,
            a.state,
            a.acknowledged_at,
            this.store.now(),
          ],
        );
      }
      await restoreLegacy(c, journal.legacy, newGeneration, this.store.now());
      await c.query(
        "UPDATE model_runs SET state='cancelled',actor_id=NULL,source_ids='{}'",
      );
      await c.query(
        "UPDATE model_calls SET settlement_fenced=true,state=CASE WHEN state='started' THEN 'unknown' ELSE state END",
      );
      await c.query("DELETE FROM model_steps");
      await c.query("DELETE FROM agent_tools");
      await c.query("DELETE FROM embedding_documents");
      await c.query(
        "UPDATE jobs SET state='cancelled',fence=fence+1,lease_until=NULL WHERE kind NOT IN ('cleanup','unpublish') AND state NOT IN ('completed','failed')",
      );
      await c.query(
        "UPDATE jobs SET runtime_generation=$1,source_revision=s.revision,state='queued',fence=fence+1,lease_until=NULL,available_at=$2 FROM sources s WHERE jobs.source_id=s.id AND jobs.kind IN ('cleanup','unpublish') AND jobs.state<>'completed'",
        [newGeneration, this.store.now()],
      );
      await c.query(
        "UPDATE deliveries SET state=CASE WHEN state='attempt_reserved' THEN 'unknown' WHEN state='pending' THEN 'cancelled' ELSE state END,token_ciphertext=NULL,body=NULL,actions=NULL",
      );
      await c.query(
        "UPDATE interactions SET state='failed',fence=fence+1,lease_until=NULL,payload_ciphertext=NULL WHERE state IN ('queued','running')",
      );
      await c.query(
        "UPDATE conversations SET generation=generation+1,checkpoint_ciphertext=NULL,checkpoint_sources='{}'",
      );
      await c.query(
        "UPDATE admin_conversations SET generation=generation+1,last_result_id=NULL",
      );
      await c.query(
        "UPDATE search_jobs SET state='cancelled',fence=fence+1,request_ciphertext=NULL,result_ciphertext=NULL,source_ids='{}',lease_until=NULL",
      );
      await c.query(
        "UPDATE admin_queries SET state='cancelled',fence=fence+1,query_ciphertext=NULL,result_ciphertext=NULL,lease_until=NULL",
      );
      await c.query(
        "UPDATE source_edits SET state='cancelled',text_ciphertext=NULL WHERE state='preview'",
      );
      await c.query(
        "UPDATE setup_intents SET state='unknown',confirmation_hash=NULL,confirmation_expires_at=NULL WHERE state<>'active'",
      );
      await c.query("UPDATE runtime_state SET mode='closed'");
      await c.query(
        "UPDATE recovery_records SET reconciled_at=$2 WHERE generation=$1",
        [newGeneration, this.store.now()],
      );
    });
  }
  async admit(generation: string, signature: string) {
    positive.parse(generation);
    await this.store.transaction(async (c) => {
      const r = (await c.query("SELECT * FROM runtime_state FOR UPDATE"))
        .rows[0];
      const proof = (
        await c.query(
          "SELECT * FROM recovery_records WHERE generation=$1 AND journal_signature=$2 FOR UPDATE",
          [generation, signature],
        )
      ).rows[0];
      if (
        r.mode !== "closed" ||
        r.generation !== generation ||
        !proof ||
        !proof.reconciled_at ||
        proof.admitted_at
      )
        throw new Error("restore_not_verified");
      await c.query("UPDATE runtime_state SET mode='open'");
      await c.query(
        "UPDATE recovery_records SET admitted_at=$2 WHERE generation=$1",
        [generation, this.store.now()],
      );
    });
  }
}
