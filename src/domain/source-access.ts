import type { Store } from "../persistence/store.ts";
import { object } from "./events.ts";
interface Decision {
  version: 1;
  state: "active" | "paused" | "revoked" | "expired";
  policyRevision: number;
  revocationRevision: number;
}
interface AccessRow {
  runtime_mode: string;
  asset_source_revision: string | null;
  published_at: Date | null;
  expires_at: Date | null;
  state: string | null;
  group_state: string | null;
  policy_revision: string;
  revocation_revision: string;
  collection_id: string | null;
  sharing_enabled: boolean;
  acl_revision: string;
  binding_generation: string;
  asset_id: string | null;
  asset_etag: string | null;
  revision: string;
  publication_id: string | null;
  publication_source_revision: string | null;
  publication_acl_revision: string | null;
  publication_binding_generation: string | null;
  publication_state: string;
  publication_item_id: string | null;
}
function parseRequest(input: unknown) {
  const r = object(input);
  const modes = [
    "original",
    "stage",
    "activate",
    "published",
    "control",
    "collection",
  ];
  if (
    r.version !== 1 ||
    !modes.includes(String(r.mode)) ||
    Object.keys(r).some(
      (k) =>
        ![
          "version",
          "mode",
          "source",
          "collectionId",
          "itemId",
          "publicationRevision",
          "aclRevision",
          "bindingGeneration",
        ].includes(k),
    )
  )
    throw new Error("invalid_source_request");
  let source: Record<string, unknown> | undefined;
  if (r.source !== undefined) {
    source = object(r.source);
    if (
      source.version !== 1 ||
      typeof source.ref !== "string" ||
      !/^[A-Za-z0-9_-]{12,128}$/.test(source.ref) ||
      typeof source.revision !== "string" ||
      !/^[A-Za-z0-9_-]{12,128}$/.test(source.revision) ||
      typeof source.publishedAt !== "string" ||
      typeof source.expiresAt !== "string" ||
      !Number.isFinite(Date.parse(source.publishedAt)) ||
      Date.parse(source.expiresAt) - Date.parse(source.publishedAt) !==
        90 * 86400000
    )
      throw new Error("invalid_source_request");
  }
  if (
    ["original", "stage", "activate", "published"].includes(String(r.mode)) &&
    !source
  )
    throw new Error("invalid_source_request");
  if (
    r.mode !== "original" &&
    (typeof r.collectionId !== "string" ||
      !Number.isSafeInteger(r.aclRevision) ||
      Number(r.aclRevision) <= 0 ||
      !Number.isSafeInteger(r.bindingGeneration) ||
      Number(r.bindingGeneration) <= 0)
  )
    throw new Error("invalid_source_request");
  return { r, source };
}
export class SourceAccess {
  readonly store: Store;
  constructor(store: Store) {
    this.store = store;
  }
  async check(input: unknown): Promise<Decision> {
    return (
      await this.checkBatch({
        version: 1,
        requests: [{ id: "0", request: input }],
      })
    ).decisions[0]!.decision;
  }
  async checkBatch(input: unknown) {
    const batch = object(input);
    if (
      batch.version !== 1 ||
      Object.keys(batch).some((k) => !["version", "requests"].includes(k)) ||
      !Array.isArray(batch.requests) ||
      batch.requests.length < 1 ||
      batch.requests.length > 100
    )
      throw new Error("invalid_source_request");
    const requests = batch.requests.map((value, i) => {
      const entry = object(value);
      if (
        entry.id !== String(i) ||
        Object.keys(entry).some((k) => !["id", "request"].includes(k))
      )
        throw new Error("invalid_source_request");
      return { id: String(i), ...parseRequest(entry.request) };
    });
    const { rows } = await this.store.pool.query<AccessRow>(
      `
    SELECT s.*,r.mode AS runtime_mode,g.state AS group_state,g.revision AS policy_revision,g.revocation_revision,g.collection_id,g.sharing_enabled,g.acl_revision,g.binding_generation,
      p.id AS publication_id,p.source_revision AS publication_source_revision,p.acl_revision AS publication_acl_revision,p.binding_generation AS publication_binding_generation,p.state AS publication_state,p.item_id AS publication_item_id
    FROM jsonb_array_elements($1::jsonb) WITH ORDINALITY q(request,ordinal)
    CROSS JOIN runtime_state r
    LEFT JOIN (sources s JOIN groups sg ON sg.id=s.group_id AND sg.channel_id=$2)
      ON s.id::text=q.request#>>'{source,ref}'
    LEFT JOIN groups g ON g.channel_id=$2 AND
      ((q.request->'source' IS NOT NULL AND g.id=s.group_id) OR
       (q.request->'source' IS NULL AND g.collection_id::text=q.request->>'collectionId'))
    LEFT JOIN publications p ON p.source_id=s.id AND p.id::text=q.request->>'publicationRevision' AND p.collection_id::text=q.request->>'collectionId'
    ORDER BY q.ordinal`,
      [JSON.stringify(requests.map((v) => v.r)), this.store.channelId],
    );
    if (rows.length !== requests.length) throw new Error("source_unavailable");
    return {
      version: 1,
      decisions: requests.map((v, i) => ({
        id: v.id,
        decision: this.evaluate(v.r, v.source, rows[i]!),
      })),
    };
  }
  private evaluate(
    r: Record<string, unknown>,
    source: Record<string, unknown> | undefined,
    row: AccessRow,
  ): Decision {
    const decision = (
      state: Decision["state"],
      revision: string | number = 1,
    ): Decision => ({
      version: 1,
      state,
      policyRevision: Math.min(Number.MAX_SAFE_INTEGER, Number(revision) || 1),
      revocationRevision: Math.min(
        Number.MAX_SAFE_INTEGER,
        Number(row.revocation_revision) || 1,
      ),
    });
    if (source) {
      if (row?.runtime_mode !== "open") throw new Error("source_unavailable");
      if (
        !row ||
        row.asset_source_revision !== source.revision ||
        row.published_at?.getTime() !==
          Date.parse(source.publishedAt as string) ||
        row.expires_at?.getTime() !== Date.parse(source.expiresAt as string)
      )
        return decision("revoked");
      if (
        (row.expires_at !== null && row.expires_at <= this.store.now()) ||
        row.state === "expired"
      )
        return decision("expired", row.policy_revision);
      if (
        row.state === "revoked" ||
        ["deleting", "deleted"].includes(row.group_state ?? "")
      )
        return decision("revoked", row.policy_revision);
      if (row.group_state !== "active")
        return decision("paused", row.policy_revision);
      if (row.state !== "ready" || !row.asset_id || !row.asset_etag)
        throw new Error("source_unavailable");
      if (r.mode === "original") return decision("active", row.policy_revision);
      if (
        !row.sharing_enabled ||
        row.collection_id !== r.collectionId ||
        String(r.aclRevision) !== row.acl_revision ||
        String(r.bindingGeneration) !== row.binding_generation
      )
        return decision("revoked", row.policy_revision);
      const p = row.publication_id
        ? {
            source_revision: row.publication_source_revision,
            acl_revision: row.publication_acl_revision,
            binding_generation: row.publication_binding_generation,
            state: row.publication_state,
            item_id: row.publication_item_id,
          }
        : undefined;
      if (
        !p ||
        p.source_revision !== row.revision ||
        p.acl_revision !== row.acl_revision ||
        p.binding_generation !== row.binding_generation ||
        p.state === "revoked"
      )
        return decision("revoked", row.policy_revision);
      if (
        r.mode === "stage" &&
        ["intent", "staged", "approved", "active"].includes(p.state)
      )
        return decision("active", row.policy_revision);
      if (p.item_id !== r.itemId || !["approved", "active"].includes(p.state))
        return decision("revoked", row.policy_revision);
      return decision("active", row.policy_revision);
    }
    const g = { ...row, state: row.group_state, revision: row.policy_revision };
    if (g?.runtime_mode !== "open") throw new Error("source_unavailable");
    if (
      !g ||
      !g.sharing_enabled ||
      ["deleting", "deleted"].includes(g.state ?? "") ||
      String(r.aclRevision) !== g.acl_revision ||
      String(r.bindingGeneration) !== g.binding_generation
    )
      return decision("revoked", g?.revision);
    return decision(g.state === "active" ? "active" : "paused", g.revision);
  }
}
