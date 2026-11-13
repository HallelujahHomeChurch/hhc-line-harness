import assert from "node:assert/strict";
import { test } from "node:test";
import { database, databaseEnabled } from "./database.ts";
import { Store } from "../src/persistence/store.ts";
import { ReplyTokenCipher } from "../src/reply/token.ts";
import { sweepExpired } from "../src/domain/lifecycle.ts";
import { CleanupWorker } from "../src/worker/cleanup.ts";
const now = new Date("2026-11-12T12:00:00Z"),
  group = `C${"c".repeat(32)}`;
test(
  "expiry erases local content, durably schedules cleanup and retains unknown uploads for reconciliation",
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
    let clock = now;
    const store = new Store(
      pool,
      new ReplyTokenCipher("a".repeat(64)),
      "channel",
      () => clock,
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
        fileName: "private.pdf",
        mentionsBot: false,
      },
    });
    await pool.query("UPDATE sources SET upload_state='intent'");
    clock = new Date(now.getTime() + 90 * 86400000);
    await sweepExpired(store);
    assert.deepEqual(
      (await pool.query("SELECT state,body,file_name FROM sources")).rows[0],
      { state: "expired", body: null, file_name: null },
    );
    let removed = 0;
    const worker = new CleanupWorker(store, {
      lookup: async () => undefined,
      remove: async () => {
        removed++;
      },
    });
    await worker.processOne();
    assert.equal(removed, 0);
    assert.equal(
      (await pool.query("SELECT state FROM jobs WHERE kind='cleanup'")).rows[0]
        .state,
      "retry_wait",
    );
  },
);
