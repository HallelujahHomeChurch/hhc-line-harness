import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { database, databaseEnabled } from "./database.ts";
import { Store } from "../src/persistence/store.ts";
import { LegacyHandoff } from "../src/domain/legacy.ts";
import { RetainedAccess } from "../src/domain/retained-access.ts";
import { Management } from "../src/domain/management.ts";
import {
  Registration,
  type AdminAuthority,
} from "../src/domain/registration.ts";
import { auditEvent } from "../src/audit/outbox.ts";
import { createServer } from "../src/bootstrap/server.ts";

const actor = "11111111-1111-7111-8111-111111111111";
const line = "U" + "a".repeat(32),
  group = "C" + "b".repeat(32);
async function fixture(t: Parameters<typeof database>[0], extraGroups = 0) {
  const pool = await database(t),
    now = new Date();
  const store = new Store(pool, undefined, "retained-admin", () => now);
  const handoff = new LegacyHandoff(store);
  const entries = [0, 1, 2].map((i) => ({
    id: i === 0 ? "018f47d2-e5d1-7f3f-8f18-6c8e32621f73" : randomUUID(),
    channelId: store.channelId,
    profile: "helper",
    groupId: group,
    messageId: `message-${i}`,
    sourceKey: `source-${i}`,
    assetId: randomUUID(),
    collectionId: "22222222-2222-4222-8222-222222222222",
    itemId: randomUUID(),
    publishedAt: new Date(now.getTime() - 86400000).toISOString(),
    expiresAt: new Date(
      now.getTime() + (i === 2 ? -1000 : 86400000),
    ).toISOString(),
    policyVersion: "legacy-scanned-14-days",
    revoked: i === 1,
    cleanupOwner: "asset-api",
    ownerAcceptance: "a".repeat(64),
    publications: [],
  }));
  const baseTime = new Date(now.getTime() - 86400000)
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z");
  entries[0]!.publishedAt = baseTime;
  entries[1]!.publishedAt = baseTime.replace("Z", ".100Z");
  entries[2]!.publishedAt = baseTime.replace("Z", ".900Z");
  for (let i = 0; i < extraGroups; i++)
    entries.push({
      ...entries[0]!,
      id: randomUUID(),
      groupId: "C" + i.toString(16).padStart(32, "0"),
      messageId: `other-message-${i}`,
      sourceKey: `other-source-${i}`,
      collectionId: randomUUID(),
      itemId: randomUUID(),
      assetId: randomUUID(),
    });
  const manifestDigest = await handoff.import({
    version: 1,
    channelId: store.channelId,
    entries,
  });
  await handoff.freeze(manifestDigest, "b".repeat(64));
  const event = () =>
    store.ingest({
      id: randomUUID(),
      type: "memberLeft",
      scope: "group",
      scopeId: group,
      publishedAt: now,
    });
  await event();
  const authority: AdminAuthority & { lineUserId?: string } = {
    allowed: true,
    bound: true,
    actorUserId: actor,
    lineUserId: line,
    bindingGeneration: 1,
    adminAuthorizationRevision: 1,
  };
  let probe = async () => true;
  let summary = async () => "Retained group";
  let accountCalls = 0;
  let onSecondAccount = async () => {};
  const registration = new Registration(store, {
    authority: async () => ({ ...authority }),
    member: async (g, u) => {
      assert.equal(g, group);
      assert.equal(u, line);
      return probe();
    },
    groupName: async () => summary(),
    collection: async () => {
      throw Error("unexpected");
    },
    send: async () => {
      throw Error("unexpected");
    },
  });
  const management = new Management(store, registration, {
    authority: async () => {
      if (++accountCalls === 2) await onSecondAccount();
      return { ...authority };
    },
  });
  const input = async () => ({
    lineGroupId: group,
    manifestDigest,
    generation: "1",
    expectedRevision: (await pool.query("SELECT revision FROM legacy_handoffs"))
      .rows[0].revision,
  });
  const rows = async () =>
    (await pool.query("SELECT * FROM legacy_sources ORDER BY id")).rows;
  return {
    pool,
    store,
    now,
    entries,
    handoff,
    management,
    authority,
    event,
    input,
    rows,
    setProbe: (f: typeof probe) => {
      probe = f;
    },
    setSummary: (f: typeof summary) => {
      summary = f;
    },
    setSecondAccount: (f: typeof onSecondAccount) => {
      onSecondAccount = f;
    },
  };
}

