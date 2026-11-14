import assert from "node:assert/strict";
import { test } from "node:test";
import { database, databaseEnabled } from "./database.ts";
import { Store } from "../src/persistence/store.ts";
import { Operations, BudgetAlerts } from "../src/operations.ts";

test(
  "operational status exposes counts, gaps and costs without content or identities",
  { skip: !databaseEnabled },
  async (t) => {
    const pool = await database(t),
      store = new Store(pool, undefined, "channel");
    const s = await new Operations(store).snapshot();
    assert.equal(s.auditPending, 0);
    assert.equal(s.originalCompleted, 0);
    assert.equal(s.costs.length, 0);
    assert.ok(!JSON.stringify(s).includes("line_group_id"));
    await pool.query(
      "INSERT INTO model_budget_alerts(provider,month,kind,created_at,next_attempt_at) VALUES('azure','2026-11','azure_threshold',now(),now())",
    );
    assert.equal((await new Operations(store).snapshot()).alertPending, 1);
  },
);
test(
  "monitor export retries durably and never calls log emission delivered",
  { skip: !databaseEnabled },
  async (t) => {
    const pool = await database(t);
    let now = new Date();
    const store = new Store(pool, undefined, "channel", () => now);
    await pool.query(
      "INSERT INTO model_budget_alerts(provider,month,kind,created_at,next_attempt_at) VALUES('azure','2026-11','azure_threshold',$1,$1)",
      [now],
    );
    const records: unknown[] = [];
    const alerts = new BudgetAlerts(store, async (e) => {
      records.push(e);
    });
    await Promise.all([alerts.processOne(), alerts.processOne()]);
    assert.equal(records.length, 1);
    let row = (await pool.query("SELECT * FROM model_budget_alerts")).rows[0];
    assert.equal(row.state, "pending");
    assert.equal(row.attempts, 1);
    now = new Date(now.getTime() + 3600001);
    await alerts.processOne();
    assert.deepEqual(records[0], records[1]);
    row = (await pool.query("SELECT * FROM model_budget_alerts")).rows[0];
    assert.equal(row.state, "pending");
    assert.equal(row.attempts, 2);
    await alerts.acknowledge(row.id, "azure-monitor-confirmed");
    assert.equal(await alerts.processOne(), false);
  },
);
