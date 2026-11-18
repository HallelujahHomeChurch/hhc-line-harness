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
import { Usage, type Model } from "@openai/agents";
import { SourceEdits } from "../src/domain/source-edits.ts";
import { HarnessAgent } from "../src/agent/agent.ts";
import type { ReplyAction } from "../src/providers/line.ts";

const actor = `U${"1".repeat(32)}`,
  lineGroup = `C${"2".repeat(32)}`;
import { GroupTurns } from "../src/domain/group-turns.ts";
async function fixture(
  t: Parameters<typeof database>[0],
  query: HarnessAgent["query"],
  enabled = true,
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
  const conversations = new Conversations(
    store,
    search,
    { query },
    new GroupTurns(store, search, enabled ? [group] : []),
  );
  const sent: { text: string; actions?: ReplyAction[] }[] = [];
  const send = async (
    _token: string,
    text: string,
    actions?: ReplyAction[],
  ) => {
    sent.push({ text, actions });
    return { messageIds: [`sent-${sent.length}`] };
  };
  const registration = new Registration(store, {
    authority: async () => {
      throw Error("not a setup request");
    },
    member: async () => true,
    collection: async () => {
      throw Error("unused");
    },
    send: async (token, text) => {
      await send(token, text);
    },
  });
  const interactions = new Interactions(store, registration, {
    conversations,
    groupTurns: conversations.groupTurns,
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
    ask: async (
      text: string,
      user = actor,
      mentionsBot = true,
      quotedMessageId?: string,
      mentionsOthers = false,
    ) => {
      now = new Date(now.getTime() + 1000);
      await store.ingest(
        {
          id: randomUUID(),
          type: "message",
          scope: "group",
          scopeId: lineGroup,
          actorId: user,
          publishedAt: now,
          replyToken: randomUUID(),
          message: {
            id: randomUUID(),
            type: "text",
            text,
            mentionsBot,
            quotedMessageId,
            mentionsOthers,
          },
        },
        (c, e, g) => interactions.record(c, e, g),
      );
    },
  };
}

const answer: HarnessAgent["query"] = async () => ({
  status: "success",
  items: [],
  gaps: [],
  answer: "這是一份草稿。",
  turn: { kind: "answer", followUp: "continue" },
});
async function finish(f: Awaited<ReturnType<typeof fixture>>) {
  await f.interactions.processOne();
  await f.conversations.processOne();
  await f.interactions.processOne();
}
test(
  "same speaker second question without mention uses a delivered public answer",
  { skip: !databaseEnabled },
  async (t) => {
    const history: unknown[] = [];
    const f = await fixture(t, async (...args) => {
      history.push(args[7]);
      return answer(...args);
    });
    await f.ask("@小哈 Hi");
    await finish(f);
    await f.ask("你能幫我做什麼？", actor, false);
    await finish(f);
    assert.equal(f.sent.length, 2);
    assert.ok(JSON.stringify(history[1]).includes("這是一份草稿"));
  },
);
test(
  "cross-speaker public reference is a candidate but explicit peer chat runs no model",
  { skip: !databaseEnabled },
  async (t) => {
    let calls = 0;
    const f = await fixture(t, async (...args) => {
      calls++;
      return answer(...args);
    });
    await f.ask("@小哈 寫一份草稿");
    await finish(f);
    await f.ask("把那份草稿改短", `U${"3".repeat(32)}`, false);
    await finish(f);
    assert.equal(calls, 2);
    await f.ask("@阿明，你覺得呢？", actor, false, "sent-2", true);
    await finish(f);
    assert.equal(calls, 2);
    assert.equal(f.sent.length, 2);
  },
);
test(
  "unknown delivery never enables implicit continuation, including original actor",
  { skip: !databaseEnabled },
  async (t) => {
    const f = await fixture(t, answer);
    f.interactions.ports.send = async () => {
      throw Error("unknown");
    };
    await f.ask("@小哈 Hi");
    await finish(f);
    await f.ask("你能幫我做什麼？", actor, false);
    await finish(f);
    assert.equal(
      (await f.pool.query("SELECT count(*)::int n FROM search_jobs")).rows[0].n,
      1,
    );
    assert.equal(
      (await f.pool.query("SELECT count(*)::int n FROM group_turns")).rows[0].n,
      0,
    );
  },
);
test(
  "disabled rollout keeps ordinary second messages silent",
  { skip: !databaseEnabled },
  async (t) => {
    const f = await fixture(t, answer, false);
    await f.ask("@小哈 Hi");
    await finish(f);
    await f.ask("你能幫我做什麼？", actor, false);
    await finish(f);
    assert.equal(f.sent.length, 1);
  },
);
test(
  "private pickup never sends the result body into the group",
  { skip: !databaseEnabled },
  async (t) => {
    const f = await fixture(t, answer);
    await f.ask("@小哈 問題");
    await finish(f);
    const id = (await f.pool.query("SELECT id FROM search_jobs")).rows[0].id;
    await f.store.ingest(
      {
        id: randomUUID(),
        type: "postback",
        scope: "group",
        scopeId: lineGroup,
        actorId: actor,
        publishedAt: f.store.now(),
        replyToken: "pickup",
        postback: `search:get:${id}`,
      },
      (c, e, g) => f.interactions.record(c, e, g),
    );
    await f.interactions.processOne();
    assert.equal(f.sent.length, 2);
    assert.doesNotMatch(f.sent[1]!.text, /這是一份草稿/);
    assert.match(f.sent[1]!.actions![0]!.uri!, /^https:\/\/liff.line.me\//);
    await assert.rejects(
      f.conversations.read(id, `U${"3".repeat(32)}`, f.group),
      /search_forbidden/,
    );
    assert.equal(
      (await f.pool.query("SELECT count(*)::int n FROM group_turns")).rows[0].n,
      1,
    );
  },
);
test(
  "reset closes implicit follow-up but explicit quoting can start a new turn",
  { skip: !databaseEnabled },
  async (t) => {
    const f = await fixture(t, answer);
    await f.ask("@小哈 問題");
    await finish(f);
    f.advance(1);
    await f.conversations.reset(f.group, actor);
    await f.ask("你能幫我做什麼？", actor, false);
    await finish(f);
    assert.equal(f.sent.length, 1);
    await f.ask("把它改短", actor, false, "sent-1");
    await finish(f);
    assert.equal(f.sent.length, 2);
  },
);
test(
  "revoking a question immediately invalidates its derived public answer",
  { skip: !databaseEnabled },
  async (t) => {
    const f = await fixture(t, answer);
    await f.ask("@小哈 問題");
    await finish(f);
    const message = (
      await f.pool.query(
        "SELECT message_id FROM sources WHERE body='@小哈 問題'",
      )
    ).rows[0].message_id;
    await f.store.ingest({
      id: randomUUID(),
      type: "unsend",
      scope: "group",
      scopeId: lineGroup,
      actorId: actor,
      publishedAt: f.store.now(),
      unsentMessageId: message,
    });
    await f.ask("繼續", actor, false, "sent-1");
    await finish(f);
    assert.equal(f.sent.length, 1);
    const context = await f.conversations.groupTurns.context(f.group, actor, {
      messageId: "new",
      publishedAt: f.store.now().toISOString(),
      mode: "explicit",
    });
    assert.equal(context.history.length, 0);
  },
);
test(
  "context stops at the asking event and never sees future messages",
  { skip: !databaseEnabled },
  async (t) => {
    const f = await fixture(t, answer);
    await f.ask("@小哈 問題");
    const at = f.store.now();
    await finish(f);
    f.advance(10000);
    await f.ask("FUTURE_SECRET", `U${"3".repeat(32)}`, false);
    const context = await f.conversations.groupTurns.context(f.group, actor, {
      messageId: "new",
      publishedAt: at.toISOString(),
      mode: "explicit",
    });
    assert.ok(!JSON.stringify(context).includes("FUTURE_SECRET"));
  },
);
test(
  "a referenced public draft remains a candidate after 45 minutes",
  { skip: !databaseEnabled },
  async (t) => {
    const f = await fixture(t, answer);
    await f.ask("@小哈 給我一份草稿");
    await finish(f);
    f.advance(45 * 60000);
    await f.ask("把剛才那份草稿改短", `U${"3".repeat(32)}`, false);
    await finish(f);
    assert.equal(f.sent.length, 2);
  },
);
test(
  "same speaker human-directed ordinary statements do not wake the bot",
  { skip: !databaseEnabled },
  async (t) => {
    let calls = 0;
    const f = await fixture(t, async (...a) => {
      calls++;
      return answer(...a);
    });
    await f.ask("@小哈 Hi");
    await finish(f);
    await f.ask("阿明，車到了，我們走吧", actor, false);
    await finish(f);
    assert.equal(calls, 1);
    assert.equal(f.sent.length, 1);
  },
);
test(
  "exact cross-day quote is found beyond the latest twenty public turns",
  { skip: !databaseEnabled },
  async (t) => {
    const f = await fixture(t, answer);
    await f.ask("@小哈 第一份草稿");
    await finish(f);
    for (let n = 0; n < 21; n++) {
      await f.ask("@小哈 其他話題", `U${"3".repeat(32)}`);
      await finish(f);
    }
    f.advance(86400000);
    await f.ask("繼續這份", actor, false, "sent-1");
    await finish(f);
    assert.equal(f.sent.length, 23);
  },
);
test(
  "pending question is owned by actor and turn, survives unrelated interleaving, and consumes once",
  { skip: !databaseEnabled },
  async (t) => {
    const f = await fixture(t, async () => ({
      status: "success",
      items: [],
      gaps: [],
      answer: "你要哪一天？",
      turn: { kind: "clarification", followUp: "awaiting" },
    }));
    await f.ask("@小哈 幫我安排");
    await finish(f);
    await f.ask("@阿明 車到了", `U${"3".repeat(32)}`, false, undefined, true);
    await finish(f);
    await f.ask("星期日", actor, false);
    const row = (
      await f.pool.query(
        "SELECT id,payload_ciphertext FROM interactions WHERE state='queued'",
      )
    ).rows[0];
    const request = JSON.parse(
      f.store.cipher.openPayload(
        row.payload_ciphertext,
        `interaction:${row.id}`,
      ),
    ).turnRequest;
    assert.equal(
      request.parentId,
      (await f.pool.query("SELECT id FROM group_turns")).rows[0].id,
    );
    assert.equal(
      (await f.pool.query("SELECT consumed_by FROM group_turns")).rows[0]
        .consumed_by,
      null,
    );
  },
);
test(
  "stale source revision blocks private result read even before cleanup",
  { skip: !databaseEnabled },
  async (t) => {
    let source: any;
    const f = await fixture(t, async () => ({
      status: "success",
      items: [],
      gaps: [],
      answer: "內容",
      dependencies: [source],
    }));
    source = (
      await f.pool.query(
        "INSERT INTO sources(group_id,message_id,author_id,kind,body,published_at,expires_at,state) VALUES($1,'ref',$2,'text','資料',$3,$3::timestamptz+interval '90 days','ready') RETURNING id,revision,description_revision,expires_at",
        [f.group, actor, f.store.now()],
      )
    ).rows[0];
    source = {
      id: source.id,
      revision: source.revision,
      descriptionRevision: source.description_revision,
      expiresAt: source.expires_at.toISOString(),
    };
    await f.ask("@小哈 查詢");
    await finish(f);
    const id = (await f.pool.query("SELECT id FROM search_jobs")).rows[0].id;
    await f.pool.query(
      "UPDATE sources SET description_revision=description_revision+1 WHERE id=$1",
      [source.id],
    );
    await assert.rejects(
      f.conversations.read(id, actor, f.group),
      /search_gone/,
    );
  },
);
test(
  "silent model output with invisible text never sends, shares, or consumes pending state",
  { skip: !databaseEnabled },
  async (t) => {
    const f = await fixture(t, async () => ({
      status: "success",
      items: [],
      gaps: [],
      answer: "\u200b",
      turn: { kind: "silent", followUp: "continue" },
    }));
    await f.ask("@小哈 測試");
    await finish(f);
    assert.equal(f.sent.length, 0);
    assert.equal(
      (await f.pool.query("SELECT count(*)::int n FROM group_turns")).rows[0].n,
      0,
    );
    assert.equal(
      (await f.pool.query("SELECT state FROM deliveries")).rows[0].state,
      "cancelled",
    );
    assert.deepEqual(
      (await f.pool.query("SELECT state,reply_kind FROM interactions")).rows,
      [{ state: "completed", reply_kind: "silent" }],
    );
  },
);
test(
  "candidate model fault finishes silently with no pending outbound delivery",
  { skip: !databaseEnabled },
  async (t) => {
    const f = await fixture(t, answer);
    await f.ask("@小哈 草稿");
    await finish(f);
    f.conversations.agent!.query = async () => {
      throw Error("provider unavailable");
    };
    await f.ask("改短那份", `U${"3".repeat(32)}`, false);
    await f.interactions.processOne();
    for (let i = 0; i < 3; i++) await f.conversations.processOne();
    await f.interactions.processOne();
    assert.equal(f.sent.length, 1);
    assert.equal(
      (
        await f.pool.query(
          "SELECT count(*)::int n FROM deliveries WHERE state='pending'",
        )
      ).rows[0].n,
      0,
    );
  },
);
for (const quoted of [false, true])
  test(
    `delivered ${quoted ? "quoted" : "explicit"} answer consumes only its original pending question`,
    { skip: !databaseEnabled },
    async (t) => {
      let n = 0;
      const f = await fixture(t, async () => ({
        status: "success",
        items: [],
        gaps: [],
        answer: ++n === 1 ? "你要哪一天？" : "已整理星期日的草稿。",
        turn: {
          kind: n === 1 ? "clarification" : "answer",
          followUp: n === 1 ? "awaiting" : "continue",
          answersPending: n > 1,
        },
      }));
      await f.ask("@小哈 安排活動");
      await finish(f);
      const parent = (await f.pool.query("SELECT id FROM group_turns")).rows[0]
        .id;
      await f.ask(
        quoted ? "星期日" : "@小哈 星期日",
        actor,
        !quoted,
        quoted ? "sent-1" : undefined,
      );
      await finish(f);
      assert.ok(
        (
          await f.pool.query(
            "SELECT consumed_by FROM group_turns WHERE id=$1",
            [parent],
          )
        ).rows[0].consumed_by,
      );
    },
  );
test(
  "unknown pending answer delivery releases its claim for a later answer",
  { skip: !databaseEnabled },
  async (t) => {
    let n = 0;
    const f = await fixture(t, async () => ({
      status: "success",
      items: [],
      gaps: [],
      answer: ++n === 1 ? "你要哪一天？" : "安排星期日。",
      turn: {
        kind: n === 1 ? "clarification" : "answer",
        followUp: n === 1 ? "awaiting" : "continue",
        answersPending: n > 1,
      },
    }));
    await f.ask("@小哈 安排");
    await finish(f);
    const send = f.interactions.ports.send;
    f.interactions.ports.send = async () => {
      throw Error("unknown");
    };
    await f.ask("星期日", actor, false);
    await finish(f);
    assert.equal(
      (await f.pool.query("SELECT consumed_by FROM group_turns")).rows[0]
        .consumed_by,
      null,
    );
    f.interactions.ports.send = send;
    await f.ask("星期日", actor, false);
    await finish(f);
    assert.equal(f.sent.length, 2);
  },
);
test(
  "a date followed by a question is not mistaken for a peer name",
  { skip: !databaseEnabled },
  async (t) => {
    const f = await fixture(t, async () => ({
      status: "success",
      items: [],
      gaps: [],
      answer: "哪一天？",
      turn: { kind: "clarification", followUp: "awaiting" },
    }));
    await f.ask("@小哈 安排");
    await finish(f);
    await f.ask("星期日，你覺得如何？", actor, false);
    await finish(f);
    assert.equal(f.sent.length, 2);
  },
);
test(
  "removing allowlist fences previously queued implicit work and outbound replies",
  { skip: !databaseEnabled },
  async (t) => {
    const f = await fixture(t, answer);
    await f.ask("@小哈 Hi");
    await finish(f);
    await f.ask("你能幫我做什麼？", actor, false);
    const conversations = new Conversations(
      f.store,
      f.conversations.search,
      f.conversations.agent,
    );
    const interactions = new Interactions(
      f.store,
      f.interactions.registration,
      {
        ...f.interactions.ports,
        conversations,
        groupTurns: conversations.groupTurns,
      },
    );
    await interactions.processOne();
    await conversations.processOne();
    await interactions.processOne();
    assert.equal(f.sent.length, 1);
    assert.equal(
      (
        await f.pool.query(
          "SELECT count(*)::int n FROM deliveries WHERE state='pending'",
        )
      ).rows[0].n,
      0,
    );
  },
);
test(
  "a late reset uses event time and cannot close a newer public topic",
  { skip: !databaseEnabled },
  async (t) => {
    const f = await fixture(t, answer);
    const old = f.store.now();
    f.advance(1000);
    await f.ask("@小哈 新的話題");
    await finish(f);
    await f.store.ingest(
      {
        id: "late-reset",
        type: "message",
        scope: "group",
        scopeId: lineGroup,
        actorId: actor,
        publishedAt: old,
        replyToken: "reset-token",
        message: {
          id: "late-reset-message",
          type: "text",
          text: "@小哈 重設對話",
          mentionsBot: true,
        },
      },
      (c, e, g) => f.interactions.record(c, e, g),
    );
    await f.interactions.processOne();
    await f.ask("你可以幫我嗎？", actor, false);
    await finish(f);
    assert.equal(f.sent.length, 3);
  },
);

test(
  "equal-time late reset preserves the later event and public turns from other actors",
  { skip: !databaseEnabled },
  async (t) => {
    const f = await fixture(t, answer);
    await f.ask("@小哈 共用草稿", `U${"3".repeat(32)}`);
    await finish(f);
    const at = new Date(f.store.now().getTime() + 1000);
    f.advance(1000);
    await f.store.ingest(
      {
        id: "02-new-topic",
        type: "message",
        scope: "group",
        scopeId: lineGroup,
        actorId: actor,
        publishedAt: at,
        replyToken: "new-topic-token",
        message: {
          id: "new-topic-message",
          type: "text",
          text: "@小哈 新話題",
          mentionsBot: true,
        },
      },
      (c, e, g) => f.interactions.record(c, e, g),
    );
    await finish(f);
    await f.store.ingest(
      {
        id: "01-late-reset",
        type: "message",
        scope: "group",
        scopeId: lineGroup,
        actorId: actor,
        publishedAt: at,
        replyToken: "reset-token",
        message: {
          id: "reset-message",
          type: "text",
          text: "@小哈 重設對話",
          mentionsBot: true,
        },
      },
      (c, e, g) => f.interactions.record(c, e, g),
    );
    await f.interactions.processOne();
    await f.ask("你可以幫我嗎？", actor, false);
    await finish(f);
    assert.equal(f.sent.length, 4);
    await f.conversations.reset(f.group, actor);
    await f.ask("把那份草稿改短", actor, false);
    await finish(f);
    assert.equal(
      f.sent.length,
      5,
      "reset must not hide another speaker public draft",
    );
  },
);

test(
  "real Agent SDK invalid handles and unknown LINE receipts never consume a pending question",
  { skip: !databaseEnabled },
  async (t) => {
    const f = await fixture(t, answer);
    let calls = 0;
    const model: Model = {
      async getResponse() {
        calls++;
        const value = {
          answer: calls === 1 ? "你要哪一天？" : "安排星期日。",
          selected: calls === 2 ? ["r_00000000000000000000"] : [],
          proposal: null,
          kind: calls === 1 ? "clarification" : "answer",
          followUp: calls === 1 ? "awaiting" : "continue",
          answersPending: calls > 1,
        };
        return {
          output: [
            {
              type: "message",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: JSON.stringify(value) }],
            },
          ],
          usage: new Usage({ inputTokens: 10, outputTokens: 10 }),
          rawUsage: {
            input_tokens: 10,
            output_tokens: 10,
            input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
          },
        };
      },
      async *getStreamedResponse() {
        throw Error("unused");
      },
    };
    const provider = {
      model,
      name: "synthetic",
      price: {
        inputMicrosPerMillion: 1000000,
        outputMicrosPerMillion: 5000000,
      },
    };
    const agent = new HarnessAgent(
      f.store,
      f.conversations.search,
      new SourceEdits(f.store, f.conversations.search, async () => {
        throw Error("unused");
      }),
      { openai: provider, azure: provider },
    );
    f.conversations.agent!.query = agent.query.bind(agent);
    await f.ask("@小哈 安排");
    await finish(f);
    const parent = (await f.pool.query("SELECT id FROM group_turns")).rows[0]
      .id;
    const deps = (
      await f.pool.query(
        "INSERT INTO sources(group_id,message_id,author_id,kind,body,published_at,expires_at,state) SELECT $1,'sdk-dependency-'||n,$2,'text','資料',$3,$3::timestamptz+interval '90 days','ready' FROM generate_series(1,50) n RETURNING id,revision,description_revision,expires_at",
        [f.group, actor, f.store.now()],
      )
    ).rows;
    await f.pool.query(
      "UPDATE group_turns SET dependencies=$1,source_ids=$2 WHERE id=$3",
      [
        JSON.stringify(
          deps.map((r) => ({
            id: r.id,
            revision: r.revision,
            descriptionRevision: r.description_revision,
            expiresAt: r.expires_at.toISOString(),
          })),
        ),
        deps.map((r) => r.id),
        parent,
      ],
    );
    await f.ask("@小哈 星期日");
    await finish(f);
    assert.equal(
      (
        await f.pool.query("SELECT consumed_by FROM group_turns WHERE id=$1", [
          parent,
        ])
      ).rows[0].consumed_by,
      null,
    );
    assert.equal(
      (await f.pool.query("SELECT count(*)::int n FROM group_turns")).rows[0].n,
      1,
    );
    const send = f.interactions.ports.send;
    f.interactions.ports.send = async () => {
      throw Error("unknown");
    };
    await f.ask("@小哈 星期日");
    await finish(f);
    assert.equal(
      (
        await f.pool.query(
          "SELECT consumed_by,claimed_by FROM group_turns WHERE id=$1",
          [parent],
        )
      ).rows[0].consumed_by,
      null,
    );
    f.interactions.ports.send = send;
    await f.ask("@小哈 星期日");
    await finish(f);
    assert.ok(
      (
        await f.pool.query("SELECT consumed_by FROM group_turns WHERE id=$1", [
          parent,
        ])
      ).rows[0].consumed_by,
    );
    assert.equal(calls, 4);
  },
);
for (const stage of ["queued", "ready"] as const)
  test(
    `allowlist removal cancels ${stage} explicit v1 job before image rollback`,
    { skip: !databaseEnabled },
    async (t) => {
      const f = await fixture(t, answer);
      await f.ask("@小哈 Hi");
      await f.interactions.processOne();
      if (stage === "ready") await f.conversations.processOne();
      const conversations = new Conversations(
        f.store,
        f.conversations.search,
        f.conversations.agent,
      );
      const interactions = new Interactions(
        f.store,
        f.interactions.registration,
        {
          ...f.interactions.ports,
          conversations,
          groupTurns: conversations.groupTurns,
        },
      );
      await conversations.processOne();
      await interactions.processOne();
      assert.equal(f.sent.length, 0);
      assert.equal(
        (
          await f.pool.query(
            "SELECT count(*)::int n FROM deliveries WHERE state IN ('pending','attempt_reserved')",
          )
        ).rows[0].n,
        0,
      );
    },
  );
