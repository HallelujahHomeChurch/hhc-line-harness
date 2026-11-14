import { searchRoutes } from "./search-routes.ts";
import type { SearchAccess } from "./search-routes.ts";
import { managementRoutes } from "./management-routes.ts";
import type { Management } from "../domain/management.ts";
import Fastify from "fastify";
import type { FastifyError } from "fastify";
import { createHmac, timingSafeEqual } from "node:crypto";
import { parseEvents } from "../domain/events.ts";
import type { LineEvent } from "../domain/events.ts";
import type { ProtectedContent } from "../domain/protected-content.ts";
import { Readable } from "node:stream";

export function createServer(options: {
  searchAccess?: SearchAccess;
  management?: { service: Management; token: string };
  channelSecret: string;
  checkDatabase: () => Promise<void>;
  intake?: { botId: string; ingest: (event: LineEvent) => Promise<void> };
  content?: Pick<ProtectedContent, "get">;
  sourceAccess?: {
    token: string;
    check: (input: unknown) => Promise<unknown>;
    checkBatch: (input: unknown) => Promise<unknown>;
  };
}) {
  if (!options.channelSecret.trim())
    throw new Error("LINE_CHANNEL_SECRET is required");
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 });
  app.addHook("onRequest", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
  });
  app.setErrorHandler<FastifyError>((error, _request, reply) => {
    const status =
      error.statusCode === 413 ? 413 : error.statusCode === 415 ? 415 : 500;
    reply.code(status).send({
      ok: false,
      error: status === 500 ? "internal_error" : "invalid_request",
    });
  });
  app.setNotFoundHandler((_request, reply) =>
    reply.code(404).send({ ok: false }),
  );
  app.get("/healthz", async () => ({ ok: true }));
  app.get("/readyz", async (_request, reply) => {
    try {
      await options.checkDatabase();
      return { ok: true };
    } catch {
      return reply.code(503).send({ ok: false });
    }
  });
  app.removeContentTypeParser("application/json");
  if (options.content) {
    const content = options.content;
    app.route<{ Params: { sourceId: string } }>({
      method: ["GET", "HEAD"],
      url: "/api/line/sources/:sourceId/content",
      handler: async (request, reply) => {
        reply
          .header("Cache-Control", "private, no-store")
          .header("X-Content-Type-Options", "nosniff");
        const authorization = request.headers.authorization;
        if (
          typeof authorization !== "string" ||
          !/^Bearer [^\s]{1,8192}$/.test(authorization)
        )
          return reply.code(401).send({ error: "content_forbidden" });
        try {
          const response = await content.get(
            request.params.sourceId,
            authorization.slice(7),
            request.method as "GET" | "HEAD",
            {
              range: request.headers.range,
              etag:
                typeof request.headers["if-none-match"] === "string"
                  ? request.headers["if-none-match"]
                  : undefined,
              modifiedSince: request.headers["if-modified-since"],
            },
          );
          for (const header of [
            "content-type",
            "content-length",
            "content-range",
            "content-disposition",
            "accept-ranges",
            "etag",
            "last-modified",
            "x-hhc-source-expires-at",
          ]) {
            const value = response.headers.get(header);
            if (value !== null) reply.header(header, value);
          }
          reply.code(response.status);
          return reply.send(
            response.body ? Readable.from(response.body) : undefined,
          );
        } catch (error) {
          const code =
            error instanceof Error ? error.message : "content_unavailable";
          const status =
            code === "content_forbidden"
              ? 403
              : code === "content_gone"
                ? 410
                : code === "content_paused"
                  ? 423
                  : code === "invalid_range"
                    ? 416
                    : 503;
          return reply
            .code(status)
            .send({ error: status === 503 ? "content_unavailable" : code });
        }
      },
    });
  }
  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (_request, body, done) => done(null, body),
  );
  if (options.searchAccess) searchRoutes(app, options.searchAccess);
  if (options.management)
    managementRoutes(app, options.management.service, options.management.token);
  if (options.sourceAccess) {
    const sourceAccess = options.sourceAccess;
    if (!/^[0-9a-f]{64}$/.test(sourceAccess.token))
      throw new Error("invalid_source_credential");
    for (const batch of [false, true])
      app.post(
        batch ? "/priv/source/check-batch" : "/priv/source/check",
        { bodyLimit: batch ? 65536 : 8192 },
        async (request, reply) => {
          const token = request.headers["x-hhc-harness-service-token"];
          if (
            request.headers["x-hhc-harness-service-caller"] !== "asset-api" ||
            typeof token !== "string" ||
            !/^[0-9a-f]{64}$/.test(token) ||
            !timingSafeEqual(
              Buffer.from(token),
              Buffer.from(sourceAccess.token),
            )
          )
            return reply.code(403).send({ error: "forbidden" });
          let input: unknown;
          try {
            if (!Buffer.isBuffer(request.body)) throw new Error();
            input = JSON.parse(request.body.toString("utf8"));
          } catch {
            return reply.code(400).send({ error: "invalid_source_request" });
          }
          try {
            return await (batch
              ? sourceAccess.checkBatch(input)
              : sourceAccess.check(input));
          } catch (error) {
            if (
              error instanceof Error &&
              ["invalid_source_request", "invalid_payload"].includes(
                error.message,
              )
            )
              return reply.code(400).send({ error: "invalid_source_request" });
            return reply.code(503).send({ error: "source_unavailable" });
          }
        },
      );
  }
  app.post("/api/line/webhook", async (request, reply) => {
    const signature = request.headers["x-line-signature"];
    const body: unknown = request.body;
    const expected = Buffer.isBuffer(body)
      ? createHmac("sha256", options.channelSecret).update(body).digest()
      : undefined;
    const supplied =
      typeof signature === "string" && /^[A-Za-z0-9+/]{43}=$/.test(signature)
        ? Buffer.from(signature, "base64")
        : undefined;
    if (
      !expected ||
      !supplied ||
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    ) {
      return reply
        .code(400)
        .send({ ok: false, error: "invalid_line_signature" });
    }
    let payload: unknown;
    try {
      payload = JSON.parse((body as Buffer).toString("utf8"));
    } catch {
      return reply.code(400).send({ ok: false, error: "invalid_payload" });
    }
    if (
      typeof payload !== "object" ||
      payload === null ||
      !("events" in payload) ||
      !Array.isArray(payload.events) ||
      !payload.events.every(
        (event: unknown) =>
          typeof event === "object" &&
          event !== null &&
          "type" in event &&
          typeof event.type === "string",
      )
    ) {
      return reply.code(400).send({ ok: false, error: "invalid_payload" });
    }
    if (payload.events.length === 0) return { ok: true };
    if (options.intake) {
      let events: LineEvent[];
      try {
        events = parseEvents(payload, options.intake.botId);
      } catch {
        return reply.code(400).send({ ok: false, error: "invalid_payload" });
      }
      // Lifecycle denial takes precedence over ordinary work in the same batch.
      const priority = (event: LineEvent) =>
        ["unsend", "leave", "memberLeft"].includes(event.type) ? 0 : 1;
      events.sort((a, b) => priority(a) - priority(b));
      try {
        for (const event of events) await options.intake.ingest(event);
      } catch {
        process.stderr.write("line_harness_intake_persist_failed\n");
        return reply
          .code(503)
          .header("Retry-After", "1")
          .send({ ok: false, error: "intake_unavailable" });
      }
      return { ok: true };
    }
    // Receipt/job persistence and group admission must precede acknowledging events.
    return reply
      .code(503)
      .header("Retry-After", "60")
      .send({ ok: false, error: "intake_not_enabled" });
  });
  return app;
}
