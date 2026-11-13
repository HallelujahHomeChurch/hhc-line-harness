import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { database, databaseEnabled } from "./database.ts";
import { Store } from "../src/persistence/store.ts";
import { ReplyTokenCipher } from "../src/reply/token.ts";
import { Search } from "../src/search/search.ts";
import { SourceEdits } from "../src/domain/source-edits.ts";
const actor = "U" + "1".repeat(32),
  other = "U" + "3".repeat(32);
async function fixture(t: Parameters<typeof database>[0]) {
  const pool = await database(t);
  const now = new Date("2026-11-13T00:00:00Z");
  await pool.query("UPDATE runtime_state SET mode='open'");
  const group = (
    await pool.query(
      "INSERT INTO groups(channel_id,line_group_id,state,active_from) VALUES('test',$1,'active',$2) RETURNING id",
      ["C" + "2".repeat(32), now],
    )
  ).rows[0].id;
  const source = (
    await pool.query(
      "INSERT INTO sources(group_id,message_id,author_id,kind,body,file_name,state,published_at,expires_at) VALUES($1,'message',$2,'file','original text','schedule.pdf','ready',$3,$3::timestamptz+interval '2160 hours') RETURNING *",
      [group, actor, now],
    )
  ).rows[0];
  const store = new Store(
    pool,
    new ReplyTokenCipher("11".repeat(32)),
    "test",
    () => now,
  );
  const search = new Search(store, async () => true);
  let revision = 1;
  const edits = new SourceEdits(store, search, async () => ({
    allowed: true,
    bound: true,
    actorUserId: "44444444-4444-4444-8444-444444444444",
    bindingGeneration: 1,
    adminAuthorizationRevision: revision,
  }));
  return {
    pool,
    store,
    source,
    group,
    edits,
    changeAdmin: () => {
      revision++;
    },
  };
}
test(
  "author description requires full preview, same actor and one-shot confirmation; original and expiry unchanged",
  { skip: !databaseEnabled },
  async (t) => {
    const f = await fixture(t),
      p = await f.edits.preview(f.group, actor, f.source.id, {
        kind: "description",
        text: "十二月同工排班",
      });
    assert.match(p.text, /schedule.pdf/);
    assert.match(p.text, /十二月同工排班/);
    await assert.rejects(
      f.edits.confirm(f.group, other, p.id, p.token),
      /forbidden/,
    );
    await f.edits.confirm(f.group, actor, p.id, p.token);
    const s = (
      await f.pool.query("SELECT * FROM sources WHERE id=$1", [f.source.id])
    ).rows[0];
    assert.equal(s.description, "十二月同工排班");
    assert.equal(s.body, "original text");
    assert.equal(s.expires_at.getTime(), f.source.expires_at.getTime());
    await assert.rejects(
      f.edits.confirm(f.group, actor, p.id, p.token),
      /expired/,
    );
  },
);
test(
  "Admin remove/re-add revision invalidates old description approval",
  { skip: !databaseEnabled },
  async (t) => {
    const f = await fixture(t),
      p = await f.edits.preview(f.group, other, f.source.id, {
        kind: "description",
        text: "new",
      });
    f.changeAdmin();
    await assert.rejects(
      f.edits.confirm(f.group, other, p.id, p.token),
      /expired/,
    );
    assert.equal(
      (
        await f.pool.query("SELECT description FROM sources WHERE id=$1", [
          f.source.id,
        ])
      ).rows[0].description,
      null,
    );
  },
);
test(
  "changed source revision, cross-group target and stale delete approval fail closed",
  { skip: !databaseEnabled },
  async (t) => {
    const f = await fixture(t);
    await assert.rejects(
      f.edits.preview(randomUUID(), actor, f.source.id, { kind: "delete" }),
    );
    const p = await f.edits.preview(f.group, actor, f.source.id, {
      kind: "delete",
    });
    await f.pool.query("UPDATE sources SET revision=revision+1 WHERE id=$1", [
      f.source.id,
    ]);
    await assert.rejects(
      f.edits.confirm(f.group, actor, p.id, p.token),
      /expired/,
    );
    const next = await f.edits.preview(f.group, actor, f.source.id, {
      kind: "delete",
    });
    await f.edits.confirm(f.group, actor, next.id, next.token);
    assert.equal(
      (
        await f.pool.query("SELECT state,body FROM sources WHERE id=$1", [
          f.source.id,
        ])
      ).rows[0].state,
      "revoked",
    );
  },
);