test(
  "a delivered closed reply ends older pending without blocking explicit quotes",
  { skip: !databaseEnabled },
  async (t) => {
    let n = 0;
    const f = await fixture(t, async () => ({
      status: "success",
      items: [],
      gaps: [],
      answer: ++n === 1 ? "哪一天？" : "不客氣。",
      turn: {
        kind: n === 1 ? "clarification" : "answer",
        followUp: n === 1 ? "awaiting" : "closed",
        answersPending: false,
      },
    }));
    await f.ask("@小哈 安排");
    await finish(f);
    await f.ask("@小哈 不用了，謝謝");
    await finish(f);
    await f.ask("星期日", actor, false);
    await finish(f);
    assert.equal(n, 2);
    assert.equal(f.sent.length, 2);
    await f.ask("把這份改短", actor, false, "sent-1");
    await finish(f);
    assert.equal(n, 3);
  },
);
for (const count of [46, 50, 256])
  test(
    `priority quote with ${count} dependencies is retained or explicitly bounded`,
    { skip: !databaseEnabled },
    async (t) => {
      let n = 0;
      const f = await fixture(t, async (...args) => {
        if (++n > 1)
          assert.match(JSON.stringify(args[8]?.history), /這是一份草稿/);
        return answer(...args);
      });
      await f.ask("@小哈 草稿");
      await finish(f);
      const rows = (
        await f.pool.query(
          "INSERT INTO sources(group_id,message_id,author_id,kind,body,published_at,expires_at,state) SELECT $1,'dependency-'||n,$2,'text','資料',$3,$3::timestamptz+interval '90 days','ready' FROM generate_series(1,$4::int) n RETURNING id,revision,description_revision,expires_at",
          [f.group, actor, f.store.now(), count],
        )
      ).rows;
      const dependencies = rows.map((r) => ({
        id: r.id,
        revision: r.revision,
        descriptionRevision: r.description_revision,
        expiresAt: r.expires_at.toISOString(),
      }));
      await f.pool.query(
        "UPDATE group_turns SET dependencies=$1,source_ids=$2",
        [JSON.stringify(dependencies), rows.map((r) => r.id)],
      );
      if (count === 256) {
        await f.ask("那份呢", actor, false, "sent-1");
        await finish(f);
        assert.equal(f.sent.length, 1);
        assert.equal(n, 1);
      }
      await f.ask("把這份改短", actor, count === 256, "sent-1");
      await finish(f);
      assert.equal(f.sent.length, 2);
      if (count === 256) {
        assert.equal(n, 1);
        assert.match(f.sent[1]!.text, /關鍵一句/);
        assert.equal(
          (
            await f.pool.query(
              "SELECT cardinality(source_ids) n FROM group_turns ORDER BY event_at DESC LIMIT 1",
            )
          ).rows[0].n,
          1,
        );
      } else assert.equal(n, 2);
    },
  );
