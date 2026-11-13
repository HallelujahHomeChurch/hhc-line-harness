import { isAssetId } from "./asset-id.ts";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { PoolClient } from "pg";
import type { Store } from "../persistence/store.ts";
import type { LineEvent } from "./events.ts";
const proof = z.string().regex(/^[0-9a-f]{64}$/);
const opaque = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[^\x00-\x1f\x7f]+$/);
const entrySchema = z
  .object({
    id: z.uuid(),
    channelId: opaque,
    profile: opaque,
    groupId: z.string().regex(/^C[0-9a-f]{32}$/),
    messageId: opaque,
    sourceKey: opaque,
    assetId: z.string().refine(isAssetId).nullable(),
    collectionId: z.string().refine(isAssetId).nullable(),
    itemId: z.string().refine(isAssetId).nullable(),
    publishedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    policyVersion: opaque,
    revoked: z.boolean(),
    cleanupOwner: opaque,
    ownerAcceptance: proof,
    publications: z
      .array(
        z
          .object({
            kind: z.enum(["asset", "graph", "catalog", "manual"]),
            handle: opaque.nullable(),
            outcome: z.enum(["present", "unknown", "absent"]),
          })
          .strict(),
      )
      .max(20),
  })
  .strict()
  .refine(
    (e) =>
      Date.parse(e.expiresAt) >= Date.parse(e.publishedAt) &&
      (e.itemId === null || e.collectionId !== null) &&
      e.publications.every((p) => p.outcome !== "present" || p.handle !== null),
  );
const manifestSchema = z
  .object({
    version: z.literal(1),
    channelId: opaque,
    entries: z.array(entrySchema).max(10000),
  })
  .strict();
const resolutionSchema = z
  .object({
    outcome: z.enum(["present", "absent"]),
    handle: opaque.nullable(),
    evidence: proof,
  })
  .strict()
  .refine((r) =>
    r.outcome === "present" ? r.handle !== null : r.handle === null,
  );
const activationSchema = z
  .object({
    consumerAcceptance: proof,
    intentsCancelled: proof,
    externalEffectsReconciled: proof,
    compatibleRollback: proof,
  })
  .strict();
export const legacySnapshotSchema = z
  .object({
    handoffs: z
      .array(z.object({ channel_id: opaque, manifest_digest: proof }).strict())
      .max(100),
    sources: z
      .array(
        z
          .object({
            manifest: entrySchema,
            state: z.enum(["active", "revoked", "expired"]),
            revision: z.string().regex(/^[1-9][0-9]{0,18}$/),
            group_blocked: z.boolean(),
            cleanup_state: z.enum(["not_required", "pending", "completed"]),
            reconciliations: z.record(
              z.string().regex(/^\d+$/),
              resolutionSchema,
            ),
            cleanup_receipt: proof.nullable(),
          })
          .strict(),
      )
      .max(100000),
  })
  .strict();
