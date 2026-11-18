import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { database, databaseEnabled } from "./database.ts";
import { Store } from "../src/persistence/store.ts";
import { ReplyTokenCipher } from "../src/reply/token.ts";
import { Registration } from "../src/domain/registration.ts";
import { Interactions } from "../src/domain/interactions.ts";
import { Conversations } from "../src/domain/conversations.ts";
import { Search } from "../src/search/search.ts";
import type { HarnessAgent } from "../src/agent/agent.ts";
import type { ReplyAction } from "../src/providers/line.ts";

const actor = `U${"1".repeat(32)}`,
  lineGroup = `C${"2".repeat(32)}`;
async function fixture(
  t: Parameters<typeof database>[0],
  query: HarnessAgent["query"],
) {
  const pool = await database(t);
  let now = new Date("2026-11-18T00:00:00Z");
  await pool.query("UPDATE runtime_state SET mode='open',ingest_floor=$1", [
    now,
  ]);
  const group = (
    await pool.query(
      "INSERT INTO groups(channel_id,line_group_id,state,active_from) VALUES('chat',$1,'active',$2) RETURNING id",
      [lineGroup, now],
    )
  ).rows[0].id;
  const store = new Store(
    pool,
    new ReplyTokenCipher("11".repeat(32)),
    "chat",
    () => now,
  );
  const search = new Search(store, async () => true);
  const conversations = new Conversations(store, search, { query });
  const sent: { text: string; actions?: ReplyAction[] }[] = [];
  const send = async (
    _token: string,
    text: string,
    actions?: ReplyAction[],
  ) => {
    sent.push({ text, actions });
  };
  const registration = new Registration(store, {
    authority: async () => {
      throw Error("not a setup request");
    },
    member: async () => true,
    collection: async () => {
      throw Error("unused");
    },
    send,
  });
  const interactions = new Interactions(store, registration, {
    conversations,
    send,
    binding: async () => "",
    finalize: async () => {},
    adminOrigin: "https://admin.invalid",
    liffId: "123456-test",
  });
  return {
    pool,
    store,
    conversations,
    interactions,
    sent,
    group,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
    ask: async (text: string, user = actor) => {
      await store.ingest(
        {
          id: randomUUID(),
          type: "message",
          scope: "group",
          scopeId: lineGroup,
          actorId: user,
          publishedAt: now,
          replyToken: randomUUID(),
          message: { id: randomUUID(), type: "text", text, mentionsBot: true },
        },
        (c, e, g) => interactions.record(c, e, g),
      );
    },
  };
}

test(
  "a completed conversation replies directly once without an acceptance message or URL",
  { skip: !databaseEnabled },
  async (t) => {
    const f = await fixture(t, async () => ({
      status: "success",
      items: [],
      gaps: [],
      answer: "嗨！今天想聊什麼？",
    }));
    await f.ask("Hi");
    await f.interactions.processOne();
    assert.equal(f.sent.length, 0);
    assert.equal(await f.interactions.processOne(), false);
    await f.conversations.processOne();
    await f.interactions.processOne();
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0]!.text, "嗨！今天想聊什麼？");
    assert.equal(f.sent[0]!.actions?.length ?? 0, 0);
    await f.interactions.processOne();
    assert.equal(f.sent.length, 1);
  },
);

test(
  "slow answers use one pickup action after the deadline without blocking another actor",
  { skip: !databaseEnabled },
  async (t) => {
    const f = await fixture(t, async () => ({
      status: "success",
      items: [],
      gaps: [],
      answer: "結果",
    }));
    await f.ask("幫我整理這段內容");
    await f.interactions.processOne();
    await f.ask("Hi", `U${"3".repeat(32)}`);
    assert.equal(await f.interactions.processOne(), true);
    assert.equal(
      (await f.pool.query("SELECT count(*)::int n FROM search_jobs")).rows[0].n,
      2,
    );
    assert.equal(f.sent.length, 0);
    f.advance(20000);
    await f.interactions.processOne();
    assert.equal(f.sent.length, 1);
    assert.match(f.sent[0]!.actions![0]!.data!, /^search:get:/);
    assert.doesNotMatch(f.sent[0]!.text, /https?:/);
    await f.conversations.processOne();
    assert.equal(f.sent.length, 1);
  },
);