for (const text of ["我們星期日可以", "星期日"])
  test(
    `pending context retains the concrete final question for ${text}`,
    { skip: !databaseEnabled },
    async (t) => {
      let n = 0;
      const f = await fixture(t, async (...args) => {
        if (++n > 1)
          assert.match(JSON.stringify(args[8]?.history), /活動是哪一天/);
        return {
          status: "success",
          items: [],
          gaps: [],
          answer:
            n === 1
              ? "安排".repeat(400) + "活動是哪一天？"
              : "星期日安排好了。",
          turn: {
            kind: n === 1 ? "clarification" : "answer",
            followUp: n === 1 ? "awaiting" : "continue",
            answersPending: n > 1,
          },
        };
      });
      await f.ask("@小哈 安排");
      await finish(f);
      await f.ask(text, actor, false);
      await finish(f);
      assert.equal(f.sent.length, 2);
    },
  );
for (const choice of ["older", "invalid", "ambiguous"] as const)
  test(
    `real SDK multi-topic pending selection ${choice} preserves the other question`,
    { skip: !databaseEnabled },
    async (t) => {
      const f = await fixture(t, answer);
      let calls = 0;
      let older = "";
      const model: Model = {
        async getResponse(request) {
          calls++;
          const classifier = request.tools.length === 0 && calls > 2;
          const value = classifier
            ? { recipient: "bot" }
            : {
                answer:
                  calls === 1
                    ? "活動是哪一天？"
                    : calls === 2
                      ? "便當葷食還是素食？"
                      : "活動安排在星期日。",
                selected: [],
                proposal: null,
                kind: calls <= 2 ? "clarification" : "answer",
                followUp: calls <= 2 ? "awaiting" : "continue",
                answersPending:
                  calls <= 2
                    ? false
                    : choice === "older"
                      ? older
                      : choice === "invalid"
                        ? randomUUID()
                        : true,
              };
          return {
            output: [
              {
                type: "message",
                role: "assistant",
                status: "completed",
                content: [{ type: "output_text", text: JSON.stringify(value) }],
              },
            ],
            usage: new Usage({ inputTokens: 10, outputTokens: 10 }),
            rawUsage: {
              input_tokens: 10,
              output_tokens: 10,
              input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
            },
          };
        },
        async *getStreamedResponse() {
          throw Error("unused");
        },
      };
      const provider = {
        model,
        name: "synthetic",
        price: {
          inputMicrosPerMillion: 1000000,
          outputMicrosPerMillion: 5000000,
        },
      };
      const agent = new HarnessAgent(
        f.store,
        f.conversations.search,
        new SourceEdits(f.store, f.conversations.search, async () => {
          throw Error("unused");
        }),
        { openai: provider, azure: provider },
      );
      f.conversations.agent!.query = agent.query.bind(agent);
      await f.ask("@小哈 安排活動");
      await finish(f);
      older = (await f.pool.query("SELECT id FROM group_turns")).rows[0].id;
      await f.ask("@小哈 幫我訂便當");
      await finish(f);
      const newer = (
        await f.pool.query("SELECT id FROM group_turns WHERE id<>$1", [older])
      ).rows[0].id;
      await f.ask("活動那份是星期日", actor, false);
      await finish(f);
      const rows = (
        await f.pool.query(
          "SELECT id,consumed_by FROM group_turns WHERE id=ANY($1::uuid[])",
          [[older, newer]],
        )
      ).rows;
      assert.equal(rows.find((r) => r.id === newer).consumed_by, null);
      if (choice === "older")
        assert.ok(rows.find((r) => r.id === older).consumed_by);
      else assert.equal(rows.find((r) => r.id === older).consumed_by, null);
    },
  );
