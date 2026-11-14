import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { database, databaseEnabled } from "./database.ts";
import { Store } from "../src/persistence/store.ts";
import { LegacyHandoff } from "../src/domain/legacy.ts";
import { Recovery } from "../src/domain/recovery.ts";
import { sweepExpired } from "../src/domain/lifecycle.ts";
const proof = "a".repeat(64);
async function fixture(t: Parameters<typeof database>[0]) {
  const pool = await database(t),
    now = new Date();
  const store = new Store(pool, undefined, "channel", () => now);
  const entry = {
    id: randomUUID(),
    channelId: "channel",
    profile: "helper",
    groupId: "C" + "1".repeat(32),
    messageId: "12345",
    sourceKey: "line:helper:12345",
    assetId: randomUUID(),
    collectionId: randomUUID(),
    itemId: randomUUID(),
    publishedAt: new Date(now.getTime() - 86400000).toISOString(),
    expiresAt: new Date(now.getTime() + 86400000).toISOString(),
    policyVersion: "legacy-v1",
    revoked: false,
    cleanupOwner: "asset-lifecycle-owner",
    ownerAcceptance: proof,
    publications: [
      {
        kind: "graph" as const,
        handle: "opaque-handle",
        outcome: "unknown" as const,
      },
    ],
  };
  const manifest = {
    version: 1 as const,
    channelId: "channel",
    entries: [entry],
  };
  return {
    pool,
    now,
    store,
    entry,
    manifest,
    handoff: new LegacyHandoff(store),
  };
}
test(
  "legacy manifest is immutable, cannot open admission before single-writer handoff or replay unknown publication",
  { skip: !databaseEnabled },
  async (t) => {
    const f = await fixture(t);
    const digest = await f.handoff.import(f.manifest);
    assert.equal(await f.handoff.import(f.manifest), digest);
    await assert.rejects(
      f.handoff.import({
        ...f.manifest,
        entries: [
          {
            ...f.entry,
            expiresAt: new Date(f.now.getTime() + 9999999).toISOString(),
          },
        ],
      }),
    );
    await assert.rejects(f.pool.query("UPDATE runtime_state SET mode='open'"));
    await assert.rejects(f.handoff.freeze(digest, "not-evidence"));
    await f.handoff.freeze(digest, proof);
    await assert.rejects(
      f.handoff.activate(digest, {
        consumerAcceptance: proof,
        intentsCancelled: proof,
        externalEffectsReconciled: proof,
        compatibleRollback: proof,
      }),
    );
    await f.handoff.reconcile(f.entry.id, 0, {
      outcome: "absent",
      handle: null,
      evidence: proof,
    });
    await f.handoff.activate(digest, {
      consumerAcceptance: proof,
      intentsCancelled: proof,
      externalEffectsReconciled: proof,
      compatibleRollback: proof,
    });
    await f.pool.query("UPDATE runtime_state SET mode='open'");
    assert.equal(
      (await f.pool.query("SELECT count(*)::int n FROM groups")).rows[0].n,
      0,
    );
    assert.equal(
      (await f.pool.query("SELECT count(*)::int n FROM sources")).rows[0].n,
      0,
    );
  },
);
test(
  "legacy unsend without registered group and original expiry create durable owner cleanup without republishing",
  { skip: !databaseEnabled },
  async (t) => {
    const f = await fixture(t);
    const digest = await f.handoff.import(f.manifest);
    await f.handoff.freeze(digest, proof);
    await f.handoff.reconcile(f.entry.id, 0, {
      outcome: "present",
      handle: "opaque-handle",
      evidence: proof,
    });
    await f.handoff.activate(digest, {
      consumerAcceptance: proof,
      intentsCancelled: proof,
      externalEffectsReconciled: proof,
      compatibleRollback: proof,
    });
    await f.pool.query("UPDATE runtime_state SET mode='open'");
    await f.store.ingest({
      id: "unsend",
      scope: "group",
      scopeId: f.entry.groupId,
      type: "unsend",
      publishedAt: f.now,
      unsentMessageId: f.entry.messageId,
    });
    const pending = await f.handoff.pending();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].state, "revoked");
    await assert.rejects(f.handoff.acknowledge(f.entry.id, "0", proof));
    await f.handoff.acknowledge(f.entry.id, pending[0].revision, proof);
    assert.equal((await f.handoff.pending()).length, 0);
    await assert.rejects(
      f.pool.query("UPDATE legacy_sources SET state='active'"),
    );
    const other = await fixture(t);
    other.entry.expiresAt = other.now.toISOString();
    await other.handoff.import(other.manifest);
    await sweepExpired(other.store);
    assert.equal((await other.handoff.pending())[0].state, "expired");
  },
);
test(
  "current legacy journal survives old restore and blocks reopening until handoff is reverified",
  { skip: !databaseEnabled },
  async (t) => {
    const f = await fixture(t);
    await f.handoff.import(f.manifest);
    const recovery = new Recovery(f.store, "f".repeat(64));
    await f.handoff.deny(f.entry.id);
    const journal = await recovery.exportJournal();
    await f.pool.query(
      "DELETE FROM legacy_sources; DELETE FROM legacy_handoffs",
    );
    await recovery.restore(journal, f.now, "2");
    assert.equal((await f.handoff.pending())[0].state, "revoked");
    await assert.rejects(recovery.admit("2", journal.signature));
    assert.equal(
      (await f.pool.query("SELECT state FROM legacy_handoffs")).rows[0].state,
      "prepared",
    );
  },
);