async function deny(c: PoolClient, id: string, state: "revoked" | "expired") {
  await c.query(
    "UPDATE legacy_sources SET state=$2,revision=revision+1,cleanup_state='pending',cleanup_receipt=NULL WHERE id=$1 AND state='active'",
    [id, state],
  );
}
export async function applyLegacyLifecycle(
  c: PoolClient,
  channel: string,
  event: LineEvent,
) {
  if (event.scope !== "group") return;
  if (event.type === "unsend" && event.unsentMessageId) {
    const rows = (
      await c.query(
        "SELECT id FROM legacy_sources WHERE channel_id=$1 AND manifest->>'groupId'=$2 AND manifest->>'messageId'=$3 ORDER BY id FOR UPDATE",
        [channel, event.scopeId, event.unsentMessageId],
      )
    ).rows;
    for (const r of rows) await deny(c, r.id, "revoked");
  } else if (event.type === "leave" || event.type === "memberLeft") {
    // Owner must recheck membership/control; no automatic legacy resumption.
    await c.query(
      "UPDATE legacy_sources SET group_blocked=true,revision=revision+1 WHERE channel_id=$1 AND manifest->>'groupId'=$2 AND NOT group_blocked",
      [channel, event.scopeId],
    );
  }
}
export async function expireLegacy(c: PoolClient, now: Date) {
  const rows = (
    await c.query(
      "SELECT id FROM legacy_sources WHERE state='active' AND (manifest->>'expiresAt')::timestamptz<=$1 ORDER BY id LIMIT 100 FOR UPDATE",
      [now],
    )
  ).rows;
  for (const r of rows) await deny(c, r.id, "expired");
}
export async function legacySnapshot(c: PoolClient) {
  return legacySnapshotSchema.parse({
    handoffs: (
      await c.query(
        "SELECT channel_id,manifest_digest FROM legacy_handoffs ORDER BY channel_id",
      )
    ).rows,
    sources: (
      await c.query(
        "SELECT manifest,state,revision,group_blocked,cleanup_state,reconciliations,cleanup_receipt FROM legacy_sources ORDER BY id",
      )
    ).rows,
  });
}
export async function restoreLegacy(
  c: PoolClient,
  snapshot: z.infer<typeof legacySnapshotSchema>,
  generation: string,
  now: Date,
) {
  // All old writer/consumer attestations expire across a restore.
  await c.query(
    "UPDATE legacy_handoffs SET state='prepared',generation=$1,evidence='{}'",
    [generation],
  );
  for (const h of snapshot.handoffs)
    await c.query(
      "INSERT INTO legacy_handoffs(channel_id,manifest_digest,generation) VALUES($1,$2,$3) ON CONFLICT(channel_id) DO UPDATE SET manifest_digest=EXCLUDED.manifest_digest,state='prepared',generation=EXCLUDED.generation,evidence='{}'",
      [h.channel_id, h.manifest_digest, generation],
    );
  const current = (
    await c.query("SELECT id FROM legacy_sources ORDER BY id FOR UPDATE")
  ).rows;
  const ids = new Set(snapshot.sources.map((s) => s.manifest.id));
  for (const r of current) if (!ids.has(r.id)) await deny(c, r.id, "revoked");
  for (const s of snapshot.sources) {
    const e = s.manifest;
    await c.query(
      "INSERT INTO legacy_sources(id,channel_id,manifest,state,revision,group_blocked,cleanup_state,reconciliations,cleanup_receipt) VALUES($1,$2,$3,$4,$5,true,$6,$7,$8) ON CONFLICT(id) DO UPDATE SET manifest=EXCLUDED.manifest,state=CASE WHEN legacy_sources.state<>'active' THEN legacy_sources.state ELSE EXCLUDED.state END,revision=GREATEST(legacy_sources.revision,EXCLUDED.revision)+1,group_blocked=true,cleanup_state=CASE WHEN legacy_sources.state<>'active' AND EXCLUDED.state='active' THEN legacy_sources.cleanup_state ELSE EXCLUDED.cleanup_state END,reconciliations=EXCLUDED.reconciliations,cleanup_receipt=CASE WHEN legacy_sources.state<>'active' AND EXCLUDED.state='active' THEN legacy_sources.cleanup_receipt ELSE EXCLUDED.cleanup_receipt END",
      [
        e.id,
        e.channelId,
        e,
        s.state,
        s.revision,
        s.cleanup_state,
        s.reconciliations,
        s.cleanup_receipt,
      ],
    );
  }
  await expireLegacy(c, now);
}
export class LegacyHandoff {
  readonly store: Store;
  constructor(store: Store) {
    this.store = store;
  }
  async import(input: unknown) {
    const manifest = manifestSchema.parse(input);
    if (
      manifest.channelId !== this.store.channelId ||
      manifest.entries.some((e) => e.channelId !== manifest.channelId) ||
      new Set(manifest.entries.map((e) => e.id)).size !==
        manifest.entries.length
    )
      throw new Error("invalid_legacy_manifest");
    const digest = createHash("sha256")
      .update(JSON.stringify(manifest))
      .digest("hex");
    return this.store.transaction(async (c) => {
      const runtime = (await c.query("SELECT * FROM runtime_state FOR UPDATE"))
        .rows[0];
      if (runtime.mode !== "closed") throw new Error("handoff_requires_closed");
      const existing = (
        await c.query(
          "SELECT manifest_digest FROM legacy_handoffs WHERE channel_id=$1",
          [manifest.channelId],
        )
      ).rows[0];
      if (existing) {
        if (existing.manifest_digest !== digest)
          throw new Error("immutable_legacy_manifest");
        return digest;
      }
      await c.query(
        "INSERT INTO legacy_handoffs(channel_id,manifest_digest,generation) VALUES($1,$2,$3)",
        [manifest.channelId, digest, runtime.generation],
      );
      for (const e of manifest.entries) {
        const tombstone = (
          await c.query("SELECT 1 FROM source_tombstones WHERE source_key=$1", [
            createHash("sha256")
              .update(JSON.stringify([e.channelId, e.groupId, e.messageId]))
              .digest("hex"),
          ])
        ).rowCount;
        const state =
          e.revoked || tombstone
            ? "revoked"
            : new Date(e.expiresAt) <= this.store.now()
              ? "expired"
              : "active";
        await c.query(
          "INSERT INTO legacy_sources(id,channel_id,manifest,state,cleanup_state) VALUES($1,$2,$3,$4,$5)",
          [
            e.id,
            e.channelId,
            e,
            state,
            state === "active" ? "not_required" : "pending",
          ],
        );
      }
      return digest;
    });
  }
  private async guard(c: PoolClient, digest: string, state: string) {
    proof.parse(digest);
    const runtime = (await c.query("SELECT * FROM runtime_state FOR UPDATE"))
      .rows[0];
    const h = (
      await c.query(
        "SELECT * FROM legacy_handoffs WHERE channel_id=$1 FOR UPDATE",
        [this.store.channelId],
      )
    ).rows[0];
    if (
      runtime.mode !== "closed" ||
      h?.manifest_digest !== digest ||
      h.state !== state ||
      h.generation !== runtime.generation
    )
      throw new Error("handoff_fenced");
  }
  async freeze(digest: string, writerStoppedEvidence: string) {
    proof.parse(writerStoppedEvidence);
    await this.store.transaction(async (c) => {
      await this.guard(c, digest, "prepared");
      await c.query(
        "UPDATE legacy_handoffs SET state='frozen',evidence=$2 WHERE channel_id=$1",
        [this.store.channelId, { writerStopped: writerStoppedEvidence }],
      );
    });
  }
  async activate(digest: string, input: unknown) {
    const evidence = activationSchema.parse(input);
    await this.store.transaction(async (c) => {
      await this.guard(c, digest, "frozen");
      const rows = (
        await c.query(
          "SELECT manifest,reconciliations FROM legacy_sources WHERE channel_id=$1",
          [this.store.channelId],
        )
      ).rows;
      if (
        rows.some((r) =>
          entrySchema
            .parse(r.manifest)
            .publications.some(
              (p, i) => p.outcome === "unknown" && !r.reconciliations[i],
            ),
        )
      )
        throw new Error("unknown_legacy_publication");
      await c.query(
        "UPDATE legacy_handoffs SET state='active',evidence=evidence || $2::jsonb WHERE channel_id=$1",
        [this.store.channelId, evidence],
      );
    });
  }
  async reconcile(id: string, index: number, input: unknown) {
    const resolution = resolutionSchema.parse(input);
    if (!Number.isInteger(index) || index < 0 || index >= 20)
      throw new Error("invalid_publication");
    await this.store.transaction(async (c) => {
      if (
        !(
          await c.query(
            "SELECT 1 FROM runtime_state WHERE mode<>'restoring' FOR SHARE",
          )
        ).rowCount
      )
        throw new Error("restore_in_progress");
      const row = (
        await c.query(
          "SELECT * FROM legacy_sources WHERE id=$1 AND channel_id=$2 FOR UPDATE",
          [id, this.store.channelId],
        )
      ).rows[0];
      if (!row || !entrySchema.parse(row.manifest).publications[index])
        throw new Error("unknown_legacy_source");
      if (row.reconciliations[index]) {
        const old = resolutionSchema.parse(row.reconciliations[index]);
        if (
          old.outcome !== resolution.outcome ||
          old.handle !== resolution.handle ||
          old.evidence !== resolution.evidence
        )
          throw new Error("reconciliation_conflict");
        return;
      }
      await c.query(
        "UPDATE legacy_sources SET reconciliations=reconciliations || $2::jsonb,revision=revision+1 WHERE id=$1",
        [id, { [index]: resolution }],
      );
    });
  }
  async deny(id: string) {
    await this.store.transaction(async (c) => {
      if (
        !(
          await c.query(
            "SELECT 1 FROM runtime_state WHERE mode<>'restoring' FOR SHARE",
          )
        ).rowCount
      )
        throw new Error("restore_in_progress");
      const row = await c.query(
        "SELECT id FROM legacy_sources WHERE id=$1 AND channel_id=$2 FOR UPDATE",
        [id, this.store.channelId],
      );
      if (!row.rowCount) throw new Error("unknown_legacy_source");
      await deny(c, id, "revoked");
    });
  }
  async pending() {
    return (
      await this.store.pool.query(
        "SELECT id,manifest,state,revision,group_blocked,reconciliations FROM legacy_sources WHERE channel_id=$1 AND cleanup_state='pending' ORDER BY id LIMIT 100",
        [this.store.channelId],
      )
    ).rows;
  }
  async acknowledge(id: string, revision: string, evidence: string) {
    proof.parse(evidence);
    await this.store.transaction(async (c) => {
      if (
        !(
          await c.query(
            "SELECT 1 FROM runtime_state WHERE mode<>'restoring' FOR SHARE",
          )
        ).rowCount
      )
        throw new Error("restore_in_progress");
      const row = (
        await c.query(
          "SELECT * FROM legacy_sources WHERE id=$1 AND channel_id=$2 FOR UPDATE",
          [id, this.store.channelId],
        )
      ).rows[0];
      if (
        !row ||
        row.revision !== revision ||
        row.cleanup_state !== "pending" ||
        entrySchema
          .parse(row.manifest)
          .publications.some(
            (p, i) => p.outcome === "unknown" && !row.reconciliations[i],
          )
      )
        throw new Error("legacy_cleanup_fenced");
      await c.query(
        "UPDATE legacy_sources SET cleanup_state='completed',cleanup_receipt=$2 WHERE id=$1",
        [id, evidence],
      );
    });
  }
}

