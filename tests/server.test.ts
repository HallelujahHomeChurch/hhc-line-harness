import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { createServer } from "../src/bootstrap/server.ts";

const secret = "synthetic-channel-secret";
const sign = (body: string) =>
  createHmac("sha256", secret).update(body).digest("base64");

test("signed empty probe succeeds; real events remain retryable until durable intake exists", async () => {
  const app = createServer({
    channelSecret: secret,
    checkDatabase: async () => {},
  });
  try {
    for (const [body, status] of [
      ['{"events":[]}', 200],
      [
        '{"destination":"synthetic-bot","events":[{"type":"message","webhookEventId":"event-1"}]}',
        503,
      ],
      ['{"events":[null]}', 400],
      ['{"events":{}}', 400],
      ["{}", 400],
      ["{", 400],
    ] as const) {
      const response = await app.inject({
        method: "POST",
        url: "/api/line/webhook",
        payload: body,
        headers: {
          "content-type": "application/json",
          "x-line-signature": sign(body),
        },
      });
      assert.equal(response.statusCode, status);
      if (status === 503) {
        assert.equal(response.json().error, "intake_not_enabled");
        assert.equal(response.headers["retry-after"], "60");
      }
    }
  } finally {
    await app.close();
  }
});

test("signature binds raw bytes; missing, duplicate and malformed signatures fail closed", async () => {
  const app = createServer({
    channelSecret: secret,
    checkDatabase: async () => {},
  });
  try {
    const body = '{ "events": [] }';
    for (const signature of [
      undefined,
      sign('{"events":[]}'),
      "invalid",
      [sign(body), sign(body)],
    ]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/line/webhook",
        payload: body,
        headers: {
          "content-type": "application/json",
          ...(signature === undefined ? {} : { "x-line-signature": signature }),
        },
      });
      assert.equal(response.statusCode, 400);
      assert.deepEqual(response.json(), {
        ok: false,
        error: "invalid_line_signature",
      });
    }
    const valid = await app.inject({
      method: "POST",
      url: "/api/line/webhook",
      payload: body,
      headers: {
        "content-type": "application/json",
        "x-line-signature": sign(body),
      },
    });
    assert.equal(valid.statusCode, 200);
    const large = " ".repeat(1024 * 1024 + 1);
    const rejected = await app.inject({
      method: "POST",
      url: "/api/line/webhook",
      payload: large,
      headers: {
        "content-type": "application/json",
        "x-line-signature": sign(large),
      },
    });
    assert.equal(rejected.statusCode, 413);
    assert.doesNotMatch(rejected.body, /synthetic|stack|secret/);
  } finally {
    await app.close();
  }
});

test("liveness is independent; readiness exposes no database details", async () => {
  const app = createServer({
    channelSecret: secret,
    checkDatabase: async () => {
      throw new Error("postgres://private");
    },
  });
  try {
    assert.deepEqual((await app.inject("/healthz")).json(), { ok: true });
    const response = await app.inject("/readyz");
    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.json(), { ok: false });
    assert.equal(response.headers["cache-control"], "no-store");
    assert.equal(
      (await app.inject("/api/line/llm-auth/callback")).statusCode,
      404,
    );
  } finally {
    await app.close();
  }
});

test("empty channel secret cannot start the API", () => {
  assert.throws(() =>
    createServer({ channelSecret: "", checkDatabase: async () => {} }),
  );
});

test("enabled ingress waits for durable commits and returns retryable failure on partial batch", async () => {
  const bot = `U${"b".repeat(32)}`;
  let count = 0;
  const app = createServer({
    channelSecret: secret,
    checkDatabase: async () => {},
    intake: {
      botId: bot,
      ingest: async () => {
        count++;
        if (count === 2) throw new Error("database");
      },
    },
  });
  const event = {
    type: "message",
    webhookEventId: "one",
    timestamp: Date.now(),
    source: { type: "group", groupId: `C${"c".repeat(32)}` },
    message: { id: "message", type: "text", text: "text" },
  };
  const body = JSON.stringify({
    destination: bot,
    events: [event, { ...event, webhookEventId: "two" }],
  });
  const response = await app.inject({
    method: "POST",
    url: "/api/line/webhook",
    payload: body,
    headers: {
      "content-type": "application/json",
      "x-line-signature": sign(body),
    },
  });
  assert.equal(count, 2);
  assert.equal(response.statusCode, 503);
  assert.doesNotMatch(response.body, /database/);
  await app.close();
});