test(
  "retirement remains blocked by absent evidence, unknown effects and unconfirmed cleanup",
  { skip: !databaseEnabled },
  async (t) => {
    const { retirementBlockers } = await import("../src/domain/legacy.ts");
    const f = await fixture(t);
    await f.handoff.import(f.manifest);
    await f.handoff.deny(f.entry.id);
    assert.deepEqual(await retirementBlockers(f.store, {}), [
      "missing_retirement_evidence",
      "handoff_incomplete",
      "cleanup_unconfirmed",
      "publication_unknown",
    ]);
    await assert.rejects(f.handoff.acknowledge(f.entry.id, "2", proof));
    await f.handoff.reconcile(f.entry.id, 0, {
      outcome: "absent",
      handle: null,
      evidence: proof,
    });
    await assert.rejects(
      f.handoff.reconcile(f.entry.id, 0, {
        outcome: "present",
        handle: "different",
        evidence: proof,
      }),
    );
    const result = await retirementBlockers(f.store, {
      featuresDecided: proof,
      consumersMigrated: proof,
      lifecycleOwnersAccepted: proof,
      outboxDrained: proof,
      restoreAccepted: proof,
      legacyCredentialsRejected: proof,
      legacySchedulersDisabled: proof,
      productionAccepted: proof,
      rollbackUntil: new Date(f.now.getTime() + 86400000).toISOString(),
    });
    assert.ok(result.includes("rollback_window_open"));
  },
);

test(
  "unsend before import, missing ownership and group departure stay denied",
  { skip: !databaseEnabled },
  async (t) => {
    const f = await fixture(t);
    await assert.rejects(
      f.handoff.import({
        ...f.manifest,
        entries: [{ ...f.entry, cleanupOwner: "" }],
      }),
    );
    await f.pool.query("UPDATE runtime_state SET mode='open'");
    await f.store.ingest({
      id: "before-import",
      scope: "group",
      scopeId: f.entry.groupId,
      type: "unsend",
      publishedAt: f.now,
      unsentMessageId: f.entry.messageId,
    });
    await f.pool.query("UPDATE runtime_state SET mode='closed'");
    const digest = await f.handoff.import(f.manifest);
    assert.equal((await f.handoff.pending())[0].state, "revoked");
    await f.handoff.freeze(digest, proof);
    await f.handoff.reconcile(f.entry.id, 0, {
      outcome: "absent",
      handle: null,
      evidence: proof,
    });
    await f.handoff.activate(digest, {
      consumerAcceptance: proof,
      intentsCancelled: proof,
      externalEffectsReconciled: proof,
      compatibleRollback: proof,
    });
    await f.pool.query("UPDATE runtime_state SET mode='open'");
    await f.store.ingest({
      id: "left",
      scope: "group",
      scopeId: f.entry.groupId,
      type: "leave",
      publishedAt: f.now,
    });
    assert.equal((await f.handoff.pending())[0].group_blocked, true);
  },
);

test(
  "closed handoff records legacy unsend before ordinary admission",
  { skip: !databaseEnabled },
  async (t) => {
    const f = await fixture(t);
    await f.handoff.import(f.manifest);
    await f.store.ingest({
      id: "closed-unsend",
      scope: "group",
      scopeId: f.entry.groupId,
      type: "unsend",
      publishedAt: f.now,
      unsentMessageId: f.entry.messageId,
    });
    assert.equal((await f.handoff.pending())[0].state, "revoked");
    assert.equal(
      (await f.pool.query("SELECT mode FROM runtime_state")).rows[0].mode,
      "closed",
    );
  },
);
