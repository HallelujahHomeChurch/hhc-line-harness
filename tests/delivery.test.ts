import assert from "node:assert/strict";
import { test } from "node:test";
import { database, databaseEnabled } from "./database.ts";
import { Store } from "../src/persistence/store.ts";
import { ReplyTokenCipher } from "../src/reply/token.ts";
import { Deliveries } from "../src/reply/deliveries.ts";
const initial = new Date("2026-11-12T12:00:00Z");
async function fixture(t: Parameters<typeof database>[0]) {
  const pool = await database(t);
  let now = initial;
  const store = new Store(
    pool,
    new ReplyTokenCipher("a".repeat(64)),
    "channel",
    () => now,
  );
  await pool.query("UPDATE runtime_state SET mode='open'");
  const replies = new Deliveries(store);
  const id = await store.transaction((client) =>
    replies.create(client, {
      eventId: "event",
      token: "secret-token",
      publishedAt: initial,
    }),
  );
  assert.ok(id);
  await replies.prepare(id, "回覆內容");
  return {
    pool,
    replies,
    id,
    advance: () => {
      now = new Date(initial.getTime() + 60_000);
    },
  };
}
test(
  "Reply reservation is durable and only one process can send",
  { skip: !databaseEnabled },
  async (t) => {
    const { pool, replies, id } = await fixture(t);
    let calls = 0;
    const send = async (token: string, text: string) => {
      assert.equal(token, "secret-token");
      assert.equal(text, "回覆內容");
      calls++;
    };
    await Promise.all(
      Array.from({ length: 5 }, () => replies.deliver(id, send)),
    );
    assert.equal(calls, 1);
    const row = (
      await pool.query("SELECT state,token_ciphertext,body FROM deliveries")
    ).rows[0];
    assert.deepEqual(row, {
      state: "delivered",
      token_ciphertext: null,
      body: null,
    });
  },
);
test(
  "unknown network result and reserved-before-network crash never retry",
  { skip: !databaseEnabled },
  async (t) => {
    const { pool, replies, id } = await fixture(t);
    let calls = 0;
    await replies.deliver(id, async () => {
      calls++;
      throw new Error("unknown");
    });
    await replies.deliver(id, async () => {
      calls++;
    });
    assert.equal(calls, 1);
    assert.equal(
      (await pool.query("SELECT state FROM deliveries")).rows[0].state,
      "unknown",
    );
    await pool.query("UPDATE deliveries SET state='attempt_reserved'");
    await replies.deliver(id, async () => {
      calls++;
    });
    assert.equal(calls, 1);
  },
);
test(
  "expired pending Reply clears secrets and sends nothing",
  { skip: !databaseEnabled },
  async (t) => {
    const { pool, replies, id, advance } = await fixture(t);
    advance();
    await replies.deliver(id, async () => {
      assert.fail("expired send");
    });
    assert.equal(
      (await pool.query("SELECT state FROM deliveries")).rows[0].state,
      "expired",
    );
  },
);
