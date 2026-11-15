import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { database, databaseEnabled } from "./database.ts";
import { Store } from "../src/persistence/store.ts";
import { LegacyHandoff } from "../src/domain/legacy.ts";
import { RetainedAccess } from "../src/domain/retained-access.ts";
import { createServer } from "../src/bootstrap/server.ts";
import { createRuntime } from "../src/bootstrap/runtime.ts";
import { Recovery } from "../src/domain/recovery.ts";

async function fixture(t: Parameters<typeof database>[0]) {
  const pool = await database(t),
    now = new Date();
  const store = new Store(pool, undefined, "retained-channel", () => now);
  const handoff = new LegacyHandoff(store);
  const entry = {
    id: randomUUID(),
    channelId: store.channelId,
    profile: "helper",
    groupId: "C" + "1".repeat(32),
    messageId: "retained-message",
    sourceKey: "retained-source",
    assetId: randomUUID(),
    collectionId: randomUUID(),
    itemId: randomUUID(),
    publishedAt: new Date(now.getTime() - 86400000).toISOString(),
    expiresAt: new Date(now.getTime() + 86400000).toISOString(),
    policyVersion: "legacy-scanned-14-days",
    revoked: false,
    cleanupOwner: "asset-api",
    ownerAcceptance: "a".repeat(64),
    publications: [],
  };
  const sibling = {
    ...entry,
    id: randomUUID(),
    messageId: "second-message",
    sourceKey: "second-source",
    itemId: randomUUID(),
    assetId: randomUUID(),
  };
  const manifestDigest = await handoff.import({
    version: 1,
    channelId: store.channelId,
    entries: [entry, sibling],
  });
  const access = new RetainedAccess(store);
  const request = (e = entry) => ({
    id: e.id,
    mode: "content" as const,
    sourceId: e.id,
    assetId: e.assetId,
    collectionId: e.collectionId,
    itemId: e.itemId,
    publishedAt: e.publishedAt,
    expiresAt: e.expiresAt,
  });
  const batch = {
    version: 1,
    generation: "1",
    manifestDigest,
    requests: [request()],
  };
  const event = (
    type: "leave" | "memberLeft" | "unsend",
    message = entry.messageId,
  ) =>
    store.ingest({
      id: randomUUID(),
      type,
      scope: "group",
      scopeId: entry.groupId,
      publishedAt: now,
      ...(type === "unsend" ? { unsentMessageId: message } : {}),
    });
  return {
    pool,
    store,
    handoff,
    entry,
    sibling,
    now,
    access,
    request,
    batch,
    event,
  };
}

test(
  "configured runtime stays ready for closed lifecycle service without admitting content",
  { skip: !databaseEnabled },
  async (t) => {
    const f = await fixture(t);
    await f.handoff.freeze(f.batch.manifestDigest, "b".repeat(64));
    const runtime = createRuntime(
      f.pool,
      {
        runtimeGeneration: "1",
        channelId: f.store.channelId,
        botId: "U" + "b".repeat(32),
        lineProfile: "helper",
        lineAccessToken: "synthetic",
        replyEncryptionKey: "a".repeat(64),
        accountOrigin: "https://account.invalid",
        accountToken: "b".repeat(64),
        assetOrigin: "https://asset.invalid",
        assetToken: "synthetic-asset",
        adminOrigin: "https://admin.invalid",
        sourceAccessToken: "c".repeat(64),
        gatewayToken: "d".repeat(64),
        lineLoginChannelId: "123",
        queueUrl: "https://fixture.queue.core.windows.net/harness",
        identityClientId: randomUUID(),
      },
      async () => {
        throw Error("unexpected_external_request");
      },
    );
    t.after(() => runtime.close());
    const app = createServer({
      channelSecret: "synthetic",
      checkDatabase: () => runtime.checkDatabase(),
      sourceAccess: runtime.sourceAccess,
      intake: runtime.intake,
    });
    t.after(() => app.close());
    assert.equal(
      (await app.inject({ method: "GET", url: "/readyz" })).statusCode,
      200,
    );
    assert.equal(
      (await runtime.sourceAccess.checkRetained(f.batch)).decisions[0]!.state,
      "active",
    );
    await assert.rejects(
      runtime.intake.ingest({
        id: "closed-content",
        type: "message",
        scope: "group",
        scopeId: f.entry.groupId,
        publishedAt: f.now,
        message: {
          id: "new-message",
          type: "text",
          text: "synthetic",
          mentionsBot: false,
        },
      }),
      /intake_closed/,
    );
    for (const sql of [
      "UPDATE runtime_state SET mode='restoring'",
      "UPDATE runtime_state SET mode='closed',generation=2",
      "DELETE FROM runtime_state",
    ]) {
      await f.pool.query(sql);
      assert.equal(
        (await app.inject({ method: "GET", url: "/readyz" })).statusCode,
        503,
      );
    }
  },
);

