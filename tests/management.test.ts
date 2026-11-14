import assert from "node:assert/strict";
import { test } from "node:test";
import { database, databaseEnabled } from "./database.ts";
import { Store } from "../src/persistence/store.ts";
import { ReplyTokenCipher } from "../src/reply/token.ts";
import { Registration } from "../src/domain/registration.ts";
import { Management } from "../src/domain/management.ts";
const now = new Date("2026-11-12T12:00:00Z"),
  line = `U${"a".repeat(32)}`,
  group = `C${"b".repeat(32)}`,
  actor = "11111111-1111-7111-8111-111111111111";
async function fixture(t: Parameters<typeof database>[0]) {
  const pool = await database(t);
  await pool.query("UPDATE runtime_state SET mode='open',ingest_floor=$1", [
    now,
  ]);
  const store = new Store(
    pool,
    new ReplyTokenCipher("a".repeat(64)),
    "channel",
    () => now,
  );
  let revision = 1,
    bound = true,
    allowed = true;
  const authority = async () => ({
    allowed,
    bound,
    actorUserId: actor,
    adminAuthorizationRevision: revision,
    ...(bound ? { bindingGeneration: 1 } : {}),
  });
  const registration = new Registration(store, {
    authority,
    member: async () => true,
    collection: async () => {
      throw Error("unused");
    },
    send: async () => {},
  });
  const management = new Management(store, registration, {
    authority: async () => authority(),
  });
  return {
    pool,
    store,
    registration,
    management,
    change: (a: boolean, b: boolean, r: number) => {
      allowed = a;
      bound = b;
      revision = r;
    },
  };
}
test(
  "website setup is same verified actor only and exposes no message content",
  { skip: !databaseEnabled },
  async (t) => {
    const { registration, management, change } = await fixture(t);
    const id = await registration.begin(group, line);
    const context = await management.setup(actor, id);
    assert.equal(context.state, "bootstrap");
    assert.equal(JSON.stringify(context).includes(line), false);
    await assert.rejects(
      management.setup("22222222-2222-4222-8222-222222222222", id),
      /admin_required/,
    );
    await management.configure(actor, id, {
      sharing: false,
      expectedRevision: 1,
    });
    assert.equal((await management.setup(actor, id)).state, "draft");
    await assert.rejects(
      management.configure(actor, id, { sharing: false, expectedRevision: 1 }),
      /setup_expired_or_changed/,
    );
    change(true, false, 2);
    assert.equal((await management.setup(actor, id)).state, "binding_required");
    change(false, true, 3);
    await assert.rejects(management.setup(actor, id), /admin_required/);
  },
);
test(
  "unbound current Admin may preview and confirm shrink; old revisions never regain approval",
  { skip: !databaseEnabled },
  async (t) => {
    const { pool, registration, management, change } = await fixture(t);
    await registration.begin(group, line);
    const g = (
      await pool.query(
        "UPDATE groups SET state='active',active_from=$1 RETURNING id",
        [now],
      )
    ).rows[0];
    change(true, false, 2);
    const p = await management.preview(actor, g.id, "pause", 1);
    change(true, false, 3);
    await assert.rejects(
      management.confirm(actor, p.id, p.token),
      /management_changed/,
    );
    const fresh = await management.preview(actor, g.id, "pause", 1);
    await management.confirm(actor, fresh.id, fresh.token);
    assert.equal(
      (await pool.query("SELECT state FROM groups")).rows[0].state,
      "paused",
    );
    await management.confirm(actor, fresh.id, fresh.token);
    assert.equal(
      (await pool.query("SELECT count(*)::int n FROM audit_outbox")).rows[0].n,
      1,
    );
  },
);
test(
  "deletion denies immediately and queues cleanup without deleting unrelated group",
  { skip: !databaseEnabled },
  async (t) => {
    const { pool, store, registration, management } = await fixture(t);
    await registration.begin(group, line);
    const g = (
      await pool.query(
        "UPDATE groups SET state='active',active_from=$1 RETURNING id",
        [now],
      )
    ).rows[0];
    await store.ingest({
      id: "e",
      type: "message",
      scope: "group",
      scopeId: group,
      publishedAt: now,
      actorId: line,
      message: {
        id: "m",
        type: "text",
        text: "private original",
        mentionsBot: false,
      },
    });
    const p = await management.preview(actor, g.id, "delete", 1);
    await management.confirm(actor, p.id, p.token);
    assert.equal(
      (await pool.query("SELECT state FROM groups")).rows[0].state,
      "deleting",
    );
    const { sweepExpired } = await import("../src/domain/lifecycle.ts");
    await sweepExpired(store);
    assert.equal(
      (await pool.query("SELECT state FROM sources")).rows[0].state,
      "revoked",
    );
    assert.equal(
      (await pool.query("SELECT body FROM sources")).rows[0].body,
      null,
    );
    const list = await management.groups(actor);
    assert.equal(JSON.stringify(list).includes("private original"), false);
  },
);

