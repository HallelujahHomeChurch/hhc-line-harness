import type { FastifyInstance } from "fastify";
import { timingSafeEqual } from "node:crypto";
import type { Management } from "../domain/management.ts";
import { object } from "../domain/events.ts";
export function managementRoutes(
  app: FastifyInstance,
  management: Management,
  token: string,
) {
  if (!/^[0-9a-f]{64}$/.test(token))
    throw Error("invalid_management_credential");
  const prefix = "/api/line/harness/admin";
  const routes = [
    ["GET", `${prefix}/groups`],
    ["POST", `${prefix}/groups/search`],
    ["GET", `${prefix}/groups/:id/readers`],
    ["POST", `${prefix}/groups/:id/readers/revoke-preview`],
    ["POST", `${prefix}/subjects/search`],
    ["POST", `${prefix}/collections/search`],
    ["POST", `${prefix}/collections`],
    ["GET", `${prefix}/setups/:id`],
    ["PUT", `${prefix}/setups/:id`],
    ["POST", `${prefix}/groups/:id/preview`],
    ["POST", `${prefix}/operations/:id/confirm`],
  ] as const;
  for (const [method, url] of routes)
    app.route<{ Params: { id?: string } }>({
      method,
      url,
      bodyLimit: 8192,
      exposeHeadRoute: false,
      handler: async (request, reply) => {
        const provided = request.headers["x-hhc-harness-gateway-token"],
          actor = request.headers["x-hhc-user-id"];
        if (
          typeof provided !== "string" ||
          !/^[0-9a-f]{64}$/.test(provided) ||
          !timingSafeEqual(Buffer.from(provided), Buffer.from(token)) ||
          request.headers["x-hhc-principal-type"] !== "user" ||
          request.headers["x-hhc-auth-provider"] !== "account-api" ||
          typeof actor !== "string"
        )
          return reply.code(403).send({ error: "forbidden" });
        if (Object.keys(request.query as object).length)
          return reply.code(400).send({ error: "invalid_management_request" });
        let body: Record<string, unknown> = {};
        if (method !== "GET")
          try {
            if (!Buffer.isBuffer(request.body)) throw Error();
            body = object(JSON.parse(request.body.toString("utf8")));
          } catch {
            return reply
              .code(400)
              .send({ error: "invalid_management_request" });
          }
        try {
          if (url === `${prefix}/groups/search`) {
            if (
              Object.keys(body).some((k) => k !== "cursor") ||
              (body.cursor !== undefined && typeof body.cursor !== "string")
            )
              throw Error("invalid_management_request");
            return {
              groups: await management.groups(
                actor,
                body.cursor as string | undefined,
              ),
            };
          }
          if (url === `${prefix}/subjects/search`) {
            if (
              Object.keys(body).some(
                (k) => !["type", "query", "page"].includes(k),
              ) ||
              !["user", "role"].includes(String(body.type)) ||
              typeof body.query !== "string" ||
              typeof body.page !== "number"
            )
              throw Error("invalid_management_request");
            return await management.subjects(
              actor,
              body.type as "user" | "role",
              body.query,
              body.page,
            );
          }
          if (url === `${prefix}/collections/search`) {
            if (
              Object.keys(body).some((k) => k !== "cursor") ||
              (body.cursor !== undefined && typeof body.cursor !== "string")
            )
              throw Error("invalid_management_request");
            return await management.collections(
              actor,
              body.cursor as string | undefined,
            );
          }
          if (url === `${prefix}/collections`) {
            if (
              Object.keys(body).some((k) => !["id", "name"].includes(k)) ||
              typeof body.id !== "string" ||
              typeof body.name !== "string"
            )
              throw Error("invalid_management_request");
            return await management.createCollection(actor, body.id, body.name);
          }
          if (url === `${prefix}/groups/:id/readers`) {
            const { collection } = await management.readers(
              actor,
              request.params.id!,
            );
            return { readers: collection.readers ?? [] };
          }
          if (url.endsWith("/revoke-preview")) {
            if (
              Object.keys(body).some(
                (k) => !["aclId", "expectedRevision"].includes(k),
              ) ||
              typeof body.aclId !== "string" ||
              typeof body.expectedRevision !== "number"
            )
              throw Error("invalid_management_request");
            return await management.previewRevoke(
              actor,
              request.params.id!,
              body.aclId,
              body.expectedRevision,
            );
          }
          if (method === "GET")
            return request.params.id
              ? await management.setup(actor, request.params.id)
              : { groups: await management.groups(actor) };
          if (method === "PUT") {
            if (
              Object.keys(body).some(
                (k) =>
                  ![
                    "sharing",
                    "collectionId",
                    "expectedRevision",
                    "addReader",
                  ].includes(k),
              ) ||
              typeof body.sharing !== "boolean" ||
              typeof body.expectedRevision !== "number" ||
              (body.collectionId !== undefined &&
                typeof body.collectionId !== "string")
            )
              throw Error("invalid_management_request");
            if (body.addReader !== undefined) {
              const r = object(body.addReader);
              if (
                Object.keys(r).some((k) => !["type", "id"].includes(k)) ||
                !["user", "role"].includes(String(r.type)) ||
                typeof r.id !== "string"
              )
                throw Error("invalid_management_request");
            }
            return await management.configure(
              actor,
              request.params.id!,
              body as {
                sharing: boolean;
                collectionId?: string;
                addReader?: { type: "user" | "role"; id: string };
                expectedRevision: number;
              },
            );
          }
          if (url.endsWith("/preview")) {
            if (
              Object.keys(body).some(
                (k) => !["action", "expectedRevision"].includes(k),
              ) ||
              !["pause", "delete"].includes(String(body.action)) ||
              typeof body.expectedRevision !== "number"
            )
              throw Error("invalid_management_request");
            return await management.preview(
              actor,
              request.params.id!,
              body.action as "pause" | "delete",
              body.expectedRevision,
            );
          }
          if (
            Object.keys(body).some((k) => k !== "token") ||
            typeof body.token !== "string"
          )
            throw Error("invalid_management_request");
          await management.confirm(actor, request.params.id!, body.token);
          return { state: "completed" };
        } catch (e) {
          const code = e instanceof Error ? e.message : "";
          const status =
            code === "admin_required" || code === "admin_binding_required"
              ? 403
              : code === "setup_expired_or_changed" ||
                  code === "management_changed"
                ? 409
                : code === "invalid_management_request"
                  ? 400
                  : 503;
          return reply
            .code(status)
            .send({ error: status === 503 ? "management_unavailable" : code });
        }
      },
    });
}