test(
  "retained authority requires exact frozen handoff but works with intake closed",
  { skip: !databaseEnabled },
  async (t) => {
    const f = await fixture(t);
    await assert.rejects(f.access.checkBatch(f.batch), /source_unavailable/);
    await f.handoff.freeze(f.batch.manifestDigest, "b".repeat(64));
    const r = await f.access.checkBatch(f.batch);
    assert.equal(r.generation, "1");
    assert.match(r.revision, /^[1-9][0-9]*$/);
    assert.deepEqual(r.decisions, [{ id: f.entry.id, state: "active" }]);
    assert.equal(
      (await f.pool.query("SELECT mode FROM runtime_state")).rows[0].mode,
      "closed",
    );
    for (const patch of [
      { generation: "2" },
      { manifestDigest: "f".repeat(64) },
      { expectedRevision: "999999" },
    ])
      await assert.rejects(
        f.access.checkBatch({ ...f.batch, ...patch }),
        /source_unavailable/,
      );
    await f.pool.query("UPDATE runtime_state SET mode='restoring'");
    await assert.rejects(f.access.checkBatch(f.batch), /source_unavailable/);
  },
);

test(
  "real retained recovery invalidates old generations and keeps restored groups blocked",
  { skip: !databaseEnabled },
  async (t) => {
    const f = await fixture(t);
    await f.handoff.freeze(f.batch.manifestDigest, "b".repeat(64));
    const before = await f.access.checkBatch(f.batch);
    await f.handoff.deny(f.sibling.id);
    const recovery = new Recovery(f.store, "f".repeat(64));
    const journal = await recovery.exportJournal();
    await recovery.restore(journal, f.now, "2");
    await assert.rejects(
      f.access.checkBatch({ ...f.batch, expectedRevision: before.revision }),
      /source_unavailable/,
    );
    const next = { ...f.batch, generation: "2" };
    await assert.rejects(f.access.checkBatch(next), /source_unavailable/);
    await f.handoff.freeze(f.batch.manifestDigest, "b".repeat(64));
    assert.deepEqual(
      (
        await f.access.checkBatch({
          ...next,
          requests: [f.request(), f.request(f.sibling)],
        })
      ).decisions.map((d) => d.state),
      ["paused", "revoked"],
    );
  },
);

test(
  "retained mapping and original deadlines never default to active",
  { skip: !databaseEnabled },
  async (t) => {
    const f = await fixture(t);
    await f.handoff.freeze(f.batch.manifestDigest, "b".repeat(64));
    for (const key of ["sourceId", "assetId", "collectionId", "itemId"])
      await assert.rejects(
        f.access.checkBatch({
          ...f.batch,
          requests: [{ ...f.request(), [key]: randomUUID() }],
        }),
        /source_unavailable/,
      );
    for (const key of ["publishedAt", "expiresAt"])
      await assert.rejects(
        f.access.checkBatch({
          ...f.batch,
          requests: [
            {
              ...f.request(),
              [key]: new Date(f.now.getTime() + 10).toISOString(),
            },
          ],
        }),
        /source_unavailable/,
      );
    f.now.setTime(Date.parse(f.entry.expiresAt));
    assert.equal(
      (await f.access.checkBatch(f.batch)).decisions[0]!.state,
      "expired",
    );
  },
);