test(
  "all owned pending questions precede newer long public background",
  { skip: !databaseEnabled },
  async (t) => {
    let n = 0;
    const f = await fixture(t, async (...args) => {
      n++;
      if (n === 8) assert.equal(args[8]?.pendingTurns?.length, 2);
      return {
        status: "success",
        items: [],
        gaps: [],
        answer:
          n === 1
            ? "活動哪一天？"
            : n === 2
              ? "便當幾份？"
              : "長背景".repeat(300),
        turn: {
          kind: n <= 2 ? "clarification" : "answer",
          followUp: n <= 2 ? "awaiting" : "continue",
        },
      };
    });
    await f.ask("@小哈 活動");
    await finish(f);
    await f.ask("@小哈 便當");
    await finish(f);
    for (let i = 0; i < 5; i++) {
      await f.ask("@小哈 其他問題", `U${"3".repeat(32)}`);
      await finish(f);
    }
    await f.ask("活動那份星期日", actor, false);
    await finish(f);
    assert.equal(f.sent.length, 8);
  },
);
test(
  "two admitted answers consume the runtime pending target instead of the old intake parent",
  { skip: !databaseEnabled },
  async (t) => {
    let n = 0;
    const f = await fixture(t, async (...args) => {
      n++;
      if (n === 4) {
        assert.equal(args[8]!.pendingTurns!.length, 1);
        assert.equal(args[8]!.parentId, args[8]!.pendingTurns![0]!.id);
      }
      return {
        status: "success",
        items: [],
        gaps: [],
        answer:
          n === 1
            ? "活動哪一天？"
            : n === 2
              ? "便當葷素？"
              : n === 3
                ? "素食。"
                : "星期日。",
        turn: {
          kind: n <= 2 ? "clarification" : "answer",
          followUp: n <= 2 ? "awaiting" : "continue",
          answersPending: n > 2,
          ...(n === 3
            ? {
                answeredPending: args[8]!.pendingTurns!.find(
                  (p) => p.id === args[8]!.parentId,
                )!,
              }
            : {}),
        },
      };
    });
    await f.ask("@小哈 活動");
    await finish(f);
    await f.ask("@小哈 便當");
    await finish(f);
    await f.ask("便當素食", actor, false);
    await f.ask("活動星期日", actor, false);
    for (let i = 0; i < 8; i++) {
      await f.interactions.processOne();
      await f.conversations.processOne();
    }
    assert.equal(f.sent.length, 4);
    assert.equal(
      (
        await f.pool.query(
          "SELECT count(*)::int n FROM group_turns WHERE follow_up='awaiting' AND consumed_by IS NULL",
        )
      ).rows[0].n,
      0,
    );
  },
);
test(
  "combined provenance overflow cannot hide a different owned pending question",
  { skip: !databaseEnabled },
  async (t) => {
    let calls = 0;
    const f = await fixture(t, async () => {
      calls++;
      return {
        status: "success",
        items: [],
        gaps: [],
        answer: "哪一天？",
        turn: { kind: "clarification", followUp: "awaiting" },
      };
    });
    await f.ask("@小哈 第一題");
    await finish(f);
    await f.ask("@小哈 第二題");
    await finish(f);
    const turns = (
      await f.pool.query("SELECT id FROM group_turns ORDER BY event_at")
    ).rows;
    for (let i = 0; i < 2; i++) {
      const rows = (
        await f.pool.query(
          "INSERT INTO sources(group_id,message_id,author_id,kind,body,published_at,expires_at,state) SELECT $1,$4||n,$2,'text','資料',$3,$3::timestamptz+interval '90 days','ready' FROM generate_series(1,150) n RETURNING id,revision,description_revision,expires_at",
          [f.group, actor, f.store.now(), `overflow-${i}-`],
        )
      ).rows;
      await f.pool.query(
        "UPDATE group_turns SET dependencies=$1,source_ids=$2 WHERE id=$3",
        [
          JSON.stringify(
            rows.map((r) => ({
              id: r.id,
              revision: r.revision,
              descriptionRevision: r.description_revision,
              expiresAt: r.expires_at.toISOString(),
            })),
          ),
          rows.map((r) => r.id),
          turns[i].id,
        ],
      );
    }
    await f.ask("第一題星期日", actor, false);
    await finish(f);
    assert.equal(calls, 2);
    assert.equal(f.sent.length, 2);
    await f.ask("@小哈 第一題星期日");
    await finish(f);
    assert.equal(calls, 2);
    assert.match(f.sent[2]!.text, /關鍵一句/);
  },
);
test(
  "context chronology keeps a newer public draft after prioritized old pending questions",
  { skip: !databaseEnabled },
  async (t) => {
    let n = 0;
    const f = await fixture(t, async (...args) => {
      n++;
      if (n === 5)
        assert.match(args[8]!.history.at(-1)!.assistant, /新人歡迎草稿/);
      return {
        status: "success",
        items: [],
        gaps: [],
        answer: n <= 3 ? `問題${n}哪一天？` : "新人歡迎草稿",
        turn: {
          kind: n <= 3 ? "clarification" : "answer",
          followUp: n <= 3 ? "awaiting" : "continue",
        },
      };
    });
    for (let i = 0; i < 3; i++) {
      await f.ask(`@小哈 問題${i}`);
      await finish(f);
    }
    await f.ask("@小哈 寫歡迎詞", `U${"3".repeat(32)}`);
    await finish(f);
    await f.ask("那份草稿改短", actor, false);
    await finish(f);
    assert.equal(f.sent.length, 5);
  },
);