test(
  "retained revalidation restores control but preserves terminal content, immutable data and cleanup",
  { skip: !databaseEnabled },
  async (t) => {
    const f = await fixture(t),
      before = await f.rows(),
      input = await f.input();
    const result = await f.management.revalidateRetainedGroup(actor, input);
    assert.equal(result.changedSourceCount, 3);
    assert.ok(BigInt(result.revision) > BigInt(input.expectedRevision));
    const after = await f.rows();
    for (let i = 0; i < before.length; i++) {
      const { group_blocked: _, revision: __, ...unchanged } = before[i];
      const { group_blocked, revision, ...actual } = after[i];
      assert.deepEqual(actual, unchanged);
      assert.equal(group_blocked, false);
      assert.equal(BigInt(revision), BigInt(before[i].revision) + 1n);
    }
    const access = new RetainedAccess(f.store);
    const response = await access.checkBatch({
      version: 1,
      generation: "1",
      manifestDigest: input.manifestDigest,
      requests: [
        {
          id: "control",
          mode: "control",
          collectionId: f.entries[0]!.collectionId,
        },
        ...f.entries.map((e) => ({
          id: e.id,
          mode: "content",
          sourceId: e.id,
          assetId: e.assetId,
          collectionId: e.collectionId,
          itemId: e.itemId,
          publishedAt: e.publishedAt,
          expiresAt: e.expiresAt,
        })),
      ],
    });
    assert.deepEqual(
      response.decisions.map((d) => d.state),
      ["active", "active", "revoked", "expired"],
    );
    const audit = (
      await f.pool.query("SELECT * FROM audit_outbox ORDER BY target_id")
    ).rows;
    assert.equal(audit.length, 3);
    for (const row of audit) {
      const e = auditEvent(row);
      assert.equal(e.action, "line.source.retained_revalidate");
      assert.equal(e.actorId, actor);
      assert.equal(
        e.metadata.revision,
        after.find((r) => r.id === row.target_id).revision,
      );
      assert.ok(!JSON.stringify(e).includes(group));
    }
    await assert.rejects(
      f.management.revalidateRetainedGroup(actor, input),
      /management_changed/,
    );
    assert.equal(
      (await f.management.revalidateRetainedGroup(actor, await f.input()))
        .changedSourceCount,
      0,
    );
    assert.equal(
      (await f.pool.query("SELECT count(*) FROM audit_outbox")).rows[0].count,
      "3",
    );
    assert.equal(
      (await f.pool.query("SELECT mode FROM runtime_state")).rows[0].mode,
      "closed",
    );
    assert.equal(
      (await f.pool.query("SELECT count(*) FROM groups")).rows[0].count,
      "0",
    );
    await f.handoff.deny(f.entries[0]!.id);
    await f.event();
    await f.management.revalidateRetainedGroup(actor, await f.input());
    assert.equal(
      (
        await access.checkBatch({
          version: 1,
          generation: "1",
          manifestDigest: input.manifestDigest,
          requests: [
            {
              id: "control",
              mode: "control",
              collectionId: f.entries[0]!.collectionId,
            },
          ],
        })
      ).decisions[0]!.state,
      "active",
    );
  },
);

