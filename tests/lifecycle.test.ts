import assert from "node:assert/strict";
import { test } from "node:test";
import { database, databaseEnabled } from "./database.ts";
import { Store } from "../src/persistence/store.ts";
import { ReplyTokenCipher } from "../src/reply/token.ts";
import { SourceAccess } from "../src/domain/source-access.ts";
import { Jobs } from "../src/worker/jobs.ts";
import type { LineEvent } from "../src/domain/events.ts";
const now = new Date("2026-11-12T12:00:00Z"),
  group = `C${"c".repeat(32)}`;
const event: LineEvent = {
  id: "original",
  type: "message",
  publishedAt: now,
  scope: "group",
  scopeId: group,
  message: {
    id: "message",
    type: "file",
    fileName: "file.pdf",
    mentionsBot: false,
  },
};
async function fixture(t: Parameters<typeof database>[0]) {
  const pool = await database(t);
  await pool.query("UPDATE runtime_state SET mode='open',ingest_floor=$1", [
    new Date(now.getTime() - 60_000),
  ]);
  await pool.query(
    "INSERT INTO groups(channel_id,line_group_id,state,active_from) VALUES('channel',$1,'active',$2)",
    [group, new Date(now.getTime() - 30_000)],
  );
  let clock = now;
  const store = new Store(
    pool,
    new ReplyTokenCipher("a".repeat(64)),
    "channel",
    () => clock,
  );
  return {
    pool,
    store,
    access: new SourceAccess(store),
    jobs: new Jobs(store),
    advance: (ms: number) => {
      clock = new Date(clock.getTime() + ms);
    },
  };
}
test(
  "unsend before original and after intake both deny data and cancel jobs",
  { skip: !databaseEnabled },
  async (t) => {
    const { pool, store } = await fixture(t);
    await store.ingest({
      ...event,
      id: "unsend",
      type: "unsend",
      message: undefined,
      unsentMessageId: "message",
    });
    await store.ingest(event);
    assert.equal(
      (await pool.query("SELECT count(*)::int AS n FROM sources")).rows[0].n,
      0,
    );
    await store.ingest({
      ...event,
      id: "other",
      message: { ...event.message!, id: "other-message" },
    });
    await store.ingest({
      ...event,
      id: "unsend2",
      type: "unsend",
      message: undefined,
      unsentMessageId: "other-message",
    });
    assert.equal(
      (await pool.query("SELECT state FROM sources")).rows[0].state,
      "revoked",
    );
    assert.equal(
      (await pool.query("SELECT state FROM jobs WHERE kind='download'")).rows[0]
        .state,
      "cancelled",
    );
  },
);
test(
  "source gate is closed by pause, deadline, wrong immutable identity and runtime restore",
  { skip: !databaseEnabled },
  async (t) => {
    const { pool, store, access, advance } = await fixture(t);
    await store.ingest(event);
    await pool.query(
      "UPDATE sources SET state='ready',asset_id='11111111-1111-4111-8111-111111111111',asset_etag='etag'",
    );
    const s = (await pool.query("SELECT * FROM sources")).rows[0];
    const request = {
      version: 1,
      mode: "original",
      source: {
        version: 1,
        ref: s.id,
        revision: s.asset_source_revision,
        publishedAt: s.published_at.toISOString(),
        expiresAt: s.expires_at.toISOString(),
      },
    };
    assert.equal((await access.check(request)).state, "active");
    await pool.query("UPDATE groups SET state='paused',revision=revision+1");
    assert.equal((await access.check(request)).state, "paused");
    await pool.query("UPDATE groups SET state='active'");
    assert.equal(
      (
        await access.check({
          ...request,
          source: { ...request.source, revision: "wrong-revision" },
        })
      ).state,
      "revoked",
    );
    advance(90 * 86400000);
    assert.equal((await access.check(request)).state, "expired");
    await pool.query("UPDATE runtime_state SET mode='restoring'");
    await assert.rejects(access.check(request), /source_unavailable/);
  },
);
test(
  "leases fence concurrent and late workers and leave holds accepted work",
  { skip: !databaseEnabled },
  async (t) => {
    const { pool, store, jobs, advance } = await fixture(t);
    await store.ingest(event);
    const claimed = await Promise.all([
      jobs.claim("download"),
      jobs.claim("download"),
    ]);
    assert.equal(claimed.filter(Boolean).length, 1);
    const first = claimed.find(Boolean)!;
    advance(61_000);
    const second = await jobs.claim("download");
    assert.ok(second);
    assert.notEqual(first.fence, second.fence);
    await assert.rejects(jobs.guard(first), /job_fenced/);
    await store.ingest({
      ...event,
      id: "leave",
      type: "leave",
      publishedAt: new Date(now.getTime() + 61_000),
      message: undefined,
    });
    assert.equal(
      (await pool.query("SELECT state FROM jobs WHERE kind='download'")).rows[0]
        .state,
      "held",
    );
    await assert.rejects(jobs.guard(second), /job_fenced/);
    assert.equal(
      (await pool.query("SELECT state FROM sources")).rows[0].state,
      "queued",
    );
  },
);