test(
  "current Admin may confirm; resetting the conversation invalidates any unconsumed approval",
  { skip: !databaseEnabled },
  async (t) => {
    const f = await fixture(t);
    const accepted = await f.edits.preview(f.group, other, f.source.id, {
      kind: "description",
      text: "Admin verified",
    });
    await f.edits.confirm(f.group, other, accepted.id, accepted.token);
    const cancelled = await f.edits.preview(f.group, actor, f.source.id, {
      kind: "description",
      text: "old preview",
    });
    await f.edits.conversations.reset(f.group, actor);
    await assert.rejects(
      f.edits.confirm(f.group, actor, cancelled.id, cancelled.token),
      /expired/,
    );
    assert.equal(
      (
        await f.pool.query("SELECT description FROM sources WHERE id=$1", [
          f.source.id,
        ])
      ).rows[0].description,
      "Admin verified",
    );
  },
);

test(
  "author and admin source mutations commit one content-free durable Audit fact atomically",
  { skip: !databaseEnabled },
  async (t) => {
    const f = await fixture(t);
    const description = await f.edits.preview(f.group, actor, f.source.id, {
      kind: "description",
      text: "private new description",
    });
    await f.edits.confirm(f.group, actor, description.id, description.token);
    const author = (
      await f.pool.query("SELECT * FROM audit_outbox WHERE id=$1", [
        description.id,
      ])
    ).rows[0];
    assert.ok(author);
    const { auditEvent } = await import("../src/audit/outbox.ts");
    const event = auditEvent(author);
    assert.equal(event.action, "line.source.description");
    assert.equal(event.actorType, "anonymous");
    assert.equal(event.actorId, "");
    assert.equal(event.resourceId, f.source.id);
    assert.equal(JSON.stringify(event).includes("private"), false);
    assert.equal(JSON.stringify(event).includes(actor), false);
    const deletion = await f.edits.preview(f.group, other, f.source.id, {
      kind: "delete",
    });
    await f.pool.query(
      "CREATE FUNCTION reject_source_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic'; END $$; CREATE TRIGGER reject_source_audit BEFORE INSERT ON audit_outbox FOR EACH ROW EXECUTE FUNCTION reject_source_audit()",
    );
    await assert.rejects(
      f.edits.confirm(f.group, other, deletion.id, deletion.token),
    );
    assert.equal(
      (await f.pool.query("SELECT state FROM sources")).rows[0].state,
      "ready",
    );
    await f.pool.query("DROP TRIGGER reject_source_audit ON audit_outbox");
    await f.edits.confirm(f.group, other, deletion.id, deletion.token);
    const admin = auditEvent(
      (
        await f.pool.query("SELECT * FROM audit_outbox WHERE id=$1", [
          deletion.id,
        ])
      ).rows[0],
    );
    assert.equal(admin.action, "line.source.delete");
    assert.equal(admin.actorType, "user");
    assert.equal(admin.actorId, "44444444-4444-4444-8444-444444444444");
    await assert.rejects(
      f.edits.confirm(f.group, other, deletion.id, deletion.token),
    );
    assert.equal(
      (await f.pool.query("SELECT count(*)::int n FROM audit_outbox")).rows[0]
        .n,
      2,
    );
    const { Recovery } = await import("../src/domain/recovery.ts");
    const recovery = new Recovery(f.store, "a".repeat(64));
    await recovery.quiesce();
    const journal = await recovery.exportJournal();
    await f.pool.query("DELETE FROM audit_outbox");
    await recovery.restore(journal, f.store.now(), "2");
    const restored = (
      await f.pool.query("SELECT * FROM audit_outbox WHERE id=$1", [
        description.id,
      ])
    ).rows[0];
    assert.deepEqual(restored.payload, event);
    assert.equal(restored.actor_user_id, null);
    const { AuditDispatcher } = await import("../src/audit/outbox.ts");
    const sent: unknown[] = [];
    const dispatcher = new AuditDispatcher(f.store, async (e) => {
      sent.push(e);
    });
    await dispatcher.processOne();
    await dispatcher.processOne();
    assert.equal(sent.length, 2);
  },
);