test(
  "unsend and repeated membership changes fence the whole retained batch",
  { skip: !databaseEnabled },
  async (t) => {
    const f = await fixture(t);
    await f.handoff.freeze(f.batch.manifestDigest, "b".repeat(64));
    await f.pool.query("UPDATE legacy_sources SET revision=100 WHERE id=$1", [
      f.entry.id,
    ]);
    const before = await f.access.checkBatch(f.batch);
    await f.event("unsend", f.sibling.messageId);
    await assert.rejects(
      f.access.checkBatch({ ...f.batch, expectedRevision: before.revision }),
      /source_unavailable/,
    );
    const result = await f.access.checkBatch({
      ...f.batch,
      requests: [f.request(), f.request(f.sibling)],
    });
    assert.deepEqual(
      result.decisions.map((d) => d.state),
      ["active", "revoked"],
    );
    await f.event("memberLeft");
    const blocked = await f.access.checkBatch(f.batch);
    assert.equal(blocked.decisions[0]!.state, "paused");
    await f.event("memberLeft");
    await assert.rejects(
      f.access.checkBatch({ ...f.batch, expectedRevision: blocked.revision }),
      /source_unavailable/,
    );
    assert.equal(
      (
        await f.access.checkBatch({
          ...f.batch,
          requests: [f.request(f.sibling)],
        })
      ).decisions[0]!.state,
      "revoked",
    );
  },
);

test(
  "retained control remains discoverable for tombstones but respects group block",
  { skip: !databaseEnabled },
  async (t) => {
    const f = await fixture(t);
    await f.handoff.freeze(f.batch.manifestDigest, "b".repeat(64));
    const batch = {
      ...f.batch,
      requests: [
        { id: "control", mode: "control", collectionId: f.entry.collectionId },
      ],
    };
    await f.event("unsend");
    await f.event("unsend", f.sibling.messageId);
    assert.deepEqual((await f.access.checkBatch(batch)).decisions, [
      { id: "control", state: "active" },
    ]);
    await f.event("leave");
    assert.equal(
      (await f.access.checkBatch(batch)).decisions[0]!.state,
      "paused",
    );
    await assert.rejects(
      f.access.checkBatch({
        ...batch,
        requests: [{ ...batch.requests[0], collectionId: randomUUID() }],
      }),
      /source_unavailable/,
    );
  },
);

test(
  "retained callback rejects malformed batches and authenticates the existing Asset boundary",
  { skip: !databaseEnabled },
  async (t) => {
    const f = await fixture(t);
    await f.handoff.freeze(f.batch.manifestDigest, "b".repeat(64));
    for (const input of [
      { ...f.batch, extra: true },
      { ...f.batch, requests: [] },
      { ...f.batch, requests: [f.request(), f.request()] },
      {
        ...f.batch,
        requests: Array.from({ length: 101 }, (_, i) => ({
          ...f.request(),
          id: String(i),
        })),
      },
      { ...f.batch, requests: [{ ...f.request(), extra: true }] },
    ])
      await assert.rejects(
        f.access.checkBatch(input),
        /invalid_source_request/,
      );
    const token = "c".repeat(64);
    const app = createServer({
      channelSecret: "synthetic",
      checkDatabase: async () => {},
      sourceAccess: {
        token,
        check: async () => {
          throw Error("wrong_route");
        },
        checkBatch: async () => {
          throw Error("wrong_route");
        },
        checkRetained: (input) => f.access.checkBatch(input),
      },
    });
    t.after(() => app.close());
    const headers = {
      "content-type": "application/json",
      "x-hhc-harness-service-token": token,
      "x-hhc-harness-service-caller": "asset-api",
    };
    const call = (payload: unknown, override = {}) =>
      app.inject({
        method: "POST",
        url: "/priv/source/retained/check-batch",
        headers: { ...headers, ...override },
        payload: JSON.stringify(payload),
      });
    assert.equal((await call(f.batch)).statusCode, 200);
    assert.equal(
      (await call(f.batch, { "x-hhc-harness-service-token": "d".repeat(64) }))
        .statusCode,
      403,
    );
    assert.equal(
      (await call(f.batch, { "x-hhc-harness-service-caller": "legacy-bot" }))
        .statusCode,
      403,
    );
    assert.equal((await call({ ...f.batch, generation: 1 })).statusCode, 400);
    const unavailable = await call({
      ...f.batch,
      manifestDigest: "d".repeat(64),
    });
    assert.equal(unavailable.statusCode, 503);
    assert.deepEqual(unavailable.json(), { error: "source_unavailable" });
  },
);
