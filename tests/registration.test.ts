import assert from "node:assert/strict";
import { test } from "node:test";
import { database, databaseEnabled } from "./database.ts";
import { Store } from "../src/persistence/store.ts";
import { ReplyTokenCipher } from "../src/reply/token.ts";
import { Deliveries } from "../src/reply/deliveries.ts";
import { Registration } from "../src/domain/registration.ts";
const now = new Date("2026-11-12T12:00:00Z");
const line = `U${"a".repeat(32)}`,
  group = `C${"c".repeat(32)}`;
async function fixture(t: Parameters<typeof database>[0]) {
  const pool = await database(t);
  await pool.query("UPDATE runtime_state SET mode='open'");
  const store = new Store(
    pool,
    new ReplyTokenCipher("a".repeat(64)),
    "channel",
    () => now,
  );
  const deliveries = new Deliveries(store);
  const state = {
    admin: true,
    member: true,
    adminRevision: 1,
    binding: 1,
    acl: 1,
    sends: 0,
    failSend: false,
    afterSend: async () => {},
  };
  const registration = new Registration(store, {
    authority: async () => ({
      actorUserId: "11111111-1111-4111-8111-111111111111",
      bindingGeneration: state.binding,
      adminAuthorizationRevision: state.adminRevision,
      allowed: state.admin,
      bound: true,
    }),
    member: async () => state.member,
    collection: async (id: string) => ({
      id,
      aclRevision: state.acl,
      bindingGeneration: 1,
      audience: ["role:readers"],
    }),
    send: async () => {
      state.sends++;
      await state.afterSend();
      if (state.failSend) throw new Error("network");
    },
  });
  const intent = await registration.begin(group, line);
  async function delivery(eventId = "confirmation") {
    const id = await store.transaction((c) =>
      deliveries.create(c, {
        eventId,
        token: "token",
        publishedAt: now,
        actorId: line,
        scopeId: group,
      }),
    );
    assert.ok(id);
    return id;
  }
  return { pool, registration, state, intent, delivery };
}
test(
  "group-first setup only activates after same actor preview, successful Reply and unchanged approval",
  { skip: !databaseEnabled },
  async (t) => {
    const { pool, registration, intent, delivery, state } = await fixture(t);
    await registration.configure(intent, line, { sharing: false });
    const preview = await registration.preview(intent, line, group);
    assert.match(preview.text, /90/);
    assert.match(preview.text, /掃描/);
    await registration.confirm(
      intent,
      preview.token,
      line,
      group,
      await delivery(),
    );
    assert.equal(state.sends, 1);
    assert.equal(
      (await pool.query("SELECT state FROM groups")).rows[0].state,
      "active",
    );
    await assert.rejects(
      registration.confirm(
        intent,
        preview.token,
        line,
        group,
        await delivery("duplicate"),
      ),
    );
    assert.equal(state.sends, 1);
    assert.equal(
      (await pool.query("SELECT count(*)::int AS n FROM audit_outbox")).rows[0]
        .n,
      2,
    );
  },
);
test(
  "foreign actor/group, nonmember, binding/admin changes and stale ACL cannot announce",
  { skip: !databaseEnabled },
  async (t) => {
    const { registration, intent, delivery, state } = await fixture(t);
    await registration.configure(intent, line, {
      sharing: true,
      collectionId: "22222222-2222-4222-8222-222222222222",
    });
    const preview = await registration.preview(intent, line, group);
    const id = await delivery();
    await assert.rejects(
      registration.confirm(
        intent,
        preview.token,
        `U${"b".repeat(32)}`,
        group,
        id,
      ),
    );
    await assert.rejects(
      registration.confirm(
        intent,
        preview.token,
        line,
        `C${"d".repeat(32)}`,
        id,
      ),
    );
    state.member = false;
    await assert.rejects(
      registration.confirm(intent, preview.token, line, group, id),
    );
    state.member = true;
    state.adminRevision++;
    await assert.rejects(
      registration.confirm(intent, preview.token, line, group, id),
    );
    state.adminRevision--;
    state.binding++;
    await assert.rejects(
      registration.confirm(intent, preview.token, line, group, id),
    );
    state.binding--;
    state.acl++;
    await assert.rejects(
      registration.confirm(intent, preview.token, line, group, id),
    );
    assert.equal(state.sends, 0);
  },
);
test(
  "ambiguous announcement and post-announcement authority changes remain inactive",
  { skip: !databaseEnabled },
  async (t) => {
    for (const failure of ["network", "role"] as const) {
      await t.test(failure, async (t) => {
        const { pool, registration, intent, delivery, state } =
          await fixture(t);
        await registration.configure(intent, line, { sharing: false });
        const preview = await registration.preview(intent, line, group);
        if (failure === "network") state.failSend = true;
        else
          state.afterSend = async () => {
            state.adminRevision++;
          };
        await assert.rejects(
          registration.confirm(
            intent,
            preview.token,
            line,
            group,
            await delivery(),
          ),
        );
        assert.notEqual(
          (await pool.query("SELECT state FROM groups")).rows[0].state,
          "active",
        );
        assert.equal(state.sends, 1);
      });
    }
  },
);
test(
  "collection reservation is unique across groups including pending approvals",
  { skip: !databaseEnabled },
  async (t) => {
    const { registration, intent } = await fixture(t);
    const other = await registration.begin(`C${"d".repeat(32)}`, line);
    const config = {
      sharing: true,
      collectionId: "22222222-2222-4222-8222-222222222222",
    };
    const outcomes = await Promise.allSettled([
      registration.configure(intent, line, config),
      registration.configure(other, line, config),
    ]);
    assert.equal(outcomes.filter((o) => o.status === "fulfilled").length, 1);
  },
);