for (const task of [
  "介紹範例讀書會",
  "比較兩種迎新方式",
  "新人歡迎詞，三句就好",
])
  test(
    `an uninterrupted continue turn admits the non-question task: ${task}`,
    { skip: !databaseEnabled },
    async (t) => {
      let calls = 0;
      const f = await fixture(t, async (...args) => {
        calls++;
        if (calls === 2) assert.equal(args[8]?.mode, "implicit");
        return {
          status: "success",
          items: [],
          gaps: [],
          answer:
            calls === 1 ? "嗨！有什麼我可以幫忙的嗎？" : "這是任務的回答。",
          turn: { kind: "answer", followUp: "continue" },
        };
      });
      await f.ask("@小哈 hi");
      await finish(f);
      await f.ask(task, actor, false);
      await finish(f);
      assert.equal(calls, 2);
      assert.equal(f.sent.length, 2);
      assert.equal(
        (
          await f.pool.query(
            "SELECT count(*)::int n FROM group_turn_resets WHERE actor_id=$1",
            [actor],
          )
        ).rows[0].n,
        0,
      );
    },
  );

for (const peer of [actor, `U${"3".repeat(32)}`])
  test(
    `peer handover keeps a later non-question task quiet for ${peer === actor ? "same" : "other"} actor`,
    { skip: !databaseEnabled },
    async (t) => {
      let calls = 0;
      const f = await fixture(t, async (...args) => {
        calls++;
        return answer(...args);
      });
      await f.ask("@小哈 hi");
      await finish(f);
      await f.ask("阿明，車到了，我們先走", peer, false);
      await finish(f);
      await f.ask("介紹範例讀書會", actor, false);
      await finish(f);
      assert.equal(calls, 1);
      assert.equal(f.sent.length, 1);
    },
  );