test(
  "retained revalidation denies missing authority, membership, bot and invalid fences without writes",
  { skip: !databaseEnabled },
  async (t) => {
    for (const kind of [
      "admin",
      "unbound",
      "missing-line",
      "member",
      "bot",
      "restoring",
      "prepared",
      "generation",
      "revision",
      "digest",
      "recovery",
      "extra",
    ]) {
      await t.test(kind, async (t) => {
        const f = await fixture(t);
        const input = await f.input();
        if (kind === "admin") f.authority.allowed = false;
        if (kind === "unbound") f.authority.bound = false;
        if (kind === "missing-line") delete f.authority.lineUserId;
        if (kind === "member") f.setProbe(async () => false);
        if (kind === "bot")
          f.setSummary(async () => {
            throw Error("provider-private-data");
          });
        if (kind === "restoring")
          await f.pool.query("UPDATE runtime_state SET mode='restoring'");
        if (kind === "prepared")
          await f.pool.query("UPDATE legacy_handoffs SET state='prepared'");
        if (kind === "generation") input.generation = "2";
        if (kind === "revision") input.expectedRevision = "999999";
        if (kind === "digest") input.manifestDigest = "f".repeat(64);
        if (kind === "recovery")
          await f.pool.query(
            "INSERT INTO recovery_records(generation,journal_signature,journal_as_of,restored_at) VALUES(1,'synthetic',$1,$1)",
            [f.now],
          );
        await assert.rejects(
          f.management.revalidateRetainedGroup(
            actor,
            kind === "extra" ? { ...input, lineUserId: line } : input,
          ),
        );
        assert.ok((await f.rows()).every((r) => r.group_blocked));
        assert.equal(
          (await f.pool.query("SELECT count(*) FROM audit_outbox")).rows[0]
            .count,
          "0",
        );
      });
    }
  },
);

test(
  "retained revalidation fences repeated leave and changes observed in the final Account check",
  { skip: !databaseEnabled },
  async (t) => {
    for (const kind of [
      "leave",
      "global",
      "bindingGeneration",
      "adminAuthorizationRevision",
      "lineUserId",
      "actorUserId",
      "allowed",
    ]) {
      await t.test(kind, async (t) => {
        const f = await fixture(t);
        const input = await f.input();
        if (kind === "leave")
          f.setProbe(async () => {
            await f.event();
            await f.event();
            return true;
          });
        else if (kind === "global")
          f.setProbe(async () => {
            await f.pool.query("UPDATE legacy_handoffs SET evidence=evidence");
            return true;
          });
        else
          f.setSecondAccount(async () => {
            Object.assign(f.authority, {
              [kind]:
                kind === "allowed"
                  ? false
                  : kind === "lineUserId"
                    ? "U" + "c".repeat(32)
                    : kind === "actorUserId"
                      ? randomUUID()
                      : 2,
            });
          });
        await assert.rejects(
          f.management.revalidateRetainedGroup(actor, input),
        );
        assert.ok((await f.rows()).every((r) => r.group_blocked));
        assert.equal(
          (await f.pool.query("SELECT count(*) FROM audit_outbox")).rows[0]
            .count,
          "0",
        );
      });
    }
  },
);

test(
  "retained revalidation rolls back source updates if its audit insert fails",
  { skip: !databaseEnabled },
  async (t) => {
    const f = await fixture(t),
      before = await f.rows(),
      input = await f.input();
    await f.pool.query(
      "ALTER TABLE audit_outbox ADD CONSTRAINT test_reject_retained CHECK(action<>'line.source.retained_revalidate')",
    );
    await assert.rejects(f.management.revalidateRetainedGroup(actor, input));
    assert.deepEqual(await f.rows(), before);
    assert.deepEqual(await f.input(), input);
  },
);

