import assert from "node:assert/strict";
import { test } from "node:test";
import { database, databaseEnabled } from "./database.ts";
import { Store } from "../src/persistence/store.ts";
import { ReplyTokenCipher } from "../src/reply/token.ts";
import { Registration } from "../src/domain/registration.ts";
import { Interactions } from "../src/domain/interactions.ts";
import type { LineEvent } from "../src/domain/events.ts";
const now = new Date("2026-11-12T12:00:00Z"),
  line = `U${"a".repeat(32)}`,
  group = `C${"c".repeat(32)}`;
test(
  "group setup travels through durable interactions and one Reply per event",
  { skip: !databaseEnabled },
  async (t) => {
    const pool = await database(t);
    await pool.query("UPDATE runtime_state SET mode='open',ingest_floor=$1", [
      new Date(now.getTime() - 60_000),
    ]);
    const store = new Store(
      pool,
      new ReplyTokenCipher("a".repeat(64)),
      "channel",
      () => now,
    );
    const sent: {
      text: string;
      actions?: { label: string; data: string }[];
    }[] = [];
    const send = async (
      _token: string,
      text: string,
      actions?: { label: string; data: string }[],
    ) => {
      sent.push({ text, actions });
    };
    const registration = new Registration(store, {
      authority: async () => ({
        bound: true,
        allowed: true,
        actorUserId: "11111111-1111-4111-8111-111111111111",
        bindingGeneration: 1,
        adminAuthorizationRevision: 1,
      }),
      member: async () => true,
      collection: async () => {
        throw new Error("disabled");
      },
      send,
    });
    const interactions = new Interactions(store, registration, {
      binding: async () => "https://account.invalid/line/bind#token=synthetic",
      finalize: async () => {},
      send,
      adminOrigin: "https://admin.invalid",
    });
    const event: LineEvent = {
      id: "begin",
      type: "message",
      scope: "group",
      scopeId: group,
      actorId: line,
      publishedAt: now,
      replyToken: "token",
      message: { id: "m1", type: "text", text: "@Bot 啟用", mentionsBot: true },
    };
    await store.ingest(event, (c, e, g) => interactions.record(c, e, g));
    assert.equal(sent.length, 0);
    await interactions.processOne();
    assert.equal(sent.length, 1);
    assert.equal(
      (await pool.query("SELECT count(*)::int AS n FROM sources")).rows[0].n,
      0,
    );
    const intent = (await pool.query("SELECT id FROM setup_intents")).rows[0]
      .id;
    await registration.configure(intent, line, { sharing: false });
    for (const [id, data] of [
      ["preview", `setup:preview:${intent}`],
      ["confirm", ""],
    ] as const) {
      const postback = data || sent.at(-1)!.actions![0]!.data;
      const next = {
        ...event,
        id,
        type: "postback" as const,
        message: undefined,
        postback,
      };
      await store.ingest(next, (c, e, g) => interactions.record(c, e, g));
      await interactions.processOne();
    }
    assert.equal(
      (await pool.query("SELECT state FROM groups")).rows[0].state,
      "active",
    );
    assert.equal(sent.length, 3);
    await store.ingest(event, (c, e, g) => interactions.record(c, e, g));
    await interactions.processOne();
    assert.equal(sent.length, 3);
  },
);

