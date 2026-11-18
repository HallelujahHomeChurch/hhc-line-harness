import assert from "node:assert/strict";
import test from "node:test";
import { database, databaseEnabled } from "./database.ts";
import { Store } from "../src/persistence/store.ts";
import { ReplyTokenCipher } from "../src/reply/token.ts";
import { Deliveries } from "../src/reply/deliveries.ts";
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const actor = `U${"1".repeat(32)}`;
async function fixture(t: Parameters<typeof database>[0]) {
  const pool = await database(t),
    now = new Date("2026-11-18T10:00:00Z");
  await pool.query("UPDATE runtime_state SET mode='open'");
  const group = (
    await pool.query(
      "INSERT INTO groups(channel_id,line_group_id,state,active_from) VALUES('test',$1,'active',$2) RETURNING *",
      [`C${"2".repeat(32)}`, now],
    )
  ).rows[0];
  const store = new Store(
      pool,
      new ReplyTokenCipher("11".repeat(32)),
      "test",
      () => now,
    ),
    deliveries = new Deliveries(store);
  const id = (await store.transaction((c) =>
    deliveries.create(c, {
      eventId: "event",
      token: "token",
      publishedAt: now,
      groupId: group.id,
      groupRevision: group.revision,
      actorId: actor,
    }),
  ))!;
  return { pool, store, deliveries, id, group, now };
}
test(
  "only a successful LINE receipt and delivery CAS publish an encrypted public turn",
  { skip: !databaseEnabled },
  async (t) => {
    const f = await fixture(t);
    await f.deliveries.prepare(f.id, "公開回答", undefined, {
      publicTurn: {
        messageId: "question",
        publishedAt: f.now.toISOString(),
        question: "問題",
        kind: "answer",
        followUp: "continue",
        dependencies: [],
      },
    });
    assert.equal(
      (await f.pool.query("SELECT count(*)::int n FROM group_turns")).rows[0].n,
      0,
    );
    await f.deliveries.deliver(f.id, async () => ({ messageIds: ["sent-1"] }));
    const r = (await f.pool.query("SELECT * FROM group_turns")).rows[0];
    assert.equal(r.id, f.id);
    assert.deepEqual(r.line_message_ids, ["sent-1"]);
    assert.equal(r.actor_id, actor);
    assert.equal(
      f.store.cipher.openPayload(r.answer_ciphertext, `turn-answer:${f.id}`),
      "公開回答",
    );
    assert.equal(
      (await f.pool.query("SELECT state FROM deliveries")).rows[0].state,
      "delivered",
    );
    await f.deliveries.deliver(f.id, async () =>
      assert.fail("must not resend"),
    );
    assert.equal(
      (await f.pool.query("SELECT count(*)::int n FROM group_turns")).rows[0].n,
      1,
    );
  },
);
for (const mode of ["missing-id", "unknown", "cleaned-before-ack"] as const)
  test(
    `public delivery ${mode} never creates shared history`,
    { skip: !databaseEnabled },
    async (t) => {
      const f = await fixture(t);
      await f.deliveries.prepare(f.id, "不能共享", undefined, {
        publicTurn: {
          messageId: "question",
          publishedAt: f.now.toISOString(),
          question: "問題",
          kind: "answer",
          followUp: "continue",
          dependencies: [],
        },
      });
      await f.deliveries.deliver(f.id, async () => {
        if (mode === "unknown") throw Error("timeout");
        if (mode === "cleaned-before-ack")
          await f.pool.query(
            "UPDATE deliveries SET state='unknown' WHERE id=$1",
            [f.id],
          );
        return mode === "missing-id" ? undefined : { messageIds: ["sent-2"] };
      });
      assert.equal(
        (await f.pool.query("SELECT count(*)::int n FROM group_turns")).rows[0]
          .n,
        0,
      );
      assert.equal(
        (await f.pool.query("SELECT state FROM deliveries")).rows[0].state,
        "unknown",
      );
    },
  );
