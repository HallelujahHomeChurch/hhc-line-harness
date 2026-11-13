import { isAssetId } from "../domain/asset-id.ts";
import type { ContentHeaders } from "../domain/protected-content.ts";
import { Readable } from "node:stream";
import { createReadStream } from "node:fs";
import { ServiceClient, DependencyError } from "./http.ts";
import { object } from "../domain/events.ts";
import type {
  Source,
  DownloadedFile,
  AssetRecord,
  Upload,
} from "../worker/original.ts";
import { PermanentSourceError } from "../worker/original.ts";
export class AssetOriginalClient {
  readonly http: ServiceClient;
  readonly uploadOrigins: Set<string>;
  constructor(
    origin: string,
    token: string,
    uploadOrigins: string[],
    fetcher: typeof fetch = fetch,
  ) {
    if (!/^[A-Za-z0-9._~-]+$/.test(token) || !uploadOrigins.length)
      throw new Error("invalid_asset_config");
    this.http = new ServiceClient(
      origin,
      { "X-HHC-Workload-Authorization": `Bearer ${token}` },
      fetcher,
    );
    this.uploadOrigins = new Set(
      uploadOrigins.map((value) => {
        const u = new URL(value);
        if (u.protocol !== "https:" || u.origin !== value)
          throw new Error("invalid_upload_origin");
        return value;
      }),
    );
  }
  record(input: unknown, readiness = false): AssetRecord {
    const a = object(input),
      s = object(a.sourcePolicy);
    if (
      typeof a.id !== "string" ||
      !isAssetId(a.id) ||
      a.ownerService !== "hhc-line-harness" ||
      !["line.group.file", "line.group.media-sync"].includes(
        String(a.namespace),
      ) ||
      a.visibility !== "restricted" ||
      s.version !== 1 ||
      typeof s.ref !== "string" ||
      typeof s.revision !== "string" ||
      typeof s.publishedAt !== "string" ||
      typeof s.expiresAt !== "string" ||
      Date.parse(s.expiresAt) - Date.parse(s.publishedAt) !== 90 * 86400000
    )
      throw new PermanentSourceError();
    const ready =
      readiness &&
      a.processingReadiness !== undefined &&
      object(a.processingReadiness).version === 2 &&
      object(a.processingReadiness).state === "ready" &&
      a.safetyEvidence !== undefined &&
      object(a.safetyEvidence).kind === "not-scanned" &&
      a.uploadStatus === "completed" &&
      a.scanStatus === "not_required" &&
      a.processingStatus === "not_required" &&
      (a.deletedAt === undefined || a.deletedAt === "0001-01-01T00:00:00Z");
    return {
      id: a.id,
      ref: s.ref,
      revision: s.revision,
      publishedAt: s.publishedAt,
      expiresAt: s.expiresAt,
      ready,
      etag: typeof a.etag === "string" ? a.etag : "",
      size: typeof a.sizeBytes === "number" ? a.sizeBytes : 0,
      checksum: typeof a.checksumSha256 === "string" ? a.checksumSha256 : "",
      mime: typeof a.detectedMimeType === "string" ? a.detectedMimeType : "",
    };
  }
  async lookup(operation: string): Promise<AssetRecord | undefined> {
    try {
      return this.record(
        object(
          await this.http.json(
            `/priv/assets/upload-sessions/${operation}`,
            "GET",
          ),
        ).asset,
      );
    } catch (error) {
      if (error instanceof DependencyError && error.status === 404) return;
      throw error;
    }
  }
  async inspect(id: string): Promise<AssetRecord> {
    return this.record(await this.http.json(`/priv/assets/${id}`, "GET"), true);
  }
  async create(source: Source, file: DownloadedFile): Promise<Upload> {
    const r = await this.http.json(
      "/priv/assets/upload-sessions",
      "POST",
      {
        namespace: "line.group.file",
        ownerService: "hhc-line-harness",
        ownerType: "line_message",
        ownerId: source.id,
        purpose: "original",
        locale: "",
        originalFileName: file.fileName,
        expectedMimeType: file.mime,
        maxSizeBytes: file.size,
        visibility: "restricted",
        securityProfile: "line-source-unscanned-v1",
        processingProfile: "no-processing-v1",
        source: {
          ref: source.id,
          revision: source.asset_source_revision,
          publishedAt: source.published_at.toISOString(),
        },
      },
      { idempotencyKey: source.id },
    );
    return { asset: this.record(r.asset), target: r.uploadTarget };
  }
  async put(upload: Upload, file: DownloadedFile): Promise<void> {
    const target = object(upload.target);
    if (
      target.method !== "PUT" ||
      typeof target.url !== "string" ||
      typeof target.expiresAt !== "string" ||
      Date.parse(target.expiresAt) <= Date.now()
    )
      throw new PermanentSourceError();
    const url = new URL(target.url);
    if (
      !this.uploadOrigins.has(url.origin) ||
      url.username ||
      url.password ||
      url.hash
    )
      throw new PermanentSourceError();
    const headers = object(target.headers);
    const allowed = new Set(["content-type", "x-ms-blob-type", "x-ms-version"]);
    if (
      Object.entries(headers).some(
        ([key, value]) =>
          !allowed.has(key.toLowerCase()) ||
          typeof value !== "string" ||
          /[\r\n]/.test(value),
      )
    )
      throw new PermanentSourceError();
    const body = createReadStream(file.path);
    try {
      const response = await this.http.fetcher(url, {
        method: "PUT",
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
        headers: {
          ...(headers as Record<string, string>),
          "content-length": String(file.size),
        },
        body: Readable.toWeb(body),
        duplex: "half",
      } as RequestInit & { duplex: "half" });
      await response.body?.cancel();
      if (!response.ok) throw new DependencyError(response.status);
    } finally {
      body.destroy();
    }
  }
  async complete(id: string, file: DownloadedFile): Promise<AssetRecord> {
    return this.record(
      await this.http.json(
        `/priv/assets/${id}/complete`,
        "POST",
        {
          sizeBytes: file.size,
          checksumSha256: file.checksum,
          mimeType: file.mime,
        },
        { timeoutMs: 15_000 },
      ),
      true,
    );
  }
  async content(
    id: string,
    method: "GET" | "HEAD",
    headers: ContentHeaders,
  ): Promise<Response> {
    if (!isAssetId(id)) throw new Error("content_forbidden");
    if (
      headers.range !== undefined &&
      !/^bytes=(?:[0-9]+-[0-9]*|-[0-9]+)$/.test(headers.range)
    )
      throw new Error("invalid_range");
    return this.http.fetcher(
      new URL(`/priv/assets/${id}/source-content`, this.http.origin),
      {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
        headers: {
          ...this.http.headers,
          ...(headers.range ? { Range: headers.range } : {}),
          ...(headers.etag ? { "If-None-Match": headers.etag } : {}),
          ...(headers.modifiedSince
            ? { "If-Modified-Since": headers.modifiedSince }
            : {}),
        },
      },
    );
  }
  async remove(id: string): Promise<void> {
    try {
      await this.http.json(`/priv/assets/${id}`, "DELETE");
    } catch (error) {
      if (!(error instanceof DependencyError && error.status === 404))
        throw error;
    }
  }
}
