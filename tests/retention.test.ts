import assert from "node:assert/strict";
import { test } from "node:test";
import { database, databaseEnabled } from "./database.ts";
import { Store } from "../src/persistence/store.ts";
import { Retention } from "../src/domain/retention.ts";
import { invalidate } from "../src/domain/lifecycle.ts";

test(
  "expiry removes product ciphertext and upload filename while preserving unresolved cleanup and audit",
  { skip: !databaseEnabled },
  async (t) => {
    const pool = await database(t),
      now = new Date();
    const store = new Store(pool, undefined, "channel", () => now);
    const g = (
      await pool.query(
        "INSERT INTO groups(channel_id,line_group_id) VALUES('channel','Cprivate') RETURNING id",
      )
    ).rows[0].id;
    const s = (
      await pool.query(
        "INSERT INTO sources(group_id,message_id,kind,state,published_at,expires_at,upload_file_name) VALUES($1,'original','file','ready',$2,$3,'private-name.pdf') RETURNING id",
        [
          g,
          new Date(now.getTime() - 86400000),
          new Date(now.getTime() + 89 * 86400000),
        ],
      )
    ).rows[0].id;
    await store.transaction((c) => invalidate(c, s, now, "revoked"));
    assert.equal(
      (await pool.query("SELECT upload_file_name FROM sources")).rows[0]
        .upload_file_name,
      null,
    );
    await pool.query(
      "INSERT INTO audit_outbox(action,actor_user_id,target_id,target_revision,occurred_at) VALUES('line.group.pause',gen_random_uuid(),$1,1,$2)",
      [g, new Date(now.getTime() - 121 * 86400000)],
    );
    await new Retention(store).sweep();
    assert.equal(
      (await pool.query("SELECT count(*)::int n FROM audit_outbox")).rows[0].n,
      1,
    );
    assert.equal(
      (await pool.query("SELECT count(*)::int n FROM sources")).rows[0].n,
      1,
    );
  },
);
test(
  "receipt and tombstone pruning advances an irreversible ingestion floor",
  { skip: !databaseEnabled },
  async (t) => {
    const pool = await database(t),
      now = new Date();
    const store = new Store(pool, undefined, "channel", () => now);
    const old = new Date(now.getTime() - 121 * 86400000);
    await pool.query("UPDATE runtime_state SET mode='open',ingest_floor=$1", [
      old,
    ]);
    await pool.query(
      "INSERT INTO event_receipts(channel_id,event_id,scope,event_type,published_at,received_at,expires_at) VALUES('channel','old','group','message',$1,$1,$1)",
      [old],
    );
    await pool.query(
      "INSERT INTO source_tombstones(source_key,revoked_at,expires_at) VALUES($1,$2,$2)",
      ["a".repeat(64), old],
    );
    await new Retention(store).sweep();
    assert.equal(
      (await pool.query("SELECT count(*)::int n FROM event_receipts")).rows[0]
        .n,
      0,
    );
    assert.equal(
      (await pool.query("SELECT count(*)::int n FROM source_tombstones"))
        .rows[0].n,
      0,
    );
    const floor = (await pool.query("SELECT ingest_floor FROM runtime_state"))
      .rows[0].ingest_floor;
    assert.equal(floor.getTime(), now.getTime() - 86400000);
    await assert.rejects(
      pool.query("UPDATE runtime_state SET ingest_floor=$1", [old]),
    );
  },
);

test(
  "completed model recovery content expires without refunding unknown cost reservations",
  { skip: !databaseEnabled },
  async (t) => {
    const pool = await database(t),
      now = new Date(),
      store = new Store(pool, undefined, "channel", () => now);
    const run = (
      await pool.query(
        "INSERT INTO model_runs(id,channel_id,kind,actor_id,runtime_generation,created_at,deadline) VALUES(gen_random_uuid(),'channel','admin','private-actor',1,$1,$1) RETURNING id",
        [new Date(now.getTime() - 25 * 3600000)],
      )
    ).rows[0].id;
    await pool.query(
      "INSERT INTO model_steps(run_id,ordinal,request_hash,state,response_ciphertext) VALUES($1,0,'hash','completed','encrypted-product')",
      [run],
    );
    await pool.query(
      "INSERT INTO agent_tools(run_id,key,name,arguments_ciphertext,state) VALUES($1,'key','tool','encrypted-arguments','started')",
      [run],
    );
    await pool.query(
      "INSERT INTO model_months(provider,month,reserved_micros) VALUES('openai','2026-11',100)",
    );
    await new Retention(store).sweep();
    assert.equal(
      (await pool.query("SELECT count(*)::int n FROM model_steps")).rows[0].n,
      0,
    );
    assert.equal(
      (await pool.query("SELECT count(*)::int n FROM agent_tools")).rows[0].n,
      0,
    );
    assert.equal(
      (await pool.query("SELECT actor_id FROM model_runs")).rows[0].actor_id,
      null,
    );
    assert.equal(
      (await pool.query("SELECT reserved_micros FROM model_months")).rows[0]
        .reserved_micros,
      "100",
    );
  },
);

test(
  "source metadata is pruned after 120 days only when physical cleanup is confirmed",
  { skip: !databaseEnabled },
  async (t) => {
    const pool = await database(t),
      now = new Date(),
      store = new Store(pool, undefined, "channel", () => now);
    const g = (
      await pool.query(
        "INSERT INTO groups(channel_id,line_group_id) VALUES('channel','Cexpired') RETURNING id",
      )
    ).rows[0].id;
    const s = (
      await pool.query(
        "INSERT INTO sources(group_id,message_id,kind,state,published_at,expires_at) VALUES($1,'old','text','expired',$2,$3) RETURNING id",
        [
          g,
          new Date(now.getTime() - 121 * 86400000),
          new Date(now.getTime() - 31 * 86400000),
        ],
      )
    ).rows[0].id;
    await pool.query(
      "INSERT INTO jobs(source_id,kind,runtime_generation,source_revision,created_at) VALUES($1,'cleanup',1,1,$2)",
      [s, now],
    );
    await new Retention(store).sweep();
    assert.equal(
      (await pool.query("SELECT count(*)::int n FROM sources")).rows[0].n,
      1,
    );
    await pool.query("UPDATE jobs SET state='completed'");
    await new Retention(store).sweep();
    assert.equal(
      (await pool.query("SELECT count(*)::int n FROM sources")).rows[0].n,
      0,
    );
  },
);
