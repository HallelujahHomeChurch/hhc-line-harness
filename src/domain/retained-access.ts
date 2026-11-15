import { z } from "zod";
import { isAssetId } from "./asset-id.ts";
import type { Store } from "../persistence/store.ts";

const positive = z.string().regex(/^[1-9][0-9]{0,18}$/);
const assetId = z.string().refine(isAssetId);
const common = {
  id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  collectionId: assetId,
};
const batchSchema = z
  .object({
    version: z.literal(1),
    manifestDigest: z.string().regex(/^[0-9a-f]{64}$/),
    generation: positive,
    expectedRevision: positive.optional(),
    requests: z
      .array(
        z.discriminatedUnion("mode", [
          z
            .object({
              ...common,
              mode: z.literal("content"),
              sourceId: z.uuid(),
              assetId,
              itemId: assetId,
              publishedAt: z.iso.datetime(),
              expiresAt: z.iso.datetime(),
            })
            .strict(),
          z.object({ ...common, mode: z.literal("control") }).strict(),
        ]),
      )
      .min(1)
      .max(100),
  })
  .strict();
type State = "active" | "paused" | "revoked" | "expired";
interface Row {
  mode: string;
  generation: string;
  handoff_generation: string;
  handoff_state: string;
  manifest_digest: string;
  revision: string;
  manifest: Record<string, unknown> | null;
  state: string | null;
  group_blocked: boolean | null;
  collection_count: number;
  group_count: number;
  collection_blocked: boolean | null;
}
function unavailable(): never {
  throw Error("source_unavailable");
}

export class RetainedAccess {
  readonly store: Store;
  constructor(store: Store) {
    this.store = store;
  }
  async checkBatch(input: unknown) {
    const parsed = batchSchema.safeParse(input);
    if (!parsed.success) throw Error("invalid_source_request");
    const batch = parsed.data;
    if (new Set(batch.requests.map((r) => r.id)).size !== batch.requests.length)
      throw Error("invalid_source_request");
    // One statement gives every item the same lifecycle and runtime snapshot.
    const rows = (
      await this.store.pool.query<Row>(
        `
      SELECT r.mode,r.generation,h.generation AS handoff_generation,
       h.state AS handoff_state,h.manifest_digest,h.revision,
       s.manifest,s.state,s.group_blocked,
       g.collection_count,g.group_count,g.collection_blocked
      FROM jsonb_array_elements($1::jsonb) WITH ORDINALITY q(request,position)
      CROSS JOIN runtime_state r
      LEFT JOIN legacy_handoffs h ON h.channel_id=$2
      LEFT JOIN legacy_sources s ON q.request->>'mode'='content'
       AND s.channel_id=$2 AND s.id::text=q.request->>'sourceId'
      LEFT JOIN LATERAL (
       SELECT count(*)::int AS collection_count,
        count(DISTINCT manifest->>'groupId')::int AS group_count,
        bool_or(group_blocked) AS collection_blocked
       FROM legacy_sources WHERE channel_id=$2
        AND q.request->>'mode'='control'
        AND manifest->>'collectionId'=q.request->>'collectionId'
      ) g ON true ORDER BY q.position`,
        [JSON.stringify(batch.requests), this.store.channelId],
      )
    ).rows;
    if (rows.length !== batch.requests.length) unavailable();
    const now = this.store.now().getTime();
    const decisions = batch.requests.map((request, index) => {
      const row = rows[index]!;
      if (
        !["open", "closed"].includes(row.mode) ||
        row.generation !== batch.generation ||
        row.handoff_generation !== row.generation ||
        !["frozen", "active"].includes(row.handoff_state) ||
        row.manifest_digest !== batch.manifestDigest ||
        !positive.safeParse(row.revision).success ||
        (batch.expectedRevision !== undefined &&
          batch.expectedRevision !== row.revision)
      )
        unavailable();
      let state: State;
      if (request.mode === "control") {
        if (
          row.collection_count < 1 ||
          row.group_count !== 1 ||
          row.collection_blocked === null
        )
          unavailable();
        state = row.collection_blocked ? "paused" : "active";
      } else {
        const m = row.manifest;
        if (
          !m ||
          m.id !== request.sourceId ||
          [
            "assetId",
            "collectionId",
            "itemId",
            "publishedAt",
            "expiresAt",
          ].some((k) => m[k] !== request[k as keyof typeof request]) ||
          !["active", "revoked", "expired"].includes(row.state ?? "") ||
          row.group_blocked === null
        )
          unavailable();
        state =
          row.state === "revoked"
            ? "revoked"
            : row.state === "expired" || Date.parse(request.expiresAt) <= now
              ? "expired"
              : row.group_blocked
                ? "paused"
                : "active";
      }
      return { id: request.id, state };
    });
    return {
      version: 1 as const,
      generation: rows[0]!.generation,
      revision: rows[0]!.revision,
      decisions,
    };
  }
}
