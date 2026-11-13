import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { database, databaseEnabled } from "./database.ts";
import { Store } from "../src/persistence/store.ts";
import {
  AuditDispatcher,
  auditEvent,
  AuditClient,
} from "../src/audit/outbox.ts";
import { DependencyError } from "../src/providers/http.ts";
const user = "11111111-1111-4111-8111-111111111111";
async function fixture(t: Parameters<typeof database>[0]) {
  const pool = await database(t);
  let now = new Date("2026-11-13T00:00:00Z");
  const store = new Store(pool, undefined, "channel", () => now);
  const row = (
    await pool.query(
      "INSERT INTO audit_outbox(action,actor_user_id,target_id,target_revision,occurred_at,next_attempt_at) VALUES('line.group.pause',$1,$2,1,$3,$3) RETURNING *",
      [user, randomUUID(), now],
    )
  ).rows[0];
  return {
    pool,
    store,
    row,
    advance: () => {
      now = new Date(now.getTime() + 7 * 3600000);
    },
  };
}
test(
  "audit dispatch persists identical event across unknown acceptance and concurrent claims",
  { skip: !databaseEnabled },
  async (t) => {
    const f = await fixture(t);
    const seen: unknown[] = [];
    const w = new AuditDispatcher(f.store, async (event) => {
      seen.push(event);
      if (seen.length === 1) throw new DependencyError();
    });
    await Promise.all([w.processOne(), w.processOne()]);
    assert.equal(seen.length, 1);
    assert.equal(
      (await f.pool.query("SELECT state FROM audit_outbox")).rows[0].state,
      "pending",
    );
    f.advance();
    await w.processOne();
    assert.deepEqual(seen[0], seen[1]);
    assert.equal(
      (await f.pool.query("SELECT state FROM audit_outbox")).rows[0].state,
      "delivered",
    );
    await assert.rejects(
      f.pool.query("UPDATE audit_outbox SET target_revision=2"),
    );
  },
);
test(
  "audit terminal conflict retains event; explicit retry preserves identity and outage never alters business",
  { skip: !databaseEnabled },
  async (t) => {
    const f = await fixture(t);
    let fail = true;
    const w = new AuditDispatcher(f.store, async () => {
      if (fail) throw new DependencyError(409);
    });
    await w.processOne();
    assert.equal(
      (await f.pool.query("SELECT state FROM audit_outbox")).rows[0].state,
      "dead_letter",
    );
    fail = false;
    assert.equal(await w.processOne(), false);
    await w.retry(f.row.id);
    await w.processOne();
    assert.equal(
      (await f.pool.query("SELECT id,state FROM audit_outbox")).rows[0].id,
      f.row.id,
    );
  },
);
test("audit event is a closed content-free contract with int64 revision string", () => {
  const e = auditEvent({
    id: randomUUID(),
    action: "line.group.pause",
    actor_user_id: user,
    target_id: randomUUID(),
    target_revision: "9007199254740993",
    occurred_at: new Date(),
  });
  assert.equal(e.metadata.revision, "9007199254740993");
  assert.equal(e.actorType, "user");
  assert.throws(() => auditEvent({ ...e, action: "line.arbitrary" }));
});
test("audit HTTPS uses independent exact caller, accepts only explicit accepted/duplicate", async () => {
  let calls = 0;
  const client = new AuditClient(
    "https://audit.example/",
    "a".repeat(64),
    async (_url, init) => {
      calls++;
      assert.equal(
        new Headers(init?.headers).get("X-HHC-Audit-Caller"),
        "hhc-line-harness",
      );
      return Response.json(
        { status: calls === 1 ? "accepted" : "unknown" },
        { status: 201 },
      );
    },
  );
  const e = auditEvent({
    id: randomUUID(),
    action: "line.group.pause",
    actor_user_id: user,
    target_id: randomUUID(),
    target_revision: "1",
    occurred_at: new Date(),
  });
  await client.append(e);
  await assert.rejects(client.append(e));
  assert.throws(() => new AuditClient("http://audit.example/", "a".repeat(64)));
});

test("checked-in receiver fixture matches every producer tuple", async () => {
  const { readFile } = await import("node:fs/promises");
  const fixture = JSON.parse(
    await readFile("docs/audit-producer-fixture.json", "utf8"),
  );
  const { auditActions } = await import("../src/audit/outbox.ts");
  assert.deepEqual(
    fixture.actions.map((a: { action: string }) => a.action).sort(),
    [...auditActions].sort(),
  );
  for (const action of auditActions) {
    const e = auditEvent({
      id: randomUUID(),
      action,
      actor_user_id: user,
      target_id: randomUUID(),
      target_revision: "1",
      occurred_at: new Date(),
    });
    const a = fixture.actions.find(
      (a: { action: string }) => a.action === action,
    );
    for (const key of [
      "sourceService",
      "category",
      "resourceOwnerService",
      "resourceType",
      "outcome",
      "severity",
      "metadataClassification",
      "retentionClass",
    ] as const)
      assert.equal(e[key], a[key]);
  }
});

test(
  "expired audit claims fence late completions; authentication outages retain retry state",
  { skip: !databaseEnabled },
  async (t) => {
    const f = await fixture(t);
    let release!: () => void;
    const waiting = new Promise<void>((r) => {
      release = r;
    });
    let entered!: () => void;
    const started = new Promise<void>((r) => {
      entered = r;
    });
    const old = new AuditDispatcher(f.store, async () => {
      entered();
      await waiting;
      throw new DependencyError(409);
    });
    const first = old.processOne();
    await started;
    f.advance();
    const current = new AuditDispatcher(f.store, async () => {});
    await current.processOne();
    release();
    await first;
    assert.equal(
      (await f.pool.query("SELECT state FROM audit_outbox")).rows[0].state,
      "delivered",
    );
    await f.pool.query(
      "UPDATE audit_outbox SET state='pending',attempts=20,next_attempt_at=$1",
      [f.store.now()],
    );
    await new AuditDispatcher(f.store, async () => {
      throw new DependencyError(401);
    }).processOne();
    assert.equal(
      (await f.pool.query("SELECT state FROM audit_outbox")).rows[0].state,
      "pending",
    );
  },
);
