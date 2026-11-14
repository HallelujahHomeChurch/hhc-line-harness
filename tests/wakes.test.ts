import assert from "node:assert/strict";
import { test } from "node:test";
import { database, databaseEnabled } from "./database.ts";
import { Store } from "../src/persistence/store.ts";
import { ReplyTokenCipher } from "../src/reply/token.ts";
import { WakeDispatcher } from "../src/worker/wakes.ts";
const now = new Date("2026-11-12T12:00:00Z");
test(
  "wake reservation is concurrent-safe and retries ambiguous sends with only an opaque job ID",
  { skip: !databaseEnabled },
  async (t) => {
    const pool = await database(t);
    await pool.query("UPDATE runtime_state SET mode='open',ingest_floor=$1", [
      now,
    ]);
    await pool.query(
      "INSERT INTO groups(channel_id,line_group_id,state,active_from) VALUES('channel',$1,'active',$2)",
      [`C${"c".repeat(32)}`, now],
    );
    let clock = now;
    const store = new Store(
      pool,
      new ReplyTokenCipher("a".repeat(64)),
      "channel",
      () => clock,
    );
    await store.ingest({
      id: "event",
      scope: "group",
      scopeId: `C${"c".repeat(32)}`,
      publishedAt: now,
      type: "message",
      message: {
        id: "message",
        type: "file",
        fileName: "private.pdf",
        mentionsBot: false,
      },
    });
    let sends = 0;
    const send = async (id: string) => {
      assert.match(id, /^[0-9a-f-]{36}$/);
      sends++;
      if (sends === 1) throw new Error("unknown");
    };
    const dispatcher = new WakeDispatcher(store, send);
    await Promise.allSettled([
      dispatcher.processOne(),
      dispatcher.processOne(),
    ]);
    assert.equal(sends, 1);
    clock = new Date(clock.getTime() + 11_000);
    await dispatcher.processOne();
    assert.equal(sends, 2);
    assert.ok(
      (await pool.query("SELECT delivered_at FROM job_wakes")).rows[0]
        .delivered_at,
    );
    await dispatcher.processOne();
    assert.equal(sends, 2);
  },
);

test(
  "closed admission dispatches only lifecycle wakes and restoring dispatches none",
  { skip: !databaseEnabled },
  async (t) => {
    const pool = await database(t);
    await pool.query("UPDATE runtime_state SET mode='open',ingest_floor=$1", [
      now,
    ]);
    await pool.query(
      "INSERT INTO groups(channel_id,line_group_id,state,active_from) VALUES('channel',$1,'active',$2)",
      ["C" + "d".repeat(32), now],
    );
    const store = new Store(
      pool,
      new ReplyTokenCipher("a".repeat(64)),
      "channel",
      () => now,
    );
    await store.ingest({
      id: "wake-event",
      scope: "group",
      scopeId: "C" + "d".repeat(32),
      publishedAt: now,
      type: "message",
      message: {
        id: "wake-message",
        type: "file",
        fileName: "file.pdf",
        mentionsBot: false,
      },
    });
    await pool.query(
      "INSERT INTO jobs(source_id,kind,runtime_generation,source_revision,created_at,available_at) SELECT id,k,1,revision,$1,$1 FROM sources CROSS JOIN unnest(ARRAY['cleanup','unpublish']) k",
      [now],
    );
    await pool.query(
      "INSERT INTO job_wakes(job_id,created_at) SELECT id,$1 FROM jobs ON CONFLICT DO NOTHING",
      [now],
    );
    const sent: string[] = [];
    const wakes = new WakeDispatcher(store, async (id) => {
      sent.push(id);
    });
    await pool.query("UPDATE runtime_state SET mode='restoring'");
    assert.equal(await wakes.processOne(), false);
    await pool.query("UPDATE runtime_state SET mode='closed'");
    assert.equal(await wakes.processOne(), true);
    assert.equal(await wakes.processOne(), true);
    assert.equal(await wakes.processOne(), false);
    assert.deepEqual(
      (
        await pool.query(
          "SELECT kind FROM jobs WHERE id=ANY($1) ORDER BY kind",
          [sent],
        )
      ).rows.map((x) => x.kind),
      ["cleanup", "unpublish"],
    );
  },
);