test(
  "expired interaction lease cannot send or mutate group setup",
  { skip: !databaseEnabled },
  async (t) => {
    const pool = await database(t);
    await pool.query("UPDATE runtime_state SET mode='open',ingest_floor=$1", [
      new Date(now.getTime() - 60_000),
    ]);
    let clock = now;
    const store = new Store(
      pool,
      new ReplyTokenCipher("a".repeat(64)),
      "channel",
      () => clock,
    );
    const registration = new Registration(store, {
      authority: async () => {
        throw new Error("unused");
      },
      member: async () => true,
      collection: async () => {
        throw new Error("unused");
      },
      send: async () => assert.fail("late send"),
    });
    const interactions = new Interactions(store, registration, {
      binding: async () => "",
      finalize: async () => {},
      send: async () => assert.fail("late send"),
      adminOrigin: "https://admin.invalid",
    });
    await store.ingest(
      {
        id: "stale",
        type: "message",
        scope: "group",
        scopeId: group,
        actorId: line,
        publishedAt: now,
        replyToken: "token",
        message: { id: "m", type: "text", text: "啟用", mentionsBot: true },
      },
      (c, e, g) => interactions.record(c, e, g),
    );
    const claimed = await interactions.claim();
    assert.ok(claimed);
    clock = new Date(now.getTime() + 31_000);
    await assert.rejects(
      registration.begin(group, line, claimed),
      /interaction_expired/,
    );
    await interactions.deliveries.prepare(claimed.delivery_id!, "late");
    await interactions.deliveries.deliver(claimed.delivery_id!, async () =>
      assert.fail("late send"),
    );
    assert.equal(
      (await pool.query("SELECT count(*)::int AS n FROM groups")).rows[0].n,
      0,
    );
  },
);

test(
  "private chat binds only unbound users; current Admin gets metadata menu with shared preview/confirm",
  { skip: !databaseEnabled },
  async (t) => {
    const { Management } = await import("../src/domain/management.ts");
    const pool = await database(t);
    await pool.query("UPDATE runtime_state SET mode='open',ingest_floor=$1", [
      new Date(now.getTime() - 1000),
    ]);
    const store = new Store(
      pool,
      new ReplyTokenCipher("a".repeat(64)),
      "channel",
      () => now,
    );
    let bound = false,
      allowed = false,
      bindings = 0;
    const actor = "11111111-1111-4111-8111-111111111111";
    const authority = async () => ({
      bound,
      allowed,
      actorUserId: actor,
      bindingGeneration: 1,
      adminAuthorizationRevision: 1,
    });
    const sent: {
      text: string;
      actions?: { label: string; data: string }[];
    }[] = [];
    const send = async (
      _: string,
      text: string,
      actions?: { label: string; data: string }[],
    ) => {
      sent.push({ text, actions });
    };
    const registration = new Registration(store, {
      authority,
      member: async () => true,
      collection: async () => {
        throw Error("unused");
      },
      send,
    });
    const management = new Management(store, registration, { authority });
    const interactions = new Interactions(store, registration, {
      binding: async () => {
        bindings++;
        return "https://account.invalid/bind";
      },
      finalize: async () => {},
      send,
      adminOrigin: "https://admin.invalid",
      management,
    });
    let n = 0;
    async function message(postback?: string) {
      const e: LineEvent = {
        id: "private" + ++n,
        type: postback ? "postback" : "message",
        actorId: line,
        scope: "user",
        scopeId: line,
        replyToken: "token",
        publishedAt: now,
        ...(postback
          ? { postback }
          : {
              message: {
                id: "m" + n,
                type: "text",
                text: "管理",
                mentionsBot: false,
              },
            }),
      };
      await store.ingest(e, (c, e, g) => interactions.record(c, e, g));
      await interactions.processOne();
    }
    await message();
    assert.equal(bindings, 1);
    bound = true;
    await message();
    assert.equal(bindings, 1);
    assert.match(sent.at(-1)!.text, /僅供.*管理/);
    allowed = true;
    await registration.begin(group, line);
    await pool.query("UPDATE groups SET state='active',active_from=$1", [now]);
    await message();
    assert.equal(bindings, 1);
    assert.match(sent.at(-1)!.text, /管理/);
    const select = sent.at(-1)!.actions![0]!.data;
    await message(select);
    await message(
      sent.at(-1)!.actions!.find((a) => a.label === "預覽暫停")!.data,
    );
    await message(sent.at(-1)!.actions![0]!.data);
    assert.equal(
      (await pool.query("SELECT state FROM groups")).rows[0].state,
      "paused",
    );
    assert.equal(
      (await pool.query("SELECT count(*)::int n FROM audit_outbox")).rows[0].n,
      1,
    );
  },
);
