import { isAssetId } from "../domain/asset-id.ts";
import { inspectLineUploadPolicy } from "./asset-policy.ts";
import { ServiceClient } from "./http.ts";
import { object } from "../domain/events.ts";
import type {
  CollectionApproval,
  ReaderSubject,
} from "../domain/registration.ts";
export class AssetClient {
  readonly http: ServiceClient;
  constructor(origin: string, token: string, fetcher: typeof fetch = fetch) {
    if (!/^[A-Za-z0-9._~-]+$/.test(token))
      throw new Error("invalid_asset_credential");
    this.http = new ServiceClient(
      origin,
      { "X-HHC-Workload-Authorization": `Bearer ${token}` },
      fetcher,
    );
  }
  async checkPolicy(): Promise<void> {
    for (const namespace of ["line.group.file", "line.group.media-sync"]) {
      const result = await this.http.json(
        "/priv/assets/upload-policy",
        "POST",
        {
          namespace,
          securityProfile: "line-source-unscanned-v1",
          processingProfile: "no-processing-v1",
        },
      );
      if (
        result.namespace !== namespace ||
        inspectLineUploadPolicy(result).status !== "source_ready"
      )
        throw new Error("asset_contract_unavailable");
    }
  }
  async collections(cursor = "") {
    const r = await this.http.json(
      `/priv/assets/collections?limit=25${cursor ? "&cursor=" + encodeURIComponent(cursor) : ""}`,
      "GET",
      undefined,
      { maxBytes: 128 * 1024 },
    );
    if (
      !Array.isArray(r.collections) ||
      r.collections.length > 25 ||
      typeof r.hasMore !== "boolean" ||
      (r.cursor !== undefined && typeof r.cursor !== "string")
    )
      throw Error("dependency_unavailable");
    const collections = r.collections.map((raw) => {
      const c = object(object(raw).collection);
      if (
        typeof c.id !== "string" ||
        !isAssetId(c.id) ||
        typeof c.name !== "string" ||
        c.name.length > 120 ||
        c.sourcePolicyVersion !== 1 ||
        c.namespace !== "line.group.media-sync"
      )
        throw Error("dependency_unavailable");
      return { id: c.id, name: c.name };
    });
    return {
      collections,
      hasMore: r.hasMore,
      ...(typeof r.cursor === "string" ? { cursor: r.cursor } : {}),
    };
  }
  async createCollection(operation: string, name: string, actor: string) {
    if (!/^[0-9a-f-]{36}$/.test(operation) || !/^[0-9a-f-]{36}$/.test(actor))
      throw Error("invalid_collection");
    const r = await this.http.json(
      "/priv/assets/collections",
      "POST",
      { namespace: "line.group.media-sync", name, bindingGeneration: 1 },
      { idempotencyKey: operation, actorUserId: actor },
    );
    if (
      typeof r.id !== "string" ||
      !isAssetId(r.id) ||
      r.name !== name ||
      r.sourcePolicyVersion !== 1
    )
      throw Error("dependency_unavailable");
    return { id: r.id, name: r.name };
  }
  async addReader(
    collection: string,
    subject: ReaderSubject,
    expected: number,
    operation: string,
    actor: string,
  ) {
    if (
      !isAssetId(collection) ||
      !/^[0-9a-f-]{36}$/.test(subject.id) ||
      !["user", "role"].includes(subject.type) ||
      !Number.isSafeInteger(expected) ||
      expected < 1 ||
      !/^[0-9a-f]{64}$/.test(operation) ||
      !/^[0-9a-f-]{36}$/.test(actor)
    )
      throw Error("invalid_management_request");
    await this.http.json(
      `/priv/assets/collections/${collection}/acl`,
      "POST",
      {
        subjectType: subject.type,
        subjectId: subject.id,
        permission: "read",
        expectedAclRevision: expected,
      },
      { idempotencyKey: operation, actorUserId: actor },
    );
  }
  async revokeReader(
    collection: string,
    acl: string,
    expected: number,
    operation: string,
    actor: string,
  ) {
    if (
      !isAssetId(collection) ||
      !isAssetId(acl) ||
      !/^[0-9a-f-]{36}$/.test(actor) ||
      !Number.isSafeInteger(expected) ||
      expected < 1 ||
      !/^[0-9a-f]{64}$/.test(operation)
    )
      throw Error("invalid_management_request");
    await this.http.json(
      `/priv/assets/collections/${collection}/acl/${acl}`,
      "DELETE",
      undefined,
      { idempotencyKey: operation, actorUserId: actor, ifMatch: expected },
    );
  }
  async collection(id: string): Promise<CollectionApproval> {
    if (!isAssetId(id)) throw new Error("invalid_collection");
    const r = await this.http.json(
      `/priv/assets/collections/${id}`,
      "GET",
      undefined,
      { maxBytes: 128 * 1024 },
    );
    const c = object(r.collection);
    if (
      c.id !== id ||
      c.sourcePolicyVersion !== 1 ||
      c.namespace !== "line.group.media-sync" ||
      (c.deletedAt !== undefined && c.deletedAt !== "0001-01-01T00:00:00Z") ||
      !Number.isSafeInteger(c.aclRevision) ||
      Number(c.aclRevision) <= 0 ||
      !Number.isSafeInteger(c.bindingGeneration) ||
      Number(c.bindingGeneration) <= 0 ||
      !Array.isArray(r.acls)
    )
      throw new Error("dependency_unavailable");
    const readers: NonNullable<CollectionApproval["readers"]> = [];
    const audience = r.acls.flatMap((raw: unknown) => {
      const a = object(raw);
      if (a.revokedAt !== undefined && a.revokedAt !== "0001-01-01T00:00:00Z")
        return [];
      if (
        typeof a.id !== "string" ||
        !isAssetId(a.id) ||
        a.collectionId !== id ||
        !["user", "role"].includes(String(a.subjectType)) ||
        a.permission !== "read" ||
        typeof a.subjectId !== "string" ||
        !/^[0-9a-f-]{36}$/.test(a.subjectId)
      )
        throw new Error("dependency_unavailable");
      readers.push({
        id: a.id as string,
        type: a.subjectType as "user" | "role",
        subjectId: a.subjectId,
      });
      return [`${a.subjectType}:${a.subjectId}`];
    });
    if (readers.length > 128) throw new Error("dependency_unavailable");
    return {
      id,
      aclRevision: Number(c.aclRevision),
      bindingGeneration: Number(c.bindingGeneration),
      audience,
      readers,
    };
  }
}
