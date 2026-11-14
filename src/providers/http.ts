import { randomUUID } from "node:crypto";
import { object } from "../domain/events.ts";
export class DependencyError extends Error {
  readonly status: number;
  constructor(status = 0) {
    super("dependency_unavailable");
    this.status = status;
  }
}
export class ServiceClient {
  readonly origin: URL;
  readonly headers: Record<string, string>;
  readonly fetcher: typeof fetch;
  constructor(
    origin: string,
    headers: Record<string, string>,
    fetcher: typeof fetch = fetch,
  ) {
    this.origin = new URL(origin);
    if (
      this.origin.protocol !== "https:" ||
      this.origin.username ||
      this.origin.password ||
      this.origin.pathname !== "/" ||
      this.origin.search ||
      this.origin.hash
    )
      throw new Error("invalid_service_origin");
    this.headers = headers;
    this.fetcher = fetcher;
  }
  async json(
    path: string,
    method: "GET" | "POST" | "PUT" | "DELETE",
    body?: unknown,
    options: {
      idempotencyKey?: string;
      timeoutMs?: number;
      actorUserId?: string;
      ifMatch?: number;
      maxBytes?: number;
    } = {},
  ): Promise<Record<string, unknown>> {
    if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\"))
      throw new Error("invalid_service_path");
    try {
      const response = await this.fetcher(new URL(path, this.origin), {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(options.timeoutMs ?? 2000),
        headers: {
          ...this.headers,
          ...(options.ifMatch === undefined
            ? {}
            : { "If-Match": `"${options.ifMatch}"` }),
          ...(options.actorUserId
            ? { "X-HHC-Actor-ID": options.actorUserId }
            : {}),
          ...(options.idempotencyKey
            ? { "Idempotency-Key": options.idempotencyKey }
            : {}),
          "content-type": "application/json",
          "X-HHC-Request-ID": randomUUID().replaceAll("-", ""),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return await readJson(response, options.maxBytes);
    } catch (error) {
      if (error instanceof DependencyError) throw error;
      throw new DependencyError();
    }
  }
}

export async function readJson(
  response: Response,
  maxBytes = 32768,
): Promise<Record<string, unknown>> {
  if (response.status === 204) return {};
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new DependencyError(response.status);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error();
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return object(JSON.parse(Buffer.concat(chunks).toString("utf8")));
}
