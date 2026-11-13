import assert from "node:assert/strict";
import test from "node:test";
import { database, databaseEnabled } from "./database.ts";
import { Store } from "../src/persistence/store.ts";
import { ReplyTokenCipher } from "../src/reply/token.ts";
import { Registration } from "../src/domain/registration.ts";
import { Interactions } from "../src/domain/interactions.ts";
import { Conversations } from "../src/domain/conversations.ts";
import { Search } from "../src/search/search.ts";
import { IndexWorker } from "../src/worker/indexer.ts";
import type { LineEvent } from "../src/domain/events.ts";
import type { ReplyAction } from "../src/providers/line.ts";
test(
  "only explicit group mention starts a durable query; pickup and reset each use one Reply without website binding",
  { skip: !databaseEnabled },
  async (t) => {
    const pool = await database(t),
      now = new Date("2026-11-13T00:00:00Z"),
      group = "C" + "2".repeat(32),
      actor = "U" + "1".repeat(32);
    await pool.query("UPDATE runtime_state SET mode='open',ingest_floor=$1", [
      now,
    ]);
    await pool.query(
      "INSERT INTO groups(channel_id,line_group_id,state,active_from) VALUES('fixture',$1,'active',$2)",
      [group, now],
    );
    const store = new Store(
      pool,
      new ReplyTokenCipher("11".repeat(32)),
      "fixture",
      () => now,
    );
    const conversations = new Conversations(
      store,
      new Search(store, async () => true),
    );
    const sent: { text: string; actions?: ReplyAction[] }[] = [];
    const unexpected = async () => {
      throw new Error("unexpected account or admin call");
    };
    const registration = new Registration(store, {
      authority: unexpected,
      member: async () => true,
      collection: unexpected,
      send: unexpected,
    });
    const interactions = new Interactions(store, registration, {
      conversations,
      binding: unexpected,
      finalize: unexpected,
      send: async (_token, text, actions) => {
        sent.push({ text, actions });
      },
      adminOrigin: "https://admin.invalid",
      liffId: "1234567890-abcdefgh",
    });
    const ingest = async (id: string, text: string, mention = false) => {
      const event: LineEvent = {
        id,
        scope: "group",
        scopeId: group,
        actorId: actor,
        type: "message",
        publishedAt: now,
        replyToken: `reply-${id}`,
        message: {
          id: `message-${id}`,
          type: "text",
          text,
          mentionsBot: mention,
        },
      };
      await store.ingest(event, (c, e, g) => interactions.record(c, e, g));
    };
    await ingest("source", "十二月同工排班已公告");
    await ingest("ordinary", "1");
    assert.equal(await interactions.processOne(), false);
    const indexer = new IndexWorker(store, unexpected);
    while (await indexer.processOne()) {}
    await ingest("query", "@Bot 查詢 同工排班", true);
    assert.equal(await interactions.processOne(), true);
    assert.equal(sent.length, 1);
    assert.match(sent[0]!.text, /不會另行推播/);
    assert.match(sent[0]!.text, /liff.line.me/);
    assert.equal(await conversations.processOne(), true);
    assert.equal(sent.length, 1);
    const data = sent[0]!.actions![0]!.data;
    const pickup: LineEvent = {
      id: "pickup",
      scope: "group",
      scopeId: group,
      actorId: actor,
      type: "postback",
      postback: data,
      publishedAt: now,
      replyToken: "reply-pickup",
    };
    await store.ingest(pickup, (c, e, g) => interactions.record(c, e, g));
    await interactions.processOne();
    assert.equal(sent.length, 2);
    assert.match(sent[1]!.text, /十二月同工排班已公告/);
    assert.doesNotMatch(sent[1]!.text, /@Bot 查詢/);
    await ingest("latest", "@Bot 查看結果", true);
    await interactions.processOne();
    assert.equal(sent.length, 3);
    assert.match(sent[2]!.text, /請選擇/);
    assert.equal(sent[2]!.actions![0]!.data, data);
    assert.equal(
      (await pool.query("SELECT count(*) AS n FROM search_jobs")).rows[0].n,
      "1",
    );
    await ingest("reset", "@Bot 重設對話", true);
    await interactions.processOne();
    assert.equal(sent.length, 4);
    assert.match(sent[3]!.text, /已重設/);
    assert.equal(
      (
        await pool.query(
          "SELECT count(*) AS n FROM sources WHERE state='ready'",
        )
      ).rows[0].n,
      "5",
    );
    assert.equal(await interactions.processOne(), false);
  },
);