test(
  "deadline and crashed final attempt settle without resuming late work",
  { skip: !databaseEnabled },
  async (t) => {
    const { pool, store, jobs, advance } = await fixture(t);
    await store.ingest(event);
    const job = await jobs.claim("download");
    assert.ok(job);
    advance(15 * 60_000);
    const { sweepExpired } = await import("../src/domain/lifecycle.ts");
    await sweepExpired(store);
    assert.equal(
      (await pool.query("SELECT state FROM jobs WHERE kind='download'")).rows[0]
        .state,
      "failed",
    );
    assert.equal(
      (await pool.query("SELECT state FROM sources")).rows[0].state,
      "failed",
    );
    await assert.rejects(jobs.guard(job), /job_fenced/);
    assert.equal(await jobs.claim("download"), undefined);
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int n FROM jobs WHERE kind='cleanup'",
        )
      ).rows[0].n,
      1,
    );
  },
);

test(
  "fifth crashed lease settles only after expiry, including held groups",
  { skip: !databaseEnabled },
  async (t) => {
    const { pool, store, jobs, advance } = await fixture(t);
    await store.ingest(event);
    await pool.query("UPDATE jobs SET attempts=4");
    const job = await jobs.claim("download");
    assert.ok(job);
    const { sweepExpired } = await import("../src/domain/lifecycle.ts");
    await sweepExpired(store);
    assert.equal(
      (await pool.query("SELECT state FROM jobs WHERE kind='download'")).rows[0]
        .state,
      "leased",
    );
    await pool.query("UPDATE groups SET state='paused'");
    advance(61_000);
    await sweepExpired(store);
    assert.equal(
      (await pool.query("SELECT state FROM jobs WHERE kind='download'")).rows[0]
        .state,
      "failed",
    );
  },
);

test(
  "closed intake durably accepts signed denial events but rejects ordinary content and restoring writes",
  { skip: !databaseEnabled },
  async (t) => {
    const { pool, store } = await fixture(t);
    await store.ingest(event);
    await pool.query("UPDATE runtime_state SET mode='closed'");
    const { createServer } = await import("../src/bootstrap/server.ts");
    const { createHmac } = await import("node:crypto");
    const bot = `U${"b".repeat(32)}`;
    const app = createServer({
      channelSecret: "synthetic",
      checkDatabase: async () => {},
      intake: { botId: bot, ingest: (e) => store.ingest(e) },
    });
    t.after(() => app.close());
    async function send(type: string, extra = {}) {
      const body = JSON.stringify({
        destination: bot,
        events: [
          {
            type,
            webhookEventId: `closed-${type}`,
            timestamp: now.getTime(),
            source: { type: "group", groupId: group },
            ...extra,
          },
        ],
      });
      return app.inject({
        method: "POST",
        url: "/api/line/webhook",
        payload: body,
        headers: {
          "content-type": "application/json",
          "x-line-signature": createHmac("sha256", "synthetic")
            .update(body)
            .digest("base64"),
        },
      });
    }
    assert.equal(
      (await send("unsend", { unsend: { messageId: "message" } })).statusCode,
      200,
    );
    assert.equal(
      (await pool.query("SELECT state FROM sources")).rows[0].state,
      "revoked",
    );
    assert.equal(
      (
        await send("memberLeft", {
          left: { members: [{ type: "user", userId: `U${"a".repeat(32)}` }] },
        })
      ).statusCode,
      200,
    );
    assert.equal((await send("leave")).statusCode, 200);
    assert.equal(
      (await pool.query("SELECT state FROM groups")).rows[0].state,
      "left",
    );
    await assert.rejects(
      store.ingest({ ...event, id: "closed-message" }),
      /intake_closed/,
    );
    await pool.query("UPDATE runtime_state SET mode='restoring'");
    await assert.rejects(
      store.ingest({
        ...event,
        id: "restoring-unsend",
        type: "unsend",
        unsentMessageId: "other",
      }),
      /intake_closed/,
    );
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int n FROM event_receipts WHERE event_id IN ('closed-message','restoring-unsend')",
        )
      ).rows[0].n,
      0,
    );
  },
);
