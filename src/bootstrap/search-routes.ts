import type { FastifyInstance } from "fastify";
import type { SourceEdits } from "../domain/source-edits.ts";
import type { Conversations } from "../domain/conversations.ts";
import type { SearchInput } from "../search/search.ts";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
export interface SearchAccess {
  edits?: Pick<SourceEdits, "preview" | "confirm">;
  service: Pick<Conversations, "start" | "read" | "reset">;
  identity: (token: string) => Promise<string>;
  liffId?: string;
}
export function searchRoutes(app: FastifyInstance, access: SearchAccess) {
  const routes = [
    ["POST", "/api/line/harness/groups/:groupId/search", "start"],
    ["POST", "/api/line/harness/groups/:groupId/reset", "reset"],
    ["GET", "/api/line/harness/groups/:groupId/results/:jobId", "read"],
    [
      "POST",
      "/api/line/harness/groups/:groupId/sources/:sourceId/preview",
      "preview",
    ],
    [
      "POST",
      "/api/line/harness/groups/:groupId/edits/:editId/confirm",
      "confirm",
    ],
  ] as const;
  for (const [method, url, action] of routes)
    app.route<{
      Params: {
        groupId: string;
        jobId?: string;
        sourceId?: string;
        editId?: string;
      };
    }>({
      method,
      url,
      bodyLimit: 8192,
      handler: async (request, reply) => {
        reply
          .header("Cache-Control", "private, no-store")
          .header("X-Content-Type-Options", "nosniff");
        if (
          request.url.includes("?") ||
          !/^\/[a-zA-Z0-9/:-]+$/.test(request.url)
        )
          return reply.code(400).send({ error: "invalid_search" });
        const authorization = request.headers.authorization;
        if (
          typeof authorization !== "string" ||
          !/^Bearer [^\s]{1,8192}$/.test(authorization)
        )
          return reply.code(401).send({ error: "search_forbidden" });
        try {
          if (!/^[0-9a-f-]{36}$/.test(request.params.groupId))
            throw new Error("invalid_search");
          const actor = await access.identity(authorization.slice(7));
          if (action === "read")
            return await access.service.read(
              request.params.jobId!,
              actor,
              request.params.groupId,
            );
          let input: Record<string, unknown>;
          try {
            input = JSON.parse(
              Buffer.isBuffer(request.body)
                ? request.body.toString("utf8")
                : "{}",
            );
            if (!input || Array.isArray(input) || typeof input !== "object")
              throw new Error();
          } catch {
            throw new Error("invalid_search");
          }
          if (action === "preview") {
            if (!access.edits) throw new Error("search_unavailable");
            return await access.edits.preview(
              request.params.groupId,
              actor,
              request.params.sourceId!,
              input as unknown as Parameters<SourceEdits["preview"]>[3],
            );
          }
          if (action === "confirm") {
            if (
              !access.edits ||
              Object.keys(input).join() !== "token" ||
              typeof input.token !== "string"
            )
              throw new Error("invalid_search");
            await access.edits.confirm(
              request.params.groupId,
              actor,
              request.params.editId!,
              input.token,
            );
            return { ok: true };
          }
          if (action === "reset") {
            if (Object.keys(input).length) throw new Error("invalid_search");
            await access.service.reset(request.params.groupId, actor);
            return { ok: true };
          }
          if (
            typeof input.query !== "string" ||
            Object.keys(input).some(
              (k) =>
                ![
                  "query",
                  "kind",
                  "authorId",
                  "publishedFrom",
                  "publishedBefore",
                ].includes(k),
            )
          )
            throw new Error("invalid_search");
          return reply
            .code(202)
            .send(
              await access.service.start(
                request.params.groupId,
                actor,
                input as unknown as SearchInput,
              ),
            );
        } catch (error) {
          const code =
            error instanceof Error ? error.message : "search_unavailable";
          const status = ["invalid_search", "invalid_edit"].includes(code)
            ? 400
            : ["search_forbidden", "edit_forbidden"].includes(code)
              ? 403
              : ["search_gone", "edit_expired"].includes(code)
                ? 410
                : code === "search_paused"
                  ? 423
                  : code === "search_busy"
                    ? 429
                    : 503;
          return reply
            .code(status)
            .send({ error: status === 503 ? "search_unavailable" : code });
        }
      },
    });
  if (access.liffId) {
    if (!/^[0-9]{5,20}-[A-Za-z0-9]{4,32}$/.test(access.liffId))
      throw new Error("invalid_liff_id");
    const files = {
      "/api/line/harness/app": "web/index.html",
      "/api/line/harness/app.js": "dist/web/liff.js",
      "/api/line/harness/app.css": "web/liff.css",
    };
    for (const [url, file] of Object.entries(files))
      app.get(url, async (_request, reply) => {
        reply
          .header(
            "Content-Security-Policy",
            "default-src 'none'; script-src 'self' https://static.line-scdn.net/liff/edge/versions/2.31.1/sdk.js; style-src 'self'; connect-src 'self' https://api.line.me https://access.line.me https://liff.line.me; img-src 'self' data:; frame-src https://access.line.me; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
          )
          .header("Referrer-Policy", "no-referrer")
          .header("X-Content-Type-Options", "nosniff");
        return reply
          .type(
            file.endsWith(".html")
              ? "text/html; charset=utf-8"
              : file.endsWith(".css")
                ? "text/css; charset=utf-8"
                : "text/javascript; charset=utf-8",
          )
          .send(await readFile(resolve(file)));
      });
    app.get("/api/line/harness/app-config", async () => ({
      liffId: access.liffId,
    }));
  }
}
