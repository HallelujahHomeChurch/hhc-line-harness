import assert from "node:assert/strict";
import { test } from "node:test";
import { database, databaseEnabled } from "./database.ts";
import { Store } from "../src/persistence/store.ts";
import { Recovery } from "../src/domain/recovery.ts";
import { invalidate } from "../src/domain/lifecycle.ts";
import { Jobs } from "../src/worker/jobs.ts";
import { Budgets } from "../src/agent/budgets.ts";
import { randomUUID } from "node:crypto";
const key = "f".repeat(64);
async function fixture(t: Parameters<typeof database>[0]) {
  const pool = await database(t),
    now = new Date();
  const store = new Store(pool, undefined, "channel", () => now);
  await pool.query("UPDATE runtime_state SET mode='open',ingest_floor=$1", [
    new Date(now.getTime() - 60000),
  ]);
  const g = (
    await pool.query(
      "INSERT INTO groups(channel_id,line_group_id,state,active_from) VALUES('channel','Cfixture','active',$1) RETURNING id",
      [new Date(now.getTime() - 60000)],
    )
  ).rows[0].id;
  const s = (
    await pool.query(
      "INSERT INTO sources(group_id,message_id,kind,state,body,published_at,expires_at) VALUES($1,'message','text','ready','private text',$2,$3) RETURNING id",
      [g, now, new Date(now.getTime() + 90 * 86400000)],
    )
  ).rows[0].id;
  return { pool, store, now, g, s, recovery: new Recovery(store, key) };
}
test(
  "recovery refuses open export, tampered/stale journal and admission without reconciliation",
  { skip: !databaseEnabled },
  async (t) => {
    const f = await fixture(t);
    await assert.rejects(f.recovery.exportJournal());
    await f.recovery.quiesce();
    const journal = await f.recovery.exportJournal();
    await assert.rejects(
      f.recovery.restore({ ...journal, signature: "0".repeat(64) }, f.now, "2"),
    );
    await assert.rejects(
      f.recovery.restore(journal, new Date(f.now.getTime() + 1), "2"),
    );
    await assert.rejects(f.recovery.admit("2", journal.signature));
    assert.equal(
      (await f.pool.query("SELECT mode FROM runtime_state")).rows[0].mode,
      "closed",
    );
  },
);
test(
  "current signed policy fences stale workers, preserves denial/deadline and never refunds model spend",
  { skip: !databaseEnabled },
  async (t) => {
    const f = await fixture(t);
    await f.pool.query(
      "INSERT INTO jobs(source_id,kind,runtime_generation,source_revision,created_at,available_at) VALUES($1,'index',1,1,$2,$2)",
      [f.s, f.now],
    );
    const old = await new Jobs(f.store).claim("index");
    assert.ok(old);
    await f.store.transaction((c) => invalidate(c, f.s, f.now, "revoked"));
    await f.pool.query(
      "INSERT INTO model_months(provider,month,charged_micros,reserved_micros) VALUES('openai','2026-11',500000000,100)",
    );
    await f.recovery.quiesce();
    const journal = await f.recovery.exportJournal();
    // Stand-in for an older backup missing the later spend and policy; actual pg_restore rehearsal is separate.
    await f.pool.query(
      "UPDATE model_months SET charged_micros=1,reserved_micros=0",
    );
    await f.recovery.restore(journal, f.now, "2");
    assert.equal(
      (await f.pool.query("SELECT mode FROM runtime_state")).rows[0].mode,
      "closed",
    );
    await assert.rejects(new Jobs(f.store).guard(old!));
    await f.recovery.admit("2", journal.signature);
    assert.equal(
      (await f.pool.query("SELECT state FROM groups")).rows[0].state,
      "paused",
    );
    const source = (await f.pool.query("SELECT state,expires_at FROM sources"))
      .rows[0];
    assert.equal(source.state, "revoked");
    assert.equal(source.expires_at.getTime(), f.now.getTime() + 90 * 86400000);
    assert.equal(
      (await f.pool.query("SELECT charged_micros FROM model_months")).rows[0]
        .charged_micros,
      "500000000",
    );
    await assert.rejects(f.pool.query("UPDATE sources SET state='ready'"));
    await assert.rejects(f.recovery.restore(journal, f.now, "2"));
  },
);