test(
  "empty collection creation persists one actor-bound operation before an ambiguous Asset call",
  { skip: !databaseEnabled },
  async (t) => {
    const { pool, management } = await fixture(t);
    let calls = 0;
    management.ports.createCollection = async (id, name, owner) => {
      calls++;
      assert.equal(owner, actor);
      assert.equal(
        (
          await pool.query(
            "SELECT name FROM collection_creations WHERE id=$1",
            [id],
          )
        ).rows[0].name,
        name,
      );
      if (calls === 1) throw Error("unknown");
      return { id: "33333333-3333-4333-8333-333333333333", name };
    };
    const op = "22222222-2222-4222-8222-222222222222";
    await assert.rejects(
      management.createCollection(actor, op, "Dataset"),
      /unknown/,
    );
    await assert.rejects(
      management.createCollection(actor, op, "Changed"),
      /management_changed/,
    );
    assert.equal(
      (await management.createCollection(actor, op, "Dataset")).name,
      "Dataset",
    );
    assert.equal(calls, 2);
    assert.equal(
      (await pool.query("SELECT count(*)::int n FROM collection_creations"))
        .rows[0].n,
      1,
    );
  },
);

test(
  "ACL revoke closes sharing before remote mutation and recovers the same operation without restoring stale policy",
  { skip: !databaseEnabled },
  async (t) => {
    const { pool, registration, management, change } = await fixture(t);
    await registration.begin(group, line);
    const collection = "22222222-2222-4222-8222-222222222222",
      acl = "33333333-3333-4333-8333-333333333333";
    const g = (
      await pool.query(
        "UPDATE groups SET state='active',active_from=$1,sharing_enabled=true,collection_id=$2,acl_revision=1,binding_generation=1 RETURNING id",
        [now, collection],
      )
    ).rows[0];
    let revoked = false,
      unknown = true,
      key = "";
    registration.ports.collection = async (id) => ({
      id,
      aclRevision: revoked ? 2 : 1,
      bindingGeneration: 1,
      audience: revoked ? [] : [`role:${actor}`],
      readers: revoked ? [] : [{ id: acl, type: "role", subjectId: actor }],
    });
    management.ports.revokeReader = async (
      _collection,
      _acl,
      revision,
      operation,
    ) => {
      assert.equal(
        (await pool.query("SELECT sharing_enabled FROM groups")).rows[0]
          .sharing_enabled,
        false,
      );
      assert.equal(revision, 1);
      if (key) assert.equal(operation, key);
      else key = operation;
      revoked = true;
      if (unknown) throw Error("unknown");
    };
    change(true, false, 1);
    const p = await management.previewRevoke(actor, g.id, acl, 1);
    assert.match(p.text, /LINE 群組/);
    assert.ok(p.text.includes(`role:${actor}`));
    await assert.rejects(management.confirm(actor, p.id, p.token));
    assert.equal(
      (await pool.query("SELECT sharing_enabled FROM groups")).rows[0]
        .sharing_enabled,
      false,
    );
    unknown = false;
    await management.confirm(actor, p.id, p.token);
    const current = (await pool.query("SELECT * FROM groups")).rows[0];
    assert.equal(current.sharing_enabled, true);
    assert.equal(current.acl_revision, "2");
    await management.confirm(actor, p.id, p.token);
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int n FROM management_operations WHERE state='completed'",
        )
      ).rows[0].n,
      1,
    );
  },
);