test("source callback requires its dedicated caller/token and fails closed on dependency loss", async () => {
  let calls = 0;
  const app = createServer({
    channelSecret: secret,
    checkDatabase: async () => {},
    sourceAccess: {
      checkBatch: async () => {
        calls++;
        throw new Error("database secret");
      },
      token: "a".repeat(64),
      check: async () => {
        calls++;
        throw new Error("database secret");
      },
    },
  });
  for (const route of ["/priv/source/check", "/priv/source/check-batch"])
    for (const [caller, token, status] of [
      ["asset-api", "a".repeat(64), 503],
      ["asset-api", "b".repeat(64), 403],
      ["hhc-line-function-bot", "a".repeat(64), 403],
    ] as const) {
      const response = await app.inject({
        method: "POST",
        url: route,
        payload: { version: 1, mode: "original" },
        headers: {
          "x-hhc-harness-service-caller": caller,
          "x-hhc-harness-service-token": token,
        },
      });
      assert.equal(response.statusCode, status);
      assert.doesNotMatch(response.body, /database|secret/);
    }
  assert.equal(calls, 2);
  await app.close();
});

test("member content proxy requires Authorization and preserves bounded Range metadata without forwarding credentials", async () => {
  const app = createServer({
    channelSecret: secret,
    checkDatabase: async () => {},
    content: {
      get: async (id, token, method, headers) => {
        assert.equal(id, "11111111-1111-4111-8111-111111111111");
        assert.equal(token, "line-token");
        assert.equal(method, "GET");
        assert.equal(headers.range, "bytes=0-3");
        return new Response("data", {
          status: 206,
          headers: {
            "content-type": "application/pdf",
            "content-range": "bytes 0-3/4",
            etag: "etag",
            "set-cookie": "do-not-forward",
          },
        });
      },
    },
  });
  const url = "/api/line/sources/11111111-1111-4111-8111-111111111111/content";
  assert.equal(
    (await app.inject({ url, headers: { "x-user-id": "admin" } })).statusCode,
    401,
  );
  const r = await app.inject({
    url,
    headers: { authorization: "Bearer line-token", range: "bytes=0-3" },
  });
  assert.equal(r.statusCode, 206);
  assert.equal(r.body, "data");
  assert.equal(r.headers["set-cookie"], undefined);
  assert.equal(r.headers["cache-control"], "private, no-store");
  await app.close();
});

test("management requires verified Gateway user, ignores no identity input and rejects unknown fields", async () => {
  const { Management } = await import("../src/domain/management.ts");
  let actor = "";
  const service = {
    groups: async (id: string) => {
      actor = id;
      return [];
    },
    setup: async () => ({ state: "draft" }),
    configure: async () => ({ state: "draft" }),
  } as unknown as InstanceType<typeof Management>;
  const app = createServer({
    channelSecret: "secret",
    checkDatabase: async () => {},
    management: { service, token: "d".repeat(64) },
  });
  const headers = {
    "x-hhc-harness-gateway-token": "d".repeat(64),
    "x-hhc-user-id": "11111111-1111-4111-8111-111111111111",
    "x-hhc-principal-type": "user",
    "x-hhc-auth-provider": "account-api",
  };
  assert.equal(
    (await app.inject({ method: "GET", url: "/api/line/harness/admin/groups" }))
      .statusCode,
    403,
  );
  assert.equal(
    (
      await app.inject({
        method: "GET",
        url: "/api/line/harness/admin/groups",
        headers: { ...headers, "x-hhc-principal-type": "service" },
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await app.inject({
        method: "GET",
        url: "/api/line/harness/admin/groups",
        headers,
      })
    ).statusCode,
    200,
  );
  assert.equal(actor, headers["x-hhc-user-id"]);
  assert.equal(
    (
      await app.inject({
        method: "PUT",
        url: "/api/line/harness/admin/setups/id",
        headers,
        payload: { sharing: false, userId: "forged" },
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await app.inject({
        method: "HEAD",
        url: "/api/line/harness/admin/groups",
        headers,
      })
    ).statusCode,
    404,
  );
  await app.close();
});