test(
  "retained management HTTP shares exact Gateway authentication and keeps input and errors closed",
  { skip: !databaseEnabled },
  async (t) => {
    const f = await fixture(t),
      token = "d".repeat(64);
    const app = createServer({
      channelSecret: "synthetic",
      checkDatabase: async () => {},
      management: { service: f.management, token },
    });
    t.after(() => app.close());
    const headers = {
      "content-type": "application/json",
      "x-hhc-harness-gateway-token": token,
      "x-hhc-user-id": actor,
      "x-hhc-principal-type": "user",
      "x-hhc-auth-provider": "account-api",
    };
    const call = (suffix: string, payload: unknown, override = {}) =>
      app.inject({
        method: "POST",
        url: "/api/line/harness/admin/retained-groups/" + suffix,
        headers: { ...headers, ...override },
        payload: JSON.stringify(payload),
      });
    assert.equal(
      (
        await call(
          "search",
          {},
          { "x-hhc-harness-gateway-token": "e".repeat(64) },
        )
      ).statusCode,
      403,
    );
    const list = await call("search", {});
    assert.equal(list.statusCode, 200);
    assert.equal(list.json().groups.length, 1);
    assert.equal(
      Date.parse(list.json().groups[0].publishedFrom),
      Date.parse(f.entries[0]!.publishedAt),
    );
    assert.equal(
      Date.parse(list.json().groups[0].publishedTo),
      Date.parse(f.entries[2]!.publishedAt),
    );
    assert.equal(list.json().groups[0].lineGroupId, group);
    assert.ok(!list.body.includes("message-0"));
    assert.equal((await call("search", { cursor: "bad" })).statusCode, 400);
    assert.equal(
      (await call("revalidate", { ...(await f.input()), actorId: actor }))
        .statusCode,
      400,
    );
    for (const patch of [{ generation: "abc" }, { expectedRevision: "1.2" }])
      assert.equal(
        (await call("revalidate", { ...(await f.input()), ...patch }))
          .statusCode,
        400,
      );
    f.setSummary(async () => {
      throw Error("private-provider-payload");
    });
    const failed = await call("revalidate", await f.input());
    assert.equal(failed.statusCode, 503);
    assert.deepEqual(failed.json(), { error: "management_unavailable" });
    f.setSummary(async () => "Retained group");
    assert.equal((await call("revalidate", await f.input())).statusCode, 200);
  },
);

test(
  "retained group metadata paginates without admission, tolerates missing names and isolates exact group",
  { skip: !databaseEnabled },
  async (t) => {
    const f = await fixture(t, 22);
    f.setSummary(async () => {
      throw Error("absent");
    });
    const first = await f.management.retainedGroups(actor, {});
    assert.equal(first.groups.length, 20);
    assert.equal(first.hasMore, true);
    assert.equal(first.ready, true);
    assert.ok(first.groups.every((g) => g.displayName === null));
    const second = await f.management.retainedGroups(actor, {
      cursor: first.cursor,
    });
    assert.equal(second.groups.length, 3);
    assert.equal(second.hasMore, false);
    assert.equal(
      new Set([...first.groups, ...second.groups].map((g) => g.lineGroupId))
        .size,
      23,
    );
    const input = await f.input();
    await assert.rejects(
      f.management.revalidateRetainedGroup(actor, {
        ...input,
        lineGroupId: "C" + "f".repeat(32),
      }),
      /management_changed/,
    );
    const other = f.entries[3]!;
    f.setProbe(async () => {
      await f.handoff.deny(other.id);
      return true;
    });
    f.setSummary(async () => "Retained group");
    await assert.rejects(
      f.management.revalidateRetainedGroup(actor, input),
      /management_changed/,
    );
    f.setProbe(async () => true);
    assert.equal(
      (await f.management.revalidateRetainedGroup(actor, await f.input()))
        .changedSourceCount,
      3,
    );
    assert.equal(
      (
        await f.pool.query("SELECT state FROM legacy_sources WHERE id=$1", [
          other.id,
        ])
      ).rows[0].state,
      "revoked",
    );
    f.authority.bound = false;
    delete f.authority.lineUserId;
    assert.equal(
      (await f.management.retainedGroups(actor, {})).groups.length,
      20,
    );
  },
);
