import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "../src/bootstrap/server.ts";
const group = "11111111-1111-4111-8111-111111111111",
  job = "22222222-2222-4222-8222-222222222222";
test("search routes authenticate server-verified identity and reject actor injection", async () => {
  const calls: unknown[] = [];
  const app = createServer({
    channelSecret: "fixture",
    checkDatabase: async () => {},
    searchAccess: {
      identity: async (token) => {
        assert.equal(token, "fixture-id-token");
        return "verified-actor";
      },
      service: {
        start: async (...args: unknown[]) => {
          calls.push(args);
          return { id: job, generation: "1" };
        },
        read: async () => ({ state: "ready" }),
        reset: async () => {},
      },
    },
  });
  try {
    const url = `/api/line/harness/groups/${group}/search`;
    assert.equal(
      (await app.inject({ method: "POST", url, payload: { query: "排班" } }))
        .statusCode,
      401,
    );
    const response = await app.inject({
      method: "POST",
      url,
      payload: { query: "排班" },
      headers: { authorization: "Bearer fixture-id-token" },
    });
    assert.equal(response.statusCode, 202);
    assert.equal(response.headers["cache-control"], "private, no-store");
    assert.deepEqual(calls, [[group, "verified-actor", { query: "排班" }]]);
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url,
          payload: { query: "排班", actorId: "attacker" },
          headers: { authorization: "Bearer fixture-id-token" },
        })
      ).statusCode,
      400,
    );
  } finally {
    await app.close();
  }
});

test("real LINE identity denials are forbidden across member routes, while provider failure is retryable", async () => {
  const { LineIdentity } = await import("../src/providers/line-identity.ts");
  const routes = [
    ["POST", "search"],
    ["POST", "reset"],
    ["GET", `results/${job}`],
    ["POST", `sources/${job}/preview`],
    ["POST", `edits/${job}/confirm`],
  ] as const;
  for (const scenario of [
    400,
    401,
    403,
    "expired",
    "wrong-audience",
    "valid",
    500,
    "network",
  ] as const) {
    let calls = 0;
    const identity = new LineIdentity("123", async () => {
      if (scenario === "network") throw new Error("private upstream failure");
      const status = typeof scenario === "number" ? scenario : 200;
      return new Response(
        JSON.stringify(
          status === 200
            ? {
                iss: "https://access.line.me",
                aud: scenario === "wrong-audience" ? "456" : "123",
                sub: `U${"a".repeat(32)}`,
                exp: scenario === "expired" ? 1 : 4102444800,
              }
            : { error: "private provider body" },
        ),
        { status },
      );
    });
    const app = createServer({
      channelSecret: "fixture",
      checkDatabase: async () => {},
      searchAccess: {
        identity: (t) => identity.verify(t),
        service: {
          start: async () => {
            calls++;
            return { id: job, generation: "1" };
          },
          read: async () => {
            calls++;
            return { state: "ready" };
          },
          reset: async () => {
            calls++;
          },
        },
        edits: {
          preview: async () => {
            calls++;
            throw new Error("edit_forbidden");
          },
          confirm: async () => {
            calls++;
          },
        },
      },
    });
    try {
      for (const [method, path] of routes) {
        const result = await app.inject({
          method,
          url: `/api/line/harness/groups/${group}/${path}`,
          headers: { authorization: "Bearer fixture-id-token" },
          ...(method === "POST"
            ? {
                payload:
                  path === "search"
                    ? { query: "fixture" }
                    : path.includes("confirm")
                      ? { token: "fixture" }
                      : {},
              }
            : {}),
        });
        const expected =
          scenario === "valid"
            ? path === "search"
              ? 202
              : path.includes("preview")
                ? 403
                : 200
            : scenario === 500 || scenario === "network"
              ? 503
              : 403;
        assert.equal(result.statusCode, expected, `${scenario} ${path}`);
        assert.doesNotMatch(result.body, /private|fixture-id-token/);
        if (scenario !== "valid")
          assert.equal(
            result.json().error,
            expected === 403 ? "search_forbidden" : "search_unavailable",
          );
      }
      assert.equal(calls, scenario === "valid" ? 5 : 0);
    } finally {
      await app.close();
    }
  }
});