test(
  "metadata pagination is complete and expired interaction cannot create or consume approval",
  { skip: !databaseEnabled },
  async (t) => {
    const { pool, management } = await fixture(t);
    for (let i = 0; i < 7; i++)
      await pool.query(
        "INSERT INTO groups(channel_id,line_group_id,display_name) VALUES('channel',$1,$2)",
        ["C" + i.toString(16).padStart(32, "0"), "Group " + i],
      );
    const first = await management.groups(actor, "", 5);
    const rest = await management.groups(actor, first.at(-1)!.id, 5);
    assert.equal(first.length, 5);
    assert.equal(rest.length, 2);
    assert.equal(new Set([...first, ...rest].map((g) => g.id)).size, 7);
    const fence = { id: "99999999-9999-4999-8999-999999999999", fence: "1" };
    await assert.rejects(
      management.preview(actor, first[0]!.id, "pause", 1, undefined, fence),
      /interaction_expired/,
    );
    const p = await management.preview(actor, first[0]!.id, "pause", 1);
    await assert.rejects(
      management.confirm(actor, p.id, p.token, fence),
      /interaction_expired/,
    );
    assert.equal(
      (await pool.query("SELECT count(*)::int n FROM audit_outbox")).rows[0].n,
      0,
    );
  },
);

test(
  "confirmed group deletion completes cleanup then requires fresh announcement without restoring old sources",
  { skip: !databaseEnabled },
  async (t) => {
    const { pool, store, registration, management } = await fixture(t);
    const oldIntent = await registration.begin(group, line);
    const g = (
      await pool.query(
        "UPDATE groups SET state='active',active_from=$1 RETURNING id",
        [now],
      )
    ).rows[0];
    await store.ingest({
      id: "old-event",
      type: "message",
      scope: "group",
      scopeId: group,
      publishedAt: now,
      actorId: line,
      message: {
        id: "old-message",
        type: "text",
        text: "deleted original",
        mentionsBot: false,
      },
    });
    const p = await management.preview(actor, g.id, "delete", 1);
    await management.confirm(actor, p.id, p.token);
    const { sweepExpired } = await import("../src/domain/lifecycle.ts");
    await sweepExpired(store);
    await assert.rejects(registration.begin(group, line));
    const { CleanupWorker } = await import("../src/worker/cleanup.ts");
    const cleanup = new CleanupWorker(store, {
      lookup: async () => undefined,
      remove: async () => {
        throw Error("unexpected external remove");
      },
    });
    assert.equal(await cleanup.processOne(), true);
    await sweepExpired(store);
    assert.equal(
      (await pool.query("SELECT state FROM groups")).rows[0].state,
      "deleted",
    );
    const intent = await registration.begin(group, line);
    assert.notEqual(intent, oldIntent);
    assert.equal(
      (await pool.query("SELECT state FROM groups")).rows[0].state,
      "pending",
    );
    await assert.rejects(
      registration.configure(oldIntent, line, { sharing: false }),
    );
    await registration.configure(intent, line, { sharing: false });
    const preview = await registration.preview(intent, line, group);
    const delivery = await store.transaction((c) =>
      registration.deliveries.create(c, {
        eventId: "new-announcement",
        token: "fixture",
        publishedAt: now,
        actorId: line,
        scopeId: group,
      }),
    );
    assert.ok(delivery);
    await registration.confirm(intent, preview.token, line, group, delivery);
    assert.equal(
      (await pool.query("SELECT state FROM groups")).rows[0].state,
      "active",
    );
    assert.deepEqual(
      (await pool.query("SELECT state,body FROM sources")).rows,
      [{ state: "revoked", body: null }],
    );
  },
);
test(
  "deleting an empty group reaches a terminal state without fabricating cleanup work",
  { skip: !databaseEnabled },
  async (t) => {
    const { pool, store, registration, management } = await fixture(t);
    await registration.begin(group, line);
    const g = (
      await pool.query(
        "UPDATE groups SET state='active',active_from=$1 RETURNING id",
        [now],
      )
    ).rows[0];
    const p = await management.preview(actor, g.id, "delete", 1);
    await management.confirm(actor, p.id, p.token);
    const { sweepExpired } = await import("../src/domain/lifecycle.ts");
    await sweepExpired(store);
    assert.equal(
      (await pool.query("SELECT state FROM groups")).rows[0].state,
      "deleted",
    );
    assert.equal(
      (await pool.query("SELECT count(*)::int n FROM jobs")).rows[0].n,
      0,
    );
  },
);