export const retirementEvidenceSchema = z
  .object({
    featuresDecided: proof,
    consumersMigrated: proof,
    lifecycleOwnersAccepted: proof,
    outboxDrained: proof,
    restoreAccepted: proof,
    legacyCredentialsRejected: proof,
    legacySchedulersDisabled: proof,
    productionAccepted: proof,
    rollbackUntil: z.iso.datetime(),
  })
  .strict();
export async function retirementBlockers(
  store: Store,
  input: unknown,
): Promise<string[]> {
  const parsed = retirementEvidenceSchema.safeParse(input);
  const blockers: string[] = [];
  if (!parsed.success) blockers.push("missing_retirement_evidence");
  else if (new Date(parsed.data.rollbackUntil) > store.now())
    blockers.push("rollback_window_open");
  const h = (
    await store.pool.query(
      "SELECT state,generation FROM legacy_handoffs WHERE channel_id=$1",
      [store.channelId],
    )
  ).rows[0];
  const runtime = (
    await store.pool.query("SELECT generation FROM runtime_state")
  ).rows[0];
  if (!h || h.state !== "active" || h.generation !== runtime.generation)
    blockers.push("handoff_incomplete");
  const rows = (
    await store.pool.query(
      "SELECT manifest,cleanup_state,reconciliations FROM legacy_sources WHERE channel_id=$1",
      [store.channelId],
    )
  ).rows;
  if (rows.some((r) => r.cleanup_state === "pending"))
    blockers.push("cleanup_unconfirmed");
  if (
    rows.some((r) =>
      entrySchema
        .parse(r.manifest)
        .publications.some(
          (p, i) => p.outcome === "unknown" && !r.reconciliations[i],
        ),
    )
  )
    blockers.push("publication_unknown");
  return blockers;
}
