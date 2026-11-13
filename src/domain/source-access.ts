import type { Store } from "../persistence/store.ts";
import { object } from "./events.ts";
interface Decision {
  version: 1;
  state: "active" | "paused" | "revoked" | "expired";
  policyRevision: number;
}
export class SourceAccess {
  readonly store: Store;
  constructor(store: Store) {
    this.store = store;
  }
  async check(input: unknown): Promise<Decision> {
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
    const decision = (
      state: Decision["state"],
      revision: string | number = 1,
    ): Decision => ({
      version: 1,
      state,
      policyRevision: Math.min(Number.MAX_SAFE_INTEGER, Number(revision) || 1),
    });
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
    if (source) {
      const row = (
        await this.store.pool.query(
          `SELECT s.*,r.mode AS runtime_mode,g.state AS group_state,g.revision AS policy_revision,g.collection_id,g.sharing_enabled,g.acl_revision,g.binding_generation,
      p.id AS publication_id,p.source_revision AS publication_source_revision,p.acl_revision AS publication_acl_revision,p.binding_generation AS publication_binding_generation,p.state AS publication_state,p.item_id AS publication_item_id
      FROM runtime_state r LEFT JOIN (sources s JOIN groups g ON g.id=s.group_id) ON s.id::text=$1 AND g.channel_id=$2
      LEFT JOIN publications p ON p.source_id=s.id AND p.id::text=$3 AND p.collection_id::text=$4`,
          [
            source.ref,
            this.store.channelId,
            r.publicationRevision,
            r.collectionId,
          ],
        )
      ).rows[0];
      if (row?.runtime_mode !== "open") throw new Error("source_unavailable");
      if (
        !row ||
        row.asset_source_revision !== source.revision ||
        row.published_at.getTime() !==
          Date.parse(source.publishedAt as string) ||
        row.expires_at.getTime() !== Date.parse(source.expiresAt as string)
      )
        return decision("revoked");
      if (row.expires_at <= this.store.now() || row.state === "expired")
        return decision("expired", row.policy_revision);
      if (
        row.state === "revoked" ||
        ["deleting", "deleted"].includes(row.group_state)
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
    const g = (
      await this.store.pool.query(
        "SELECT g.*,r.mode AS runtime_mode FROM runtime_state r LEFT JOIN groups g ON g.collection_id::text=$1 AND g.channel_id=$2",
        [r.collectionId, this.store.channelId],
      )
    ).rows[0];
    if (g?.runtime_mode !== "open") throw new Error("source_unavailable");
    if (
      !g ||
      !g.sharing_enabled ||
      ["deleting", "deleted"].includes(g.state) ||
      String(r.aclRevision) !== g.acl_revision ||
      String(r.bindingGeneration) !== g.binding_generation
    )
      return decision("revoked", g?.revision);
    return decision(g.state === "active" ? "active" : "paused", g.revision);
  }
}
