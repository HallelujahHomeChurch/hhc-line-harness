import assert from "node:assert/strict";
import { test } from "node:test";
import { database, databaseEnabled } from "./database.ts";
import { Store } from "../src/persistence/store.ts";
import { ReplyTokenCipher } from "../src/reply/token.ts";
import type { LineEvent } from "../src/domain/events.ts";
const now = new Date("2026-11-12T12:00:00Z");
const group = `C${"c".repeat(32)}`;
const actor = `U${"a".repeat(32)}`;
const event: LineEvent = {
  id: "event-1",
  type: "message",
  publishedAt: now,
  scope: "group",
  scopeId: group,
  actorId: actor,
  message: {
    id: "message-1",
    type: "file",
    fileName: "document.pdf",
    mentionsBot: false,
  },
};
async function fixture(t: Parameters<typeof database>[0]) {
  const pool = await database(t);
  await pool.query("UPDATE runtime_state SET mode='open', ingest_floor=$1", [
    new Date(now.getTime() - 60_000),
  ]);
  await pool.query(
    "INSERT INTO groups(channel_id,line_group_id,state,active_from) VALUES('channel',$1,'active',$2)",
    [group, new Date(now.getTime() - 30_000)],
  );
  return {
    pool,
    store: new Store(
      pool,
      new ReplyTokenCipher("a".repeat(64)),
      "channel",
      () => now,
    ),
  };
}
test(
  "receipt, original, job and wake commit once across concurrent redelivery",
  { skip: !databaseEnabled },
  async (t) => {
    const { pool, store } = await fixture(t);
    await Promise.all(Array.from({ length: 5 }, () => store.ingest(event)));
    for (const table of ["event_receipts", "sources", "jobs", "job_wakes"])
      assert.equal(
        (await pool.query(`SELECT count(*)::int AS count FROM ${table}`))
          .rows[0].count,
        1,
        table,
      );
    const source = (
      await pool.query("SELECT published_at,expires_at,state FROM sources")
    ).rows[0];
    assert.equal(source.state, "queued");
    assert.equal(
      source.expires_at.getTime() - source.published_at.getTime(),
      90 * 24 * 60 * 60 * 1000,
    );
  },
);
test(
  "failed wake rolls back receipt and original; retry can commit",
  { skip: !databaseEnabled },
  async (t) => {
    const { pool, store } = await fixture(t);
    await pool.query(
      "CREATE FUNCTION fail_wake() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic'; END $$; CREATE TRIGGER fail_wake BEFORE INSERT ON job_wakes FOR EACH ROW EXECUTE FUNCTION fail_wake()",
    );
    await assert.rejects(store.ingest(event));
    assert.equal(
      (await pool.query("SELECT count(*)::int AS count FROM event_receipts"))
        .rows[0].count,
      0,
    );
    assert.equal(
      (await pool.query("SELECT count(*)::int AS count FROM sources")).rows[0]
        .count,
      0,
    );
    await pool.query("DROP TRIGGER fail_wake ON job_wakes");
    await store.ingest(event);
  },
);
test(
  "inactive and old events retain no content and cannot create background work",
  { skip: !databaseEnabled },
  async (t) => {
    const { pool, store } = await fixture(t);
    await pool.query("UPDATE groups SET state='paused'");
    await store.ingest({
      ...event,
      message: {
        id: "message-1",
        type: "text",
        text: "private text must not persist",
        mentionsBot: false,
      },
    });
    assert.equal(
      (await pool.query("SELECT count(*)::int AS count FROM sources")).rows[0]
        .count,
      0,
    );
    assert.equal(
      (await pool.query("SELECT count(*)::int AS count FROM jobs")).rows[0]
        .count,
      0,
    );
    await pool.query("UPDATE groups SET state='active'");
    await store.ingest({
      ...event,
      id: "old-event",
      publishedAt: new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000),
    });
    assert.equal(
      (await pool.query("SELECT count(*)::int AS count FROM sources")).rows[0]
        .count,
      0,
    );
  },
);