test(
  "late older peer addressing cannot close a newer continue turn",
  { skip: !databaseEnabled },
  async (t) => {
    const f = await fixture(t, answer);
    f.advance(10000);
    const older = f.store.now();
    await f.ask("@小哈 hi");
    await finish(f);
    await f.store.ingest(
      {
        id: "late-peer",
        type: "message",
        scope: "group",
        scopeId: lineGroup,
        actorId: actor,
        publishedAt: older,
        replyToken: "late-peer-token",
        message: {
          id: "late-peer-message",
          type: "text",
          text: "阿明，車到了",
          mentionsBot: false,
        },
      },
      (c, e, g) => f.interactions.record(c, e, g),
    );
    assert.equal(
      (
        await f.pool.query(
          "SELECT count(*)::int n FROM sources WHERE message_id='late-peer-message'",
        )
      ).rows[0].n,
      1,
    );
    await f.ask("介紹範例讀書會", actor, false);
    await finish(f);
    assert.equal(f.sent.length, 2);
  },
);

test(
  "a late task excludes peer handover that happened after its event time",
  { skip: !databaseEnabled },
  async (t) => {
    const f = await fixture(t, answer);
    await f.ask("@小哈 hi");
    await finish(f);
    f.advance(1000);
    const at = f.store.now();
    await f.ask("阿明，車到了", `U${"3".repeat(32)}`, false);
    await finish(f);
    await f.store.ingest(
      {
        id: "late-task",
        type: "message",
        scope: "group",
        scopeId: lineGroup,
        actorId: actor,
        publishedAt: at,
        replyToken: "late-task-token",
        message: {
          id: "late-task-message",
          type: "text",
          text: "介紹範例讀書會",
          mentionsBot: false,
        },
      },
      (c, e, g) => f.interactions.record(c, e, g),
    );
    await finish(f);
    assert.equal(f.sent.length, 2);
  },
);

