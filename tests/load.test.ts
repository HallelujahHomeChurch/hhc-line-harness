import assert from "node:assert/strict";
import { test } from "node:test";
import { performance } from "node:perf_hooks";
import { database, databaseEnabled } from "./database.ts";
import { Store } from "../src/persistence/store.ts";
import type { LineEvent } from "../src/domain/events.ts";
test(
  "bounded synthetic intake load preserves all receipts and deduplicates retries",
  { skip: !databaseEnabled },
  async (t) => {
    const pool = await database(t),
      now = new Date(),
      store = new Store(pool, undefined, "load-channel", () => now);
    await pool.query("UPDATE runtime_state SET mode='open',ingest_floor=$1", [
      new Date(now.getTime() - 60000),
    ]);
    await pool.query(
      "INSERT INTO groups(channel_id,line_group_id,state,active_from) VALUES('load-channel','Cload','active',$1)",
      [new Date(now.getTime() - 60000)],
    );
    const latencies: number[] = [],
      count = 500,
      concurrency = 8;
    let cursor = 0;
    const event = (i: number): LineEvent => ({
      id: `load-${i}`,
      type: "message",
      publishedAt: now,
      scope: "group",
      scopeId: "Cload",
      message: {
        id: `message-${i}`,
        type: "text",
        text: "synthetic",
        mentionsBot: false,
      },
    });
    const start = performance.now();
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        while (cursor < count) {
          const n = cursor++,
            at = performance.now();
          await store.ingest(event(n));
          latencies.push(performance.now() - at);
        }
      }),
    );
    for (let n = 0; n < 50; n++) await store.ingest(event(n));
    assert.equal(
      (await pool.query("SELECT count(*)::int n FROM sources")).rows[0].n,
      count,
    );
    assert.equal(
      (await pool.query("SELECT count(*)::int n FROM event_receipts")).rows[0]
        .n,
      count,
    );
    latencies.sort((a, b) => a - b);
    t.diagnostic(
      JSON.stringify({
        fixture: "local-single-group-postgres",
        events: count,
        concurrency,
        duplicateRetries: 50,
        elapsedMs: Math.round(performance.now() - start),
        p50Ms: Math.round(latencies[Math.floor(count * 0.5)]! * 100) / 100,
        p95Ms: Math.round(latencies[Math.floor(count * 0.95)]! * 100) / 100,
        p99Ms: Math.round(latencies[Math.floor(count * 0.99)]! * 100) / 100,
      }),
    );
  },
);
