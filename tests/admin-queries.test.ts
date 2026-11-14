import assert from "node:assert/strict";
import test from "node:test";
import { database, databaseEnabled } from "./database.ts";
import { Store } from "../src/persistence/store.ts";
import { ReplyTokenCipher } from "../src/reply/token.ts";
import { AdminQueries } from "../src/domain/admin-queries.ts";
import { Registration } from "../src/domain/registration.ts";
import { Management } from "../src/domain/management.ts";
const actor = "U" + "1".repeat(32),
  other = "U" + "2".repeat(32);
async function fixture(t: Parameters<typeof database>[0]) {
  const pool = await database(t);
  await pool.query("UPDATE runtime_state SET mode='open'");
  let now = new Date();
  const store = new Store(
      pool,
      new ReplyTokenCipher("a".repeat(64)),
      "fixture",
      () => now,
    ),
    authority = {
      allowed: true,
      bound: true,
      actorUserId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      bindingGeneration: 1,
      adminAuthorizationRevision: 1,
    };
  const registration = new Registration(store, {
    authority: async () => authority,
    member: async () => {
      throw new Error("no group content");
    },
    collection: async () => {
      throw new Error("unused");
    },
    send: async () => {
      throw new Error("no unsolicited send");
    },
  });
  const management = new Management(store, registration, {
    authority: async () => authority,
  });
  let executions = 0;
  const queries = new AdminQueries(store, management, {
    admin: async (_id, _actor, _query, _management, valid) => {
      await valid();
      executions++;
      return { groups: [] };
    },
  });
  return {
    pool,
    queries,
    authority,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
    executions: () => executions,
  };
}
test(
  "Admin work persists encrypted results for explicit owner pickup without rerunning the Agent",
  { skip: !databaseEnabled },
  async (t) => {
    const f = await fixture(t);
    const job = await f.queries.start(actor, "顯示管理狀態");
    assert.equal((await f.queries.read(job.id, actor)).state, "queued");
    assert.equal(await f.queries.processOne(), true);
    assert.equal((await f.queries.read(job.id, actor)).state, "ready");
    assert.equal((await f.queries.read(job.id, actor)).state, "ready");
    assert.equal(f.executions(), 1);
    await assert.rejects(
      f.queries.read(job.id, other),
      /admin_query_forbidden/,
    );
    f.authority.bindingGeneration++;
    await assert.rejects(f.queries.read(job.id, actor), /admin_query_changed/);
  },
);
test(
  "Admin reset and runtime restore generation revoke previous jobs; idle interaction does not extend ready result expiry",
  { skip: !databaseEnabled },
  async (t) => {
    const f = await fixture(t),
      job = await f.queries.start(actor, "群組狀態");
    await f.queries.processOne();
    f.advance(31 * 60000);
    await f.queries.start(actor, "最新狀態");
    assert.equal((await f.queries.read(job.id, actor)).state, "ready");
    await f.queries.reset(actor);
    await assert.rejects(f.queries.read(job.id, actor), /admin_query_changed/);
    const next = await f.queries.start(actor, "群組狀態");
    await f.pool.query("UPDATE runtime_state SET generation=generation+1");
    await assert.rejects(f.queries.read(next.id, actor), /admin_query_changed/);
  },
);
test(
  "reset cancels a prepared Admin result before its Reply token can be reserved",
  { skip: !databaseEnabled },
  async (t) => {
    const f = await fixture(t);
    const { Deliveries } = await import("../src/reply/deliveries.ts");
    const deliveries = new Deliveries(f.queries.store);
    const job = await f.queries.start(actor, "群組狀態");
    await f.queries.processOne();
    const session = (await f.pool.query("SELECT * FROM admin_conversations"))
      .rows[0];
    const delivery = await f.queries.store.transaction((c) =>
      deliveries.create(c, {
        eventId: "pickup",
        token: "synthetic",
        publishedAt: f.queries.store.now(),
        actorId: actor,
        scopeId: actor,
      }),
    );
    await f.pool.query(
      "UPDATE deliveries SET admin_conversation_id=$2,admin_conversation_generation=$3,admin_query_id=$4 WHERE id=$1",
      [delivery, session.id, session.generation, job.id],
    );
    await deliveries.prepare(delivery!, "metadata ready");
    await f.pool.query(
      "UPDATE admin_queries SET state='cancelled' WHERE id=$1",
      [job.id],
    );
    assert.equal(await deliveries.reserve(delivery!), undefined);
  },
);
test(
  "private natural-language intake and repeated pickup use fresh Reply tokens and never rerun background work",
  { skip: !databaseEnabled },
  async (t) => {
    const f = await fixture(t);
    const { Interactions } = await import("../src/domain/interactions.ts");
    const replies: {
      text: string;
      actions?: { label: string; data: string }[];
    }[] = [];
    const interactions = new Interactions(
      f.queries.store,
      f.queries.management.registration,
      {
        adminQueries: f.queries,
        management: f.queries.management,
        binding: async () => {
          throw new Error("bound");
        },
        finalize: async () => {},
        send: async (_token, text, actions) => {
          replies.push({ text, actions });
        },
        adminOrigin: "https://admin.invalid",
      },
    );
    const ingest = async (id: string, postback?: string) => {
      await f.queries.store.ingest(
        {
          id,
          type: postback ? "postback" : "message",
          scope: "user",
          scopeId: actor,
          actorId: actor,
          publishedAt: f.queries.store.now(),
          replyToken: id,
          ...(postback
            ? { postback }
            : {
                message: {
                  id,
                  type: "text",
                  text: "列出群組狀態",
                  mentionsBot: false,
                },
              }),
        },
        (c, e, g) => interactions.record(c, e, g),
      );
      await interactions.processOne();
    };
    await ingest("one");
    assert.match(replies[0]!.text, /已受理管理查詢/);
    assert.equal(f.executions(), 0);
    await f.queries.processOne();
    assert.equal(replies.length, 1);
    const button = replies[0]!.actions![0]!.data;
    await ingest("two", button);
    await ingest("three", button);
    assert.equal(replies.length, 3);
    assert.equal(f.executions(), 1);
    assert.match(replies[1]!.text, /僅狀態/);
  },
);
test(
  "private follow-ups carry only previous management metadata and reset clears it",
  { skip: !databaseEnabled },
  async (t) => {
    const f = await fixture(t);
    const group = (
      await f.pool.query(
        "INSERT INTO groups(channel_id,line_group_id,state,display_name) VALUES('fixture',$1,'paused','fixture group') RETURNING id,revision",
        ["C" + "3".repeat(32)],
      )
    ).rows[0];
    let calls = 0,
      prior = 0;
    const queries = new AdminQueries(f.queries.store, f.queries.management, {
      admin: async (_id, _actor, _query, _management, valid, previous) => {
        await valid();
        calls++;
        prior = previous?.groups.length ?? 0;
        return {
          groups: [
            {
              id: group.id,
              name: "fixture group",
              state: "paused",
              revision: group.revision,
              sourceCount: 0,
              failedCount: 0,
            },
          ],
        };
      },
    });
    await queries.start(actor, "群組狀態");
    await queries.processOne();
    assert.equal(prior, 0);
    await queries.start(actor, "第一個群組");
    await queries.processOne();
    assert.equal(prior, 1);
    await queries.reset(actor);
    await queries.start(actor, "第一個群組");
    await queries.processOne();
    assert.equal(prior, 0);
    assert.equal(calls, 3);
  },
);