test(
  "failed reconciliation stays closed and resumes only the identical journal/generation",
  { skip: !databaseEnabled },
  async (t) => {
    const f = await fixture(t);
    await f.recovery.quiesce();
    const journal = await f.recovery.exportJournal();
    await f.pool.query(
      "CREATE FUNCTION fail_restore() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic'; END $$; CREATE TRIGGER fail_restore BEFORE UPDATE ON groups FOR EACH ROW EXECUTE FUNCTION fail_restore()",
    );
    await assert.rejects(f.recovery.restore(journal, f.now, "2"));
    assert.equal(
      (await f.pool.query("SELECT mode FROM runtime_state")).rows[0].mode,
      "restoring",
    );
    await assert.rejects(f.recovery.admit("2", journal.signature));
    await f.pool.query("DROP TRIGGER fail_restore ON groups");
    await f.recovery.restore(journal, f.now, "2");
    await f.recovery.admit("2", journal.signature);
    assert.equal(
      (await f.pool.query("SELECT mode FROM runtime_state")).rows[0].mode,
      "open",
    );
  },
);

test(
  "real 30-day-old PostgreSQL dump restores with current policy, not deleted contents",
  { skip: !databaseEnabled },
  async (t) => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const execute = promisify(execFile),
      f = await fixture(t);
    const b = (
      await f.pool.query(
        "INSERT INTO sources(group_id,message_id,kind,state,body,published_at,expires_at) VALUES($1,'preserved','text','ready','preserved text',$2,$3) RETURNING id",
        [f.g, f.now, new Date(f.now.getTime() + 90 * 86400000)],
      )
    ).rows[0].id;
    const schema = (await f.pool.query("SELECT current_schema() AS s")).rows[0]
      .s;
    assert.match(schema, /^test_[0-9a-f]{32}$/);
    const dir = await mkdtemp(join(tmpdir(), "harness-restore-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const url = new URL(process.env.TEST_DATABASE_URL!);
    const env = {
      PATH: process.env.PATH,
      PGHOST: url.hostname,
      PGPORT: url.port,
      PGDATABASE: url.pathname.slice(1),
      PGUSER: decodeURIComponent(url.username),
      PGPASSWORD: decodeURIComponent(url.password),
      PGSSLMODE: "disable",
      PGCONNECT_TIMEOUT: "2",
    };
    const file = join(dir, "backup.dump");
    await execute(
      "pg_dump",
      [
        "--no-password",
        "--format=custom",
        "--no-owner",
        "--no-privileges",
        "--schema",
        schema,
        "--file",
        file,
      ],
      { env, timeout: 30000 },
    );
    const restoredAt = new Date(f.now.getTime() + 30 * 86400000),
      store = new Store(f.pool, undefined, "channel", () => restoredAt),
      recovery = new Recovery(store, key);
    await store.transaction((c) => invalidate(c, f.s, restoredAt, "revoked"));
    await f.pool.query(
      "INSERT INTO source_tombstones(source_key,revoked_at,expires_at) VALUES($1,$2,$3)",
      [
        "a".repeat(64),
        restoredAt,
        new Date(restoredAt.getTime() + 120 * 86400000),
      ],
    );
    await f.pool.query(
      "INSERT INTO audit_outbox(action,actor_user_id,target_id,target_revision,occurred_at) VALUES('line.group.pause',gen_random_uuid(),$1,1,$2)",
      [f.g, restoredAt],
    );
    await f.pool.query(
      "INSERT INTO model_budget_alerts(provider,month,kind,created_at,next_attempt_at) VALUES('azure','2026-12','azure_threshold',$1,$1)",
      [restoredAt],
    );
    await recovery.quiesce();
    const journal = await recovery.exportJournal();
    await execute(
      "pg_restore",
      [
        "--no-password",
        "--clean",
        "--if-exists",
        "--no-owner",
        "--no-privileges",
        "--dbname",
        url.pathname.slice(1),
        file,
      ],
      { env, timeout: 30000 },
    );
    assert.equal(
      (await f.pool.query("SELECT state FROM sources WHERE id=$1", [f.s]))
        .rows[0].state,
      "ready",
    );
    await recovery.restore(journal, restoredAt, "2");
    await recovery.admit("2", journal.signature);
    assert.equal(
      (await f.pool.query("SELECT count(*)::int n FROM audit_outbox")).rows[0]
        .n,
      1,
    );
    assert.equal(
      (await f.pool.query("SELECT count(*)::int n FROM model_budget_alerts"))
        .rows[0].n,
      1,
    );
    const a = (
      await f.pool.query(
        "SELECT state,body,expires_at FROM sources WHERE id=$1",
        [f.s],
      )
    ).rows[0];
    assert.equal(a.state, "revoked");
    assert.equal(a.body, null);
    assert.equal(a.expires_at.getTime(), f.now.getTime() + 90 * 86400000);
    assert.equal(
      (await f.pool.query("SELECT body FROM sources WHERE id=$1", [b])).rows[0]
        .body,
      "preserved text",
    );
    assert.equal(
      (await f.pool.query("SELECT count(*)::int n FROM source_tombstones"))
        .rows[0].n,
      1,
    );
    assert.equal(
      (await f.pool.query("SELECT state FROM groups")).rows[0].state,
      "paused",
    );
  },
);

test(
  "process startup rejects a restored generation before external work",
  { skip: !databaseEnabled },
  async (t) => {
    const f = await fixture(t);
    const { requireRuntimeGeneration } =
      await import("../src/persistence/store.ts");
    await requireRuntimeGeneration(f.pool, "1");
    await f.pool.query("UPDATE runtime_state SET generation=2");
    await assert.rejects(requireRuntimeGeneration(f.pool, "1"));
    await requireRuntimeGeneration(f.pool, "2");
    await assert.rejects(requireRuntimeGeneration(f.pool, "01"));
  },
);

test(
  "restore fences late model settlements without refunding or charging twice",
  { skip: !databaseEnabled },
  async (t) => {
    const f = await fixture(t),
      budgets = new Budgets(f.store),
      runId = randomUUID(),
      id = randomUUID();
    await budgets.createRun({
      id: runId,
      kind: "query",
      groupId: f.g,
      actorId: "U" + "1".repeat(32),
    });
    await budgets.reserve({
      id,
      runId,
      provider: "openai",
      model: "fixture",
      purpose: "answer",
      inputTokens: 100,
      maxOutputTokens: 10,
      price: {
        inputMicrosPerMillion: 1000000,
        outputMicrosPerMillion: 5000000,
      },
    });
    await f.recovery.quiesce();
    const journal = await f.recovery.exportJournal();
    await f.recovery.restore(journal, f.now, "2");
    const before = (
      await f.pool.query(
        "SELECT charged_micros,reserved_micros FROM model_months",
      )
    ).rows;
    await assert.rejects(
      budgets.settle(id, { inputTokens: 100, outputTokens: 10 }),
      /restored_model_call/,
    );
    assert.deepEqual(
      (
        await f.pool.query(
          "SELECT charged_micros,reserved_micros FROM model_months",
        )
      ).rows,
      before,
    );
    assert.equal(
      (await f.pool.query("SELECT state FROM model_calls WHERE id=$1", [id]))
        .rows[0].state,
      "unknown",
    );
  },
);

test(
  "foreign installation journals fail closed and unproven restored sources cannot survive",
  { skip: !databaseEnabled },
  async (t) => {
    const f = await fixture(t),
      other = await fixture(t);
    await f.recovery.quiesce();
    const journal = await f.recovery.exportJournal();
    await assert.rejects(other.recovery.restore(journal, f.now, "2"));
    assert.equal(
      (await other.pool.query("SELECT mode FROM runtime_state")).rows[0].mode,
      "closed",
    );
    const unproven = (
      await f.pool.query(
        "INSERT INTO sources(group_id,message_id,kind,state,body,published_at,expires_at) VALUES($1,'not-in-journal','text','ready','old backup content',$2,$3) RETURNING id",
        [f.g, f.now, new Date(f.now.getTime() + 90 * 86400000)],
      )
    ).rows[0].id;
    await f.recovery.restore(journal, f.now, "2");
    const source = (
      await f.pool.query("SELECT state,body FROM sources WHERE id=$1", [
        unproven,
      ])
    ).rows[0];
    assert.deepEqual(source, { state: "revoked", body: null });
  },
);

test(
  "journal-only identities block admission instead of losing external cleanup",
  { skip: !databaseEnabled },
  async (t) => {
    for (const missing of ["source", "publication"] as const) {
      await t.test(missing, async (t) => {
        const f = await fixture(t);
        await f.pool.query(
          "INSERT INTO publications(source_id,collection_id,item_id,source_revision,group_revision,acl_revision,binding_generation,state,created_at) VALUES($1,$2,$3,1,1,1,1,'revoked',$4)",
          [f.s, "a".repeat(32), "b".repeat(32), f.now],
        );
        await f.recovery.quiesce();
        const journal = await f.recovery.exportJournal();
        await f.pool.query("DELETE FROM publications");
        if (missing === "source") await f.pool.query("DELETE FROM sources");
        await assert.rejects(
          f.recovery.restore(journal, f.now, "2"),
          /journal_identities_missing_from_backup/,
        );
        await assert.rejects(
          f.recovery.admit("2", journal.signature),
          /restore_not_verified/,
        );
        assert.equal(
          (await f.pool.query("SELECT mode FROM runtime_state")).rows[0].mode,
          "restoring",
        );
        assert.equal(
          (await f.pool.query("SELECT reconciled_at FROM recovery_records"))
            .rows[0].reconciled_at,
          null,
        );
      });
    }
  },
);
