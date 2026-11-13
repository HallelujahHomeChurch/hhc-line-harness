import assert from "node:assert/strict";
import test from "node:test";
import { database, databaseEnabled } from "./database.ts";
import { Store } from "../src/persistence/store.ts";
import { ReplyTokenCipher } from "../src/reply/token.ts";
import { Search } from "../src/search/search.ts";
import { Conversations } from "../src/domain/conversations.ts";
const actor = "U" + "1".repeat(32),
  other = "U" + "3".repeat(32);
async function fixture(t: Parameters<typeof database>[0]) {
  const pool = await database(t);
  let now = new Date("2026-11-13T00:00:00Z");
  await pool.query("UPDATE runtime_state SET mode='open',ingest_floor=$1", [
    now,
  ]);
  const group = (
    await pool.query(
      "INSERT INTO groups(channel_id,line_group_id,state,active_from) VALUES('test',$1,'active',$2) RETURNING id",
      ["C" + "2".repeat(32), now],
    )
  ).rows[0].id as string;
  const store = new Store(
    pool,
    new ReplyTokenCipher("11".repeat(32)),
    "test",
    () => now,
  );
  const search = new Search(store, async () => true);
  const conversations = new Conversations(store, search);
  return {
    pool,
    group,
    store,
    search,
    conversations,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
  };
}
test(
  "durable query can be picked up repeatedly only by its requester; reset destroys its result",
  { skip: !databaseEnabled },
  async (t) => {
    const f = await fixture(t);
    const job = await f.conversations.start(f.group, actor, { query: "排班" });
    assert.equal((await f.conversations.read(job.id, actor)).state, "queued");
    assert.equal(await f.conversations.processOne(), true);
    assert.equal((await f.conversations.read(job.id, actor)).state, "ready");
    assert.equal((await f.conversations.read(job.id, actor)).state, "ready");
    await assert.rejects(f.conversations.read(job.id, other), /forbidden/);
    await f.conversations.reset(f.group, actor);
    await assert.rejects(f.conversations.read(job.id, actor), /gone/);
    assert.equal(
      (
        await f.pool.query(
          "SELECT result_ciphertext FROM search_jobs WHERE id=$1",
          [job.id],
        )
      ).rows[0].result_ciphertext,
      null,
    );
  },
);
test(
  "reset fences an in-flight search result and leaves shared originals alone",
  { skip: !databaseEnabled },
  async (t) => {
    const f = await fixture(t);
    const job = await f.conversations.start(f.group, actor, {
      query: "schedule",
    });
    const original = f.search.query.bind(f.search);
    f.search.query = async (...args) => {
      const value = await original(...args);
      await f.conversations.reset(f.group, actor);
      return value;
    };
    await f.conversations.processOne();
    await assert.rejects(f.conversations.read(job.id, actor), /gone/);
    assert.equal(
      (
        await f.pool.query(
          "SELECT result_ciphertext FROM search_jobs WHERE id=$1",
          [job.id],
        )
      ).rows[0].result_ciphertext,
      null,
    );
  },
);
test(
  "30 minute idle expiry and runtime generation fence reject old checkpoints and jobs",
  { skip: !databaseEnabled },
  async (t) => {
    const f = await fixture(t);
    const job = await f.conversations.start(f.group, actor, { query: "排班" });
    await f.conversations.processOne();
    f.advance(30 * 60_000);
    assert.equal((await f.conversations.read(job.id, actor)).state, "ready");
    const next = await f.conversations.start(f.group, actor, {
      query: "schedule",
    });
    assert.notEqual(next.generation, job.generation);
    await f.pool.query("UPDATE runtime_state SET generation=generation+1");
    await assert.rejects(f.conversations.read(next.id, actor), /gone/);
  },
);
test(
  "query status checks do not extend idle lifetime or result expiry",
  { skip: !databaseEnabled },
  async (t) => {
    const f = await fixture(t);
    const job = await f.conversations.start(f.group, actor, { query: "排班" });
    await f.conversations.processOne();
    const before = (
      await f.pool.query("SELECT expires_at FROM search_jobs WHERE id=$1", [
        job.id,
      ])
    ).rows[0].expires_at;
    f.advance(29 * 60_000);
    await f.conversations.read(job.id, actor);
    f.advance(60_000);
    assert.equal((await f.conversations.read(job.id, actor)).state, "ready");
    const session = (
      await f.pool.query("SELECT last_interaction_at FROM conversations")
    ).rows[0];
    assert.equal(
      session.last_interaction_at.getTime(),
      new Date("2026-11-13T00:00:00Z").getTime(),
    );
    f.advance(24 * 3600_000);
    await assert.rejects(f.conversations.read(job.id, actor), /gone/);
    assert.equal(
      (
        await f.pool.query("SELECT expires_at FROM search_jobs WHERE id=$1", [
          job.id,
        ])
      ).rows[0].expires_at.getTime(),
      before.getTime(),
    );
  },
);

