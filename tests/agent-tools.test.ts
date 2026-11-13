import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { database, databaseEnabled } from "./database.ts";
import { Store } from "../src/persistence/store.ts";
import { ReplyTokenCipher } from "../src/reply/token.ts";
import { Budgets } from "../src/agent/budgets.ts";
import { ToolLedger } from "../src/agent/tools.ts";
test(
  "semantic tool deduplication survives changed provider call IDs and reauthorizes cached results",
  { skip: !databaseEnabled },
  async (t) => {
    const pool = await database(t);
    await pool.query("UPDATE runtime_state SET mode='open'");
    const store = new Store(
        pool,
        new ReplyTokenCipher("a".repeat(64)),
        "fixture",
      ),
      budgets = new Budgets(store),
      id = randomUUID();
    await budgets.createRun({
      id,
      kind: "admin",
      actorId: "U" + "1".repeat(32),
    });
    let allowed = true,
      calls = 0;
    const ledger = new ToolLedger(budgets, id, async () => {
        if (!allowed) throw new Error("forbidden");
      }),
      schema = z.object({ a: z.string(), b: z.number() }).strict();
    const execute = async () => {
      calls++;
      return { proposal: "not executed" };
    };
    assert.deepEqual(
      await ledger.invoke("propose", schema, { a: "x", b: 1 }, execute),
      { proposal: "not executed" },
    );
    assert.deepEqual(
      await ledger.invoke("propose", schema, { b: 1, a: "x" }, execute),
      { proposal: "not executed" },
    );
    assert.equal(calls, 1);
    await assert.rejects(
      ledger.invoke(
        "propose",
        schema,
        { a: "x", b: 1, group: "other" },
        execute,
      ),
    );
    assert.equal(calls, 1);
    allowed = false;
    await assert.rejects(
      ledger.invoke("propose", schema, { a: "x", b: 1 }, execute),
      /forbidden/,
    );
    assert.equal(
      (await pool.query("SELECT tools FROM model_runs")).rows[0].tools,
      1,
    );
    const row = (await pool.query("SELECT * FROM agent_tools")).rows[0];
    assert.doesNotMatch(row.arguments_ciphertext, /"a"/);
    assert.doesNotMatch(row.result_ciphertext, /not executed/);
  },
);
test(
  "concurrent or unknown tool execution cannot replay and the run has one shared eight-tool limit",
  { skip: !databaseEnabled },
  async (t) => {
    const pool = await database(t);
    await pool.query("UPDATE runtime_state SET mode='open'");
    const store = new Store(
        pool,
        new ReplyTokenCipher("a".repeat(64)),
        "fixture",
      ),
      budgets = new Budgets(store),
      id = randomUUID();
    await budgets.createRun({
      id,
      kind: "admin",
      actorId: "U" + "1".repeat(32),
    });
    const ledger = new ToolLedger(budgets, id, async () => {}),
      schema = z.object({ n: z.number() });
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    let entered!: () => void;
    const started = new Promise<void>((r) => {
      entered = r;
    });
    const first = ledger.invoke("read", schema, { n: 0 }, async () => {
      entered();
      await held;
      return "result";
    });
    await started;
    await assert.rejects(
      ledger.invoke("read", schema, { n: 0 }, async () => {
        throw new Error("must not execute");
      }),
      /tool_outcome_unknown/,
    );
    release();
    await first;
    for (let n = 1; n < 8; n++)
      await ledger.invoke("read", schema, { n }, async () => n);
    await assert.rejects(
      ledger.invoke("read", schema, { n: 8 }, async () => 8),
      /run_budget_exhausted/,
    );
  },
);
