import { object } from "../domain/events.ts";
import type { Source } from "../worker/original.ts";
import type { Publication, PublicationRecord } from "../worker/publication.ts";
import { ServiceClient, DependencyError } from "./http.ts";
export class AssetPublicationClient {
  readonly http: ServiceClient;
  constructor(http: ServiceClient) {
    this.http = http;
  }
  record(input: unknown): PublicationRecord {
    const r = object(input),
      item = object(r.item);
    const deleted =
      item.deletedAt !== undefined && item.deletedAt !== "0001-01-01T00:00:00Z";
    if (
      typeof item.id !== "string" ||
      typeof item.collectionId !== "string" ||
      (!deleted && typeof item.assetId !== "string") ||
      typeof item.sourceRevision !== "string" ||
      !["staged", "active"].includes(String(item.publicationState)) ||
      (deleted &&
        (typeof item.deletedAt !== "string" ||
          !Number.isFinite(Date.parse(item.deletedAt))))
    )
      throw new Error("publication_unavailable");
    return {
      itemId: item.id,
      collectionId: item.collectionId,
      assetId: typeof item.assetId === "string" ? item.assetId : "",
      revision: item.sourceRevision,
      state: deleted
        ? "deleted"
        : (item.publicationState as "staged" | "active"),
    };
  }
  async lookup(p: Publication): Promise<PublicationRecord | undefined> {
    try {
      return this.record(
        await this.http.json(
          `/priv/assets/collections/${p.collection_id}/publications/${p.id}`,
          "GET",
        ),
      );
    } catch (error) {
      if (error instanceof DependencyError && error.status === 404) return;
      throw error;
    }
  }
  async stage(p: Publication, s: Source): Promise<PublicationRecord> {
    return this.record(
      await this.http.json(
        `/priv/assets/collections/${p.collection_id}/staged-items`,
        "POST",
        {
          assetId: s.asset_id,
          remoteItemId: s.id,
          displayName: (s.file_name ?? s.upload_file_name ?? "附件").slice(
            0,
            200,
          ),
          sourceRevision: p.id,
          bindingGeneration: Number(p.binding_generation),
          expectedAclRevision: Number(p.acl_revision),
        },
        { idempotencyKey: p.id },
      ),
    );
  }
  async activate(p: Publication): Promise<PublicationRecord> {
    return this.record(
      await this.http.json(
        `/priv/assets/collections/${p.collection_id}/items/${p.item_id}/activate`,
        "POST",
        {
          bindingGeneration: Number(p.binding_generation),
          expectedAclRevision: Number(p.acl_revision),
        },
        { idempotencyKey: `${p.id}-activate` },
      ),
    );
  }
  async remove(p: Publication): Promise<void> {
    if (!p.item_id) return;
    try {
      await this.http.json(
        `/priv/assets/collections/${p.collection_id}/items/${p.item_id}`,
        "DELETE",
        undefined,
        { idempotencyKey: `${p.id}-delete` },
      );
    } catch (error) {
      if (!(error instanceof DependencyError && error.status === 404))
        throw error;
    }
  }
}
