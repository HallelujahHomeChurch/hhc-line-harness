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
