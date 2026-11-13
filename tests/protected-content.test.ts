import assert from "node:assert/strict";
import { test } from "node:test";
import { database, databaseEnabled } from "./database.ts";
import { Store } from "../src/persistence/store.ts";
import { ReplyTokenCipher } from "../src/reply/token.ts";
import { ProtectedContent } from "../src/domain/protected-content.ts";
import { LineIdentity } from "../src/providers/line-identity.ts";
const now = new Date("2026-11-12T12:00:00Z"),
  group = `C${"c".repeat(32)}`,
  actor = `U${"a".repeat(32)}`;
test(
  "protected original requires current verified LINE identity and group membership, independently of Account",
  { skip: !databaseEnabled },
  async (t) => {
    const pool = await database(t);
    await pool.query("UPDATE runtime_state SET mode='open',ingest_floor=$1", [
      now,
    ]);
    await pool.query(
      "INSERT INTO groups(channel_id,line_group_id,state,active_from) VALUES('channel',$1,'active',$2)",
      [group, now],
    );
    const store = new Store(
      pool,
      new ReplyTokenCipher("a".repeat(64)),
      "channel",
      () => now,
    );
    await store.ingest({
      id: "e",
      type: "message",
      scope: "group",
      scopeId: group,
      publishedAt: now,
      message: {
        id: "m",
        type: "file",
        fileName: "file.pdf",
        mentionsBot: false,
      },
    });
    await pool.query(
      "UPDATE sources SET state='ready',asset_id='11111111-1111-4111-8111-111111111111',asset_etag='etag'",
    );
    const id = (await pool.query("SELECT id FROM sources")).rows[0].id;
    let member = true,
      opens = 0;
    const content = new ProtectedContent(store, {
      identity: async (token) => {
        assert.equal(token, "signed-token");
        return actor;
      },
      member: async (g, u) => {
        assert.equal(g, group);
        assert.equal(u, actor);
        return member;
      },
      open: async (_asset, method, headers) => {
        opens++;
        assert.equal(method, "GET");
        assert.equal(headers.range, "bytes=0-3");
        return new Response("data", {
          status: 206,
          headers: { etag: "etag", "content-range": "bytes 0-3/4" },
        });
      },
    });
    assert.equal(
      (await content.get(id, "signed-token", "GET", { range: "bytes=0-3" }))
        .status,
      206,
    );
    member = false;
    await assert.rejects(
      content.get(id, "signed-token", "HEAD", {}),
      /content_forbidden/,
    );
    assert.equal(opens, 1);
    member = true;
    await pool.query("UPDATE groups SET state='paused'");
    await assert.rejects(
      content.get(id, "signed-token", "GET", {}),
      /content_paused/,
    );
  },
);
test("LINE identity rejects wrong audience, issuer and expired token claims", async () => {
  const claims = {
    iss: "https://access.line.me",
    aud: "123",
    sub: actor,
    exp: now.getTime() / 1000 + 60,
  };
  for (const patch of [
    {},
    { aud: "other" },
    { iss: "https://attacker.invalid" },
    { exp: 1 },
  ]) {
    const identity = new LineIdentity(
      "123",
      async (_url, init) => {
        assert.equal(
          new Headers(init?.headers).get("content-type"),
          "application/x-www-form-urlencoded",
        );
        return Response.json({ ...claims, ...patch });
      },
      () => now,
    );
    if (Object.keys(patch).length)
      await assert.rejects(identity.verify("signed-token"));
    else assert.equal(await identity.verify("signed-token"), actor);
  }
});