for (const inFlight of [false, true]) {
  test(
    `ACL shrink preserves ${inFlight ? "in-flight" : "queued"} publication identity`,
    { skip: !databaseEnabled },
    async (t) => {
      const { pool, store, registration, management } = await fixture(t);
      const { PublicationWorker } =
        await import("../src/worker/publication.ts");
      type Remote = import("../src/worker/publication.ts").PublicationRecord;
      await registration.begin(group, line);
      const collection = "c".repeat(32),
        acl = "d".repeat(32);
      const g = (
        await pool.query(
          "UPDATE groups SET state='active',active_from=$1,sharing_enabled=true,collection_id=$2,acl_revision=1,binding_generation=1 RETURNING id",
          [now, collection],
        )
      ).rows[0];
      await store.ingest({
        id: "publication-event",
        type: "message",
        scope: "group",
        scopeId: group,
        publishedAt: now,
        message: {
          id: "publication-message",
          type: "file",
          fileName: "schedule.pdf",
          mentionsBot: false,
        },
      });
      await pool.query(
        "UPDATE sources SET state='ready',asset_id=$1,asset_etag='etag'",
        ["a".repeat(32)],
      );
      await pool.query(
        "INSERT INTO jobs(source_id,kind,runtime_generation,source_revision,created_at,available_at) SELECT id,'publish',1,revision,$1,$1 FROM sources",
        [now],
      );
      let revoked = false,
        remote: Remote | undefined,
        stages = 0;
      let releaseStage!: () => void,
        stageEntered!: () => void,
        releaseRevoke!: () => void,
        revokeEntered!: () => void;
      const staged = new Promise<void>((r) => {
          stageEntered = r;
        }),
        stageWait = new Promise<void>((r) => {
          releaseStage = r;
        });
      const revoking = new Promise<void>((r) => {
          revokeEntered = r;
        }),
        revokeWait = new Promise<void>((r) => {
          releaseRevoke = r;
        });
      registration.ports.collection = async (id) => ({
        id,
        aclRevision: revoked ? 2 : 1,
        bindingGeneration: 1,
        audience: revoked ? [] : [`role:${actor}`],
        readers: revoked ? [] : [{ id: acl, type: "role", subjectId: actor }],
      });
      management.ports.revokeReader = async () => {
        revokeEntered();
        await revokeWait;
        revoked = true;
      };
      const worker = new PublicationWorker(store, {
        lookup: async () => remote,
        stage: async (p, s) => {
          stages++;
          remote = {
            itemId: "e".repeat(32),
            collectionId: p.collection_id,
            assetId: s.asset_id!,
            revision: p.id,
            state: "staged",
          };
          stageEntered();
          if (inFlight) await stageWait;
          return remote;
        },
        activate: async () => {
          remote = { ...remote!, state: "active" };
          return remote;
        },
      });
      const old = inFlight ? worker.processOne() : undefined;
      if (inFlight) await staged;
      const preview = await management.previewRevoke(actor, g.id, acl, 1);
      const revoke = management.confirm(actor, preview.id, preview.token);
      await revoking;
      const claimedWhileRevoking = await worker.processOne();
      releaseRevoke();
      await revoke;
      releaseStage();
      if (old) await old;
      await worker.processOne();
      assert.equal(claimedWhileRevoking, false);
      assert.equal(
        (await pool.query("SELECT state FROM jobs WHERE kind='publish'"))
          .rows[0].state,
        "completed",
      );
      assert.equal(
        (await pool.query("SELECT count(*)::int n FROM publications")).rows[0]
          .n,
        1,
      );
      assert.equal(
        (await pool.query("SELECT acl_revision FROM publications")).rows[0]
          .acl_revision,
        "2",
      );
      assert.equal(stages, 1);
      assert.equal(remote?.state, "active");
    },
  );
}