test(
  "a revoked saved result cannot reserve a Reply after the read already returned",
  { skip: !databaseEnabled },
  async (t) => {
    const f = await fixture(t);
    const { Deliveries } = await import("../src/reply/deliveries.ts");
    const job = await f.conversations.start(f.group, actor, {
      query: "schedule",
    });
    await f.conversations.processOne();
    const session = (await f.pool.query("SELECT * FROM conversations")).rows[0];
    const deliveries = new Deliveries(f.store);
    const id = await f.store.transaction((c) =>
      deliveries.create(c, {
        eventId: "pickup",
        token: "fixture-token",
        publishedAt: f.store.now(),
        actorId: actor,
        groupId: f.group,
        groupRevision: "1",
      }),
    );
    await f.pool.query(
      "UPDATE deliveries SET conversation_id=$2,conversation_generation=$3,search_result_id=$4 WHERE id=$1",
      [id, session.id, session.generation, job.id],
    );
    await deliveries.prepare(id!, "formerly accessible result");
    await f.pool.query(
      "UPDATE search_jobs SET state='cancelled',result_ciphertext=NULL WHERE id=$1",
      [job.id],
    );
    assert.equal(await deliveries.reserve(id!), undefined);
  },
);

test(
  "encrypted checkpoints are requester-scoped and late workers cannot restore them after reset",
  { skip: !databaseEnabled },
  async (t) => {
    const f = await fixture(t);
    const job = await f.conversations.start(f.group, actor, { query: "排班" });
    await f.conversations.saveCheckpoint(
      f.group,
      actor,
      job.generation,
      { note: "private fixture" },
      [],
    );
    assert.deepEqual(
      (await f.conversations.checkpoint(f.group, actor))?.value,
      { note: "private fixture" },
    );
    assert.equal(await f.conversations.checkpoint(f.group, other), undefined);
    const stored = (
      await f.pool.query("SELECT checkpoint_ciphertext FROM conversations")
    ).rows[0].checkpoint_ciphertext;
    assert.ok(stored && !stored.includes("private fixture"));
    await f.conversations.reset(f.group, actor);
    await assert.rejects(
      f.conversations.saveCheckpoint(
        f.group,
        actor,
        job.generation,
        { note: "late" },
        [],
      ),
      /gone/,
    );
    assert.equal(await f.conversations.checkpoint(f.group, actor), undefined);
  },
);
test(
  "only explicit natural-language jobs invoke the Agent and reset invalidates its in-flight authority",
  { skip: !databaseEnabled },
  async (t) => {
    const f = await fixture(t);
    let calls = 0;
    const conversations = new Conversations(f.store, f.search, {
      query: async (_id, group, who, input, valid) => {
        calls++;
        await valid();
        await conversations.reset(group, who);
        await assert.rejects(valid, /search_gone/);
        return f.search.query(group, who, input);
      },
    });
    const basic = await conversations.start(f.group, actor, { query: "排班" });
    await conversations.processOne();
    assert.equal(calls, 0);
    assert.equal((await conversations.read(basic.id, actor)).state, "ready");
    const natural = await conversations.start(
      f.group,
      actor,
      { query: "幫我找排班" },
      undefined,
      undefined,
      true,
    );
    await conversations.processOne();
    assert.equal(calls, 1);
    await assert.rejects(conversations.read(natural.id, actor), /search_gone/);
  },
);
test(
  "follow-up Agent jobs receive only fresh prior candidates from their own conversation",
  { skip: !databaseEnabled },
  async (t) => {
    const f = await fixture(t);
    const source = (
      await f.pool.query(
        "INSERT INTO sources(group_id,message_id,author_id,kind,body,published_at,expires_at,state) VALUES($1,'fixture',$2,'text','敬拜排班',$3,$3::timestamptz+interval '90 days','ready') RETURNING id",
        [f.group, actor, f.store.now()],
      )
    ).rows[0].id;
    let previous: string[] = [];
    const conversations = new Conversations(f.store, f.search, {
      query: async (_id, group, who, input, valid, _excluded, context) => {
        await valid();
        previous = context?.items.map((i) => i.id) ?? [];
        return context ?? f.search.query(group, who, input);
      },
    });
    await conversations.start(f.group, actor, { query: "敬拜" });
    await conversations.processOne();
    const next = await conversations.start(
      f.group,
      actor,
      { query: "第一份" },
      undefined,
      undefined,
      true,
    );
    await conversations.processOne();
    assert.deepEqual(previous, [source]);
    assert.equal(
      (await conversations.read(next.id, actor)).result?.items[0]?.id,
      source,
    );
    await conversations.reset(f.group, actor);
    await conversations.start(
      f.group,
      actor,
      { query: "第一份" },
      undefined,
      undefined,
      true,
    );
    await conversations.processOne();
    assert.deepEqual(previous, []);
  },
);
test(
  "withdrawing a queued question erases its request and prevents the Agent from processing it",
  { skip: !databaseEnabled },
  async (t) => {
    const f = await fixture(t);
    const id = (
      await f.pool.query(
        "INSERT INTO sources(group_id,message_id,author_id,kind,body,published_at,expires_at,state) VALUES($1,'question',$2,'text','我的問題',$3,$3::timestamptz+interval '90 days','ready') RETURNING id",
        [f.group, actor, f.store.now()],
      )
    ).rows[0].id;
    const job = await f.conversations.start(
      f.group,
      actor,
      { query: "我的問題" },
      undefined,
      id,
      true,
    );
    const { invalidate } = await import("../src/domain/lifecycle.ts");
    await f.store.transaction((c) =>
      invalidate(c, id, f.store.now(), "revoked"),
    );
    const row = (
      await f.pool.query(
        "SELECT state,request_ciphertext FROM search_jobs WHERE id=$1",
        [job.id],
      )
    ).rows[0];
    assert.equal(row.state, "cancelled");
    assert.equal(row.request_ciphertext, null);
  },
);
