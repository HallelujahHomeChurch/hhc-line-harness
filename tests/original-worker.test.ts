import assert from "node:assert/strict";
import { test } from "node:test";
import { database, databaseEnabled } from "./database.ts";
import { Store } from "../src/persistence/store.ts";
import { ReplyTokenCipher } from "../src/reply/token.ts";
import { OriginalWorker } from "../src/worker/original.ts";
import type { AssetRecord, OriginalPorts } from "../src/worker/original.ts";
const now = new Date("2026-11-12T12:00:00Z"),
  group = `C${"c".repeat(32)}`;
async function fixture(t: Parameters<typeof database>[0]) {
  const pool = await database(t);
  await pool.query("UPDATE runtime_state SET mode='open',ingest_floor=$1", [
    new Date(now.getTime() - 60000),
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
    id: "original",
    type: "message",
    scope: "group",
    scopeId: group,
    publishedAt: now,
    message: {
      id: "message",
      type: "file",
      fileName: "file.pdf",
      mentionsBot: false,
    },
  });
  const source = (await pool.query("SELECT * FROM sources")).rows[0];
  let asset: AssetRecord | undefined;
  const calls = {
    downloads: 0,
    creates: 0,
    uploads: 0,
    completes: 0,
    disposes: 0,
  };
  const flags = { loseCompletion: true, revokeAtCreate: false };
  const ports: OriginalPorts = {
    download: async () => {
      calls.downloads++;
      return {
        path: "/synthetic/fixture",
        size: 4,
        checksum: "a".repeat(64),
        mime: "application/pdf",
        fileName: "file.pdf",
        dispose: async () => {
          calls.disposes++;
        },
      };
    },
    lookup: async () => asset,
    inspect: async () => asset!,
    create: async () => {
      calls.creates++;
      asset = {
        id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        ref: source.id,
        revision: source.asset_source_revision,
        publishedAt: source.published_at.toISOString(),
        expiresAt: source.expires_at.toISOString(),
        ready: false,
        etag: "",
        size: 0,
        checksum: "",
        mime: "application/pdf",
      };
      if (flags.revokeAtCreate)
        await store.ingest({
          id: "unsend",
          type: "unsend",
          scope: "group",
          scopeId: group,
          publishedAt: now,
          unsentMessageId: "message",
        });
      return { asset, target: {} };
    },
    put: async () => {
      calls.uploads++;
    },
    complete: async () => {
      calls.completes++;
      asset = {
        ...asset!,
        ready: true,
        etag: "etag",
        size: 4,
        checksum: "a".repeat(64),
      };
      if (flags.loseCompletion) {
        flags.loseCompletion = false;
        throw new Error("lost response");
      }
      return asset;
    },
  };
  return {
    pool,
    store,
    ports,
    calls,
    flags,
    advance: () => {
      clock = new Date(clock.getTime() + 3000);
    },
  };
}
test(
  "unknown completion reconciles the same original without redownload or second upload",
  { skip: !databaseEnabled },
  async (t) => {
    const { pool, store, ports, calls, advance } = await fixture(t);
    await new OriginalWorker(store, ports).processOne();
    assert.equal(
      (await pool.query("SELECT state FROM sources")).rows[0].state,
      "queued",
    );
    advance();
    await new OriginalWorker(store, ports).processOne();
    assert.equal(
      (await pool.query("SELECT state FROM sources")).rows[0].state,
      "ready",
    );
    assert.deepEqual(calls, {
      downloads: 1,
      creates: 1,
      uploads: 1,
      completes: 1,
      disposes: 1,
    });
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM jobs WHERE kind='index'",
        )
      ).rows[0].n,
      1,
    );
  },
);
test(
  "late external Asset ID after unsend is retained for cleanup and never uploaded/published",
  { skip: !databaseEnabled },
  async (t) => {
    const { pool, store, ports, calls, flags } = await fixture(t);
    flags.revokeAtCreate = true;
    await new OriginalWorker(store, ports).processOne();
    assert.equal(
      (await pool.query("SELECT state FROM sources")).rows[0].state,
      "revoked",
    );
    assert.equal(
      (await pool.query("SELECT count(*)::int AS n FROM orphan_assets")).rows[0]
        .n,
      1,
    );
    assert.equal(calls.uploads, 0);
    assert.equal(calls.disposes, 1);
  },
);