test(
  "lost commit acknowledgement is reconciled without a second LINE send",
  { skip: !databaseEnabled },
  async (t) => {
    const f = await fixture(t);
    await f.deliveries.prepare(f.id, "回答", undefined, {
      publicTurn: {
        messageId: "q",
        publishedAt: f.now.toISOString(),
        question: "問題",
        kind: "answer",
        followUp: "continue",
        dependencies: [],
      },
    });
    const original = f.store.transaction.bind(f.store);
    let calls = 0,
      transactions = 0;
    f.store.transaction = async (op) => {
      const value = await original(op);
      if (++transactions === 2) throw Error("commit response lost");
      return value;
    };
    assert.equal(
      await f.deliveries.deliver(f.id, async () => {
        calls++;
        return { messageIds: ["sent-commit"] };
      }),
      "delivered",
    );
    assert.equal(calls, 1);
    assert.equal(
      (await f.pool.query("SELECT count(*)::int n FROM group_turns")).rows[0].n,
      1,
    );
  },
);
test(
  "public history outlives short delivery cleanup and remains rollback compatible",
  { skip: !databaseEnabled },
  async (t) => {
    const f = await fixture(t);
    await f.deliveries.prepare(f.id, "long-lived public answer", undefined, {
      publicTurn: {
        messageId: "question",
        publishedAt: f.now.toISOString(),
        question: "question",
        kind: "answer",
        followUp: "continue",
        dependencies: [],
      },
    });
    await f.deliveries.deliver(f.id, async () => ({
      messageIds: ["public-history"],
    }));
    await f.pool.query("DELETE FROM deliveries WHERE id=$1", [f.id]);
    const row = (
      await f.pool.query(
        "SELECT answer_ciphertext FROM group_turns WHERE id=$1",
        [f.id],
      )
    ).rows[0];
    assert.equal(
      f.store.cipher.openPayload(row.answer_ciphertext, `turn-answer:${f.id}`),
      "long-lived public answer",
    );
  },
);
async function pendingFixture(t: Parameters<typeof database>[0]) {
  const f = await fixture(t);
  await f.deliveries.prepare(f.id, "哪一天？", undefined, {
    publicTurn: {
      messageId: "q",
      publishedAt: f.now.toISOString(),
      question: "安排",
      kind: "clarification",
      followUp: "awaiting",
      dependencies: [],
    },
  });
  await f.deliveries.deliver(f.id, async () => ({
    messageIds: ["pending-question"],
  }));
  let ordinal = 0;
  const child = async () => {
    const id = (await f.store.transaction((c) =>
      f.deliveries.create(c, {
        eventId: `child-${++ordinal}`,
        token: `token-${ordinal}`,
        publishedAt: f.now,
        groupId: f.group.id,
        groupRevision: f.group.revision,
        actorId: actor,
      }),
    ))!;
    await f.deliveries.prepare(id, "星期日草稿", undefined, {
      publicTurn: {
        messageId: `answer-${ordinal}`,
        publishedAt: f.now.toISOString(),
        question: "星期日",
        kind: "answer",
        followUp: "continue",
        dependencies: [],
        parent: { id: f.id, version: "1" },
      },
    });
    return id;
  };
  return { ...f, child };
}
test(
  "one pending answer can be reserved at a time and unknown delivery preserves the question",
  { skip: !databaseEnabled },
  async (t) => {
    const f = await pendingFixture(t),
      one = await f.child(),
      two = await f.child();
    const entered = deferred(),
      finish = deferred();
    const first = f.deliveries.deliver(one, async () => {
      entered.resolve();
      await finish.promise;
      throw Error("unknown");
    });
    await entered.promise;
    await f.deliveries.deliver(two, async () =>
      assert.fail("second pending answer must not send"),
    );
    finish.resolve();
    await first;
    assert.equal(
      (
        await f.pool.query("SELECT consumed_by FROM group_turns WHERE id=$1", [
          f.id,
        ])
      ).rows[0].consumed_by,
      null,
    );
    const three = await f.child();
    await f.deliveries.deliver(three, async () => ({
      messageIds: ["new-answer"],
    }));
    assert.equal(
      (
        await f.pool.query("SELECT consumed_by FROM group_turns WHERE id=$1", [
          f.id,
        ])
      ).rows[0].consumed_by,
      three,
    );
  },
);
test(
  "late pending acknowledgement cannot replace a newer successfully delivered answer",
  { skip: !databaseEnabled },
  async (t) => {
    const f = await pendingFixture(t),
      one = await f.child();
    const entered = deferred(),
      finish = deferred();
    const first = f.deliveries.deliver(one, async () => {
      entered.resolve();
      await finish.promise;
      return { messageIds: ["late-answer"] };
    });
    await entered.promise;
    await f.pool.query("UPDATE deliveries SET state='unknown' WHERE id=$1", [
      one,
    ]);
    const two = await f.child();
    await f.deliveries.deliver(two, async () => ({
      messageIds: ["confirmed-answer"],
    }));
    finish.resolve();
    await first;
    assert.equal(
      (
        await f.pool.query("SELECT consumed_by FROM group_turns WHERE id=$1", [
          f.id,
        ])
      ).rows[0].consumed_by,
      two,
    );
    assert.equal(
      (
        await f.pool.query(
          "SELECT count(*)::int n FROM group_turns WHERE id=$1",
          [one],
        )
      ).rows[0].n,
      0,
    );
  },
);