test(
  "natural questions containing setup or search words remain conversations and are not truncated",
  { skip: !databaseEnabled },
  async (t) => {
    let received = "";
    const f = await fixture(t, async (_id, _group, _actor, input) => {
      received = input.query;
      return {
        status: "success",
        items: [],
        gaps: [],
        answer: "可以一起討論。",
      };
    });
    const question =
      "我想討論搜尋功能的設定方式，" + "請保留這段完整問題。".repeat(40);
    await f.ask(question);
    await f.interactions.processOne();
    await f.conversations.processOne();
    await f.interactions.processOne();
    assert.equal(received, question);
    assert.equal(f.sent[0]?.text, "可以一起討論。");
  },
);

test(
  "follow-up conversation retains bounded text and remains isolated by requester",
  { skip: !databaseEnabled },
  async (t) => {
    const histories: unknown[] = [];
    const f = await fixture(t, async (...args) => {
      histories.push(args[7]);
      return {
        status: "success",
        items: [],
        gaps: [],
        answer: "先分成兩個步驟。",
      };
    });
    for (const question of ["我要準備一次分享", "第二個步驟詳細一點"]) {
      await f.ask(question);
      await f.interactions.processOne();
      await f.conversations.processOne();
      await f.interactions.processOne();
    }
    assert.deepEqual(histories[1], [
      { user: "我要準備一次分享", assistant: "先分成兩個步驟。" },
    ]);
    await f.ask("Hi", `U${"3".repeat(32)}`);
    await f.interactions.processOne();
    await f.conversations.processOne();
    await f.interactions.processOne();
    assert.deepEqual(histories[2], []);
    await f.conversations.reset(f.group, actor);
    await f.ask("重新開始");
    await f.interactions.processOne();
    await f.conversations.processOne();
    await f.interactions.processOne();
    assert.deepEqual(histories[3], []);
  },
);

test(
  "changed source evidence clears derived conversational history before the next answer",
  { skip: !databaseEnabled },
  async (t) => {
    const histories: unknown[] = [];
    const f = await fixture(t, async (...args) => {
      histories.push(args[7]);
      const source = (
        await f.pool.query(
          "SELECT id,revision,description_revision,expires_at FROM sources WHERE message_id='evidence'",
        )
      ).rows[0];
      return {
        status: "success",
        items: [],
        gaps: [],
        answer: "整理完成。",
        dependencies: [
          {
            id: source.id,
            revision: source.revision,
            descriptionRevision: source.description_revision,
            expiresAt: source.expires_at.toISOString(),
          },
        ],
      };
    });
    await f.pool.query(
      "INSERT INTO sources(group_id,message_id,author_id,kind,body,published_at,expires_at,state) VALUES($1,'evidence',$2,'text','測試資料',$3,$3::timestamptz+interval '90 days','ready')",
      [f.group, actor, f.store.now()],
    );
    await f.ask("整理資料");
    await f.interactions.processOne();
    await f.conversations.processOne();
    await f.interactions.processOne();
    await f.pool.query(
      "UPDATE sources SET description_revision=description_revision+1 WHERE message_id='evidence'",
    );
    await f.ask("繼續");
    await f.interactions.processOne();
    await f.conversations.processOne();
    await f.interactions.processOne();
    assert.deepEqual(histories[1], []);
    assert.equal(f.sent.length, 2);
  },
);

test(
  "a full evidence context starts fresh before the model instead of permanently failing later turns",
  { skip: !databaseEnabled },
  async (t) => {
    const histories: unknown[] = [];
    const f = await fixture(t, async (...args) => {
      histories.push(args[7]);
      const sources =
        histories.length === 1
          ? (
              await f.pool.query(
                "SELECT id,revision,description_revision,expires_at FROM sources WHERE message_id LIKE 'evidence-%'",
              )
            ).rows
          : [];
      return {
        status: "success",
        items: [],
        gaps: [],
        answer: "這是回答。",
        dependencies: sources.map((source) => ({
          id: source.id,
          revision: source.revision,
          descriptionRevision: source.description_revision,
          expiresAt: source.expires_at.toISOString(),
        })),
      };
    });
    await f.pool.query(
      "INSERT INTO sources(group_id,message_id,author_id,kind,body,published_at,expires_at,state) SELECT $1,'evidence-'||n,$2,'text','資料',$3,$3::timestamptz+interval '90 days','ready' FROM generate_series(1,25) n",
      [f.group, actor, f.store.now()],
    );
    for (const text of ["整理資料", "現在聊別的"]) {
      await f.ask(text);
      await f.interactions.processOne();
      await f.conversations.processOne();
      await f.interactions.processOne();
    }
    assert.deepEqual(histories[1], []);
    assert.equal(f.sent.length, 2);
    assert.equal(
      (
        await f.pool.query(
          "SELECT count(*)::int n FROM search_jobs WHERE state='ready'",
        )
      ).rows[0].n,
      2,
    );
  },
);