for (const [text, kind] of [
  ["介紹範例讀書會", "answer"],
  ["車子停在後門了", "silent"],
] as const)
  test(
    `a non-question continuation keeps the SDK tool-free and respects ${kind}`,
    { skip: !databaseEnabled },
    async (t) => {
      const f = await fixture(t, answer);
      let calls = 0;
      const model: Model = {
        async getResponse(request) {
          calls++;
          if (calls === 2) assert.equal(request.tools.length, 0);
          const value = {
            answer:
              calls === 1
                ? "嗨！有什麼我可以幫忙的嗎？"
                : kind === "answer"
                  ? "可以先介紹社群的活動。"
                  : "不需回覆。",
            selected: [],
            proposal: null,
            kind: calls === 1 ? "answer" : kind,
            followUp: "continue",
            answersPending: false,
          };
          return {
            output: [
              {
                type: "message",
                role: "assistant",
                status: "completed",
                content: [{ type: "output_text", text: JSON.stringify(value) }],
              },
            ],
            usage: new Usage({ inputTokens: 10, outputTokens: 10 }),
            rawUsage: {
              input_tokens: 10,
              output_tokens: 10,
              input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
            },
          };
        },
        async *getStreamedResponse() {
          throw Error("unused");
        },
      };
      const provider = {
        model,
        name: "synthetic",
        price: {
          inputMicrosPerMillion: 1000000,
          outputMicrosPerMillion: 5000000,
        },
      };
      const agent = new HarnessAgent(
        f.store,
        f.conversations.search,
        new SourceEdits(f.store, f.conversations.search, async () => {
          throw Error("unused");
        }),
        { openai: provider, azure: provider },
      );
      f.conversations.agent!.query = agent.query.bind(agent);
      await f.ask("@小哈 hi");
      await finish(f);
      await f.ask(text, actor, false);
      await finish(f);
      assert.equal(calls, 2);
      assert.equal(f.sent.length, kind === "answer" ? 2 : 1);
      assert.equal(
        (
          await f.pool.query(
            "SELECT count(*)::int n FROM deliveries WHERE state IN ('pending','attempt_reserved')",
          )
        ).rows[0].n,
        0,
      );
    },
  );

test(
  "a 26-second agent lookup still delivers one cited answer directly to the group",
  { skip: !databaseEnabled },
  async (t) => {
    const text = "哈利路亞家教會。\n\n來源\nhttps://www.alive.org.tw/";
    const f = await fixture(t, async () => ({
      status: "success",
      items: [],
      gaps: [],
      answer: text,
      webSources: ["https://www.alive.org.tw/"],
      turn: { kind: "answer", followUp: "continue" },
    }));
    await f.ask("@小哈 介紹哈利路亞家教會");
    await f.interactions.processOne();
    f.advance(26_000);
    assert.equal(await f.interactions.processOne(), false);
    await f.conversations.processOne();
    await f.interactions.processOne();
    assert.deepEqual(
      f.sent.map((r) => r.text),
      [text],
    );
    assert.ok(!f.sent[0]?.actions?.length);
  },
);