test(
  "confirmation expires and group mutation after announcement blocks activation",
  { skip: !databaseEnabled },
  async (t) => {
    const { pool, registration, intent, delivery, state } = await fixture(t);
    await registration.configure(intent, line, { sharing: false });
    let preview = await registration.preview(intent, line, group);
    await pool.query("UPDATE setup_intents SET confirmation_expires_at=$1", [
      new Date(now.getTime() - 1),
    ]);
    await assert.rejects(
      registration.confirm(
        intent,
        preview.token,
        line,
        group,
        await delivery("expired"),
      ),
    );
    preview = await registration.preview(intent, line, group);
    state.afterSend = async () => {
      await pool.query("UPDATE groups SET state='left',revision=revision+1");
    };
    await assert.rejects(
      registration.confirm(
        intent,
        preview.token,
        line,
        group,
        await delivery("changed"),
      ),
    );
    assert.equal(
      (await pool.query("SELECT state FROM groups")).rows[0].state,
      "left",
    );
  },
);
test(
  "activation and audit outbox roll back together",
  { skip: !databaseEnabled },
  async (t) => {
    const { pool, registration, intent, delivery } = await fixture(t);
    await registration.configure(intent, line, { sharing: false });
    const preview = await registration.preview(intent, line, group);
    await pool.query(
      "CREATE FUNCTION fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic'; END $$; CREATE TRIGGER fail_audit BEFORE INSERT ON audit_outbox FOR EACH ROW EXECUTE FUNCTION fail_audit()",
    );
    await assert.rejects(
      registration.confirm(
        intent,
        preview.token,
        line,
        group,
        await delivery(),
      ),
    );
    assert.equal(
      (await pool.query("SELECT state FROM groups")).rows[0].state,
      "pending",
    );
  },
);

test(
  "sharing changes retain the same destination when disabled and never migrate historical publications",
  { skip: !databaseEnabled },
  async (t) => {
    const { pool, registration, intent, delivery } = await fixture(t);
    const collection = "22222222-2222-4222-8222-222222222222";
    await registration.configure(intent, line, {
      sharing: true,
      collectionId: collection,
    });
    let p = await registration.preview(intent, line, group);
    await registration.confirm(
      intent,
      p.token,
      line,
      group,
      await delivery("first"),
    );
    const off = await registration.begin(group, line);
    await registration.configure(off, line, { sharing: false });
    p = await registration.preview(off, line, group);
    await registration.confirm(
      off,
      p.token,
      line,
      group,
      await delivery("off"),
    );
    let g = (await pool.query("SELECT * FROM groups")).rows[0];
    assert.equal(g.collection_id, collection);
    assert.equal(g.sharing_enabled, false);
    const on = await registration.begin(group, line);
    await registration.configure(on, line, {
      sharing: true,
      collectionId: collection,
    });
    p = await registration.preview(on, line, group);
    await registration.confirm(on, p.token, line, group, await delivery("on"));
    const move = await registration.begin(group, line);
    await registration.configure(move, line, {
      sharing: true,
      collectionId: "33333333-3333-4333-8333-333333333333",
    });
    p = await registration.preview(move, line, group);
    await registration.confirm(
      move,
      p.token,
      line,
      group,
      await delivery("move"),
    );
    g = (await pool.query("SELECT * FROM groups")).rows[0];
    assert.equal(g.collection_id, "33333333-3333-4333-8333-333333333333");
    assert.equal(
      (await pool.query("SELECT count(*)::int n FROM collection_reservations"))
        .rows[0].n,
      2,
    );
  },
);

test(
  "ACL expansion waits for original group announcement and exact current subject; ambiguous mutation stays closed",
  { skip: !databaseEnabled },
  async (t) => {
    for (const mode of [
      "success",
      "reply_unknown",
      "mutation_unknown",
      "role_changed",
    ] as const)
      await t.test(mode, async (t) => {
        const f = await fixture(t);
        const id = "33333333-3333-4333-8333-333333333333";
        let additions = 0;
        const audience = ["role:readers"];
        f.registration.ports.subject = async (_actor, type, subjectId) => ({
          id: subjectId,
          type,
          label: "群組讀者",
        });
        f.registration.ports.collection = async (collectionId) => ({
          id: collectionId,
          aclRevision: f.state.acl,
          bindingGeneration: 1,
          audience: [...audience],
        });
        f.registration.ports.addReader = async (
          _collection,
          subject,
          expected,
        ) => {
          assert.equal(f.state.sends, 1);
          assert.equal(expected, 1);
          additions++;
          audience.push(`${subject.type}:${subject.id}`);
          f.state.acl++;
          if (mode === "mutation_unknown") throw Error("unknown");
          if (mode === "role_changed") f.state.adminRevision++;
        };
        await f.registration.configure(f.intent, line, {
          sharing: true,
          collectionId: "22222222-2222-4222-8222-222222222222",
          addReader: { type: "role", id },
        });
        assert.equal(additions, 0);
        const p = await f.registration.preview(f.intent, line, group);
        assert.match(p.text, /群組讀者/);
        f.state.failSend = mode === "reply_unknown";
        const confirmation = f.registration.confirm(
          f.intent,
          p.token,
          line,
          group,
          await f.delivery(),
        );
        if (mode === "success") await confirmation;
        else await assert.rejects(confirmation);
        assert.equal(additions, mode === "reply_unknown" ? 0 : 1);
        const g = (await f.pool.query("SELECT * FROM groups")).rows[0];
        assert.equal(g.state === "active", mode === "success");
        if (mode === "success") assert.equal(g.acl_revision, "2");
      });
  },
);

test(
  "draft configuration and its audit fact roll back atomically",
  { skip: !databaseEnabled },
  async (t) => {
    const { pool, registration, intent } = await fixture(t);
    await pool.query(
      "CREATE FUNCTION reject_draft_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic'; END $$; CREATE TRIGGER reject_draft_audit BEFORE INSERT ON audit_outbox FOR EACH ROW EXECUTE FUNCTION reject_draft_audit()",
    );
    await assert.rejects(
      registration.configure(intent, line, { sharing: false }),
    );
    assert.equal(
      (
        await pool.query("SELECT state FROM setup_intents WHERE id=$1", [
          intent,
        ])
      ).rows[0].state,
      "bootstrap",
    );
    assert.equal(
      (await pool.query("SELECT count(*)::int AS n FROM audit_outbox")).rows[0]
        .n,
      0,
    );
  },
);

test(
  "abandoned draft reservations are reclaimed but unknown effects retain ownership",
  { skip: !databaseEnabled },
  async (t) => {
    const { pool, registration, intent } = await fixture(t);
    const x = "collection-x",
      y = "collection-y",
      other = `C${"d".repeat(32)}`;
    await registration.configure(intent, line, {
      sharing: true,
      collectionId: x,
    });
    await registration.configure(intent, line, {
      sharing: true,
      collectionId: y,
    });
    const second = await registration.begin(other, line);
    await registration.configure(second, line, {
      sharing: true,
      collectionId: x,
    });
    await pool.query("UPDATE setup_intents SET expires_at=$2 WHERE id=$1", [
      second,
      new Date(now.getTime() - 1),
    ]);
    await registration.configure(intent, line, {
      sharing: true,
      collectionId: x,
    });
    await pool.query(
      "UPDATE setup_intents SET state='unknown',expires_at=$2 WHERE id=$1",
      [intent, new Date(now.getTime() - 1)],
    );
    const third = await registration.begin(other, line);
    await assert.rejects(
      registration.configure(third, line, { sharing: true, collectionId: x }),
    );
  },
);
