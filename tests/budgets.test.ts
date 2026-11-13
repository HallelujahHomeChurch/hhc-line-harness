import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { database, databaseEnabled } from "./database.ts";
import { Store } from "../src/persistence/store.ts";
import { Budgets, taipeiMonth } from "../src/agent/budgets.ts";
const price = {
  inputMicrosPerMillion: 1_000_000,
  outputMicrosPerMillion: 5_000_000,
};
async function fixture(t: Parameters<typeof database>[0]) {
  const pool = await database(t);
  let now = new Date("2026-11-30T15:59:59Z");
  await pool.query("UPDATE runtime_state SET mode='open'");
  const group = (
    await pool.query(
      "INSERT INTO groups(channel_id,line_group_id,state,active_from) VALUES('fixture',$1,'active',$2) RETURNING id",
      ["C" + "1".repeat(32), now],
    )
  ).rows[0].id;
  const store = new Store(pool, undefined, "fixture", () => now),
    budgets = new Budgets(store);
  const run = async () => {
    const id = randomUUID();
    await budgets.createRun({
      id,
      kind: "query",
      groupId: group,
      actorId: "U" + "2".repeat(32),
    });
    return id;
  };
  return {
    pool,
    budgets,
    run,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
  };
}
test("Taipei calendar month uses UTC+8 boundaries", () => {
  assert.equal(taipeiMonth(new Date("2026-11-30T15:59:59.999Z")), "2026-11");
  assert.equal(taipeiMonth(new Date("2026-11-30T16:00:00Z")), "2026-12");
});
test(
  "concurrent OpenAI reservations cannot exceed the shared $500 cap",
  { skip: !databaseEnabled },
  async (t) => {
    const f = await fixture(t);
    await f.pool.query(
      "INSERT INTO model_months(provider,month,charged_micros,reserved_micros) VALUES('openai','2026-11',499900000,0)",
    );
    const runs = await Promise.all(Array.from({ length: 20 }, () => f.run()));
    const outcomes = await Promise.allSettled(
      runs.map((runId) =>
        f.budgets.reserve({
          id: randomUUID(),
          runId,
          provider: "openai",
          model: "fixture",
          purpose: "answer",
          inputTokens: 10000,
          maxOutputTokens: 0,
          price,
        }),
      ),
    );
    assert.equal(outcomes.filter((r) => r.status === "fulfilled").length, 8);
    assert.ok(
      outcomes
        .filter((r) => r.status === "rejected")
        .every(
          (r) =>
            r.reason instanceof Error &&
            r.reason.message === "provider_budget_exhausted",
        ),
    );
    const month = (
      await f.pool.query(
        "SELECT * FROM model_months WHERE provider='openai' AND month='2026-11'",
      )
    ).rows[0];
    assert.ok(
      BigInt(month.charged_micros) + BigInt(month.reserved_micros) <=
        500_000_000n,
    );
  },
);
test(
  "unknown attempts retain reservations, settlements are idempotent, and old-month costs stay in their month",
  { skip: !databaseEnabled },
  async (t) => {
    const f = await fixture(t),
      runId = await f.run(),
      id = randomUUID();
    await f.budgets.reserve({
      id,
      runId,
      provider: "openai",
      model: "fixture",
      purpose: "answer",
      inputTokens: 1000,
      maxOutputTokens: 100,
      price,
    });
    await f.budgets.unknown(id);
    f.advance(2000);
    assert.equal(
      (
        await f.pool.query(
          "SELECT reserved_micros FROM model_months WHERE month='2026-11'",
        )
      ).rows[0].reserved_micros,
      "1800",
    );
    await f.budgets.settle(id, { inputTokens: 500, outputTokens: 50 });
    await f.budgets.settle(id, { inputTokens: 500, outputTokens: 50 });
    const month = (
      await f.pool.query("SELECT * FROM model_months WHERE month='2026-11'")
    ).rows[0];
    assert.equal(month.charged_micros, "750");
    assert.equal(month.reserved_micros, "0");
    const next = randomUUID();
    await f.budgets.reserve({
      id: next,
      runId,
      provider: "azure",
      model: "fixture",
      purpose: "answer",
      inputTokens: 1000,
      maxOutputTokens: 100,
      price,
    });
    assert.equal(
      (await f.pool.query("SELECT month FROM model_calls WHERE id=$1", [next]))
        .rows[0].month,
      "2026-12",
    );
    await assert.rejects(
      f.budgets.reserve({
        id,
        runId,
        provider: "openai",
        model: "fixture",
        purpose: "answer",
        inputTokens: 1000,
        maxOutputTokens: 100,
        price,
      }),
      /call_already_started/,
    );
  },
);
test(
  "Azure crosses $100 once with a durable alert and continues, while both providers share run token limits",
  { skip: !databaseEnabled },
  async (t) => {
    const f = await fixture(t),
      runId = await f.run();
    await f.pool.query(
      "INSERT INTO model_months(provider,month,charged_micros,reserved_micros) VALUES('azure','2026-11',100000000,0)",
    );
    for (let i = 0; i < 2; i++)
      await f.budgets.reserve({
        id: randomUUID(),
        runId,
        provider: "azure",
        model: "fixture",
        purpose: "answer",
        inputTokens: 10000,
        maxOutputTokens: 0,
        price,
      });
    assert.equal(
      (await f.pool.query("SELECT count(*) AS n FROM model_budget_alerts"))
        .rows[0].n,
      "1",
    );
    await assert.rejects(
      f.budgets.reserve({
        id: randomUUID(),
        runId,
        provider: "openai",
        model: "fixture",
        purpose: "answer",
        inputTokens: 13000,
        maxOutputTokens: 0,
        price,
      }),
      /run_budget_exhausted/,
    );
  },
);
test(
  "cache pricing reserves the worst input rate and settles detached token details",
  { skip: !databaseEnabled },
  async (t) => {
    const f = await fixture(t),
      runId = await f.run(),
      id = randomUUID();
    await f.budgets.reserve({
      id,
      runId,
      provider: "openai",
      model: "fixture",
      purpose: "answer",
      inputTokens: 1000,
      maxOutputTokens: 100,
      price: {
        ...price,
        cachedInputMicrosPerMillion: 50000,
        cacheWriteMicrosPerMillion: 2500000,
      },
    });
    assert.equal(
      (
        await f.pool.query(
          "SELECT reserved_micros FROM model_calls WHERE id=$1",
          [id],
        )
      ).rows[0].reserved_micros,
      "3600",
    );
    await f.budgets.settle(id, {
      inputTokens: 1000,
      outputTokens: 100,
      cachedInputTokens: 500,
      cacheWriteTokens: 200,
    });
    assert.equal(
      (
        await f.pool.query(
          "SELECT actual_micros FROM model_calls WHERE id=$1",
          [id],
        )
      ).rows[0].actual_micros,
      "1325",
    );
    await assert.rejects(
      f.budgets.settle(id, {
        inputTokens: 1000,
        outputTokens: 100,
        cachedInputTokens: 400,
        cacheWriteTokens: 200,
      }),
      /usage_conflict/,
    );
  },
);
test(
  "admin runs require an actor and are fenced to their owning channel",
  { skip: !databaseEnabled },
  async (t) => {
    const f = await fixture(t);
    await assert.rejects(
      f.budgets.createRun({ id: randomUUID(), kind: "admin" }),
      /invalid_run/,
    );
    const id = randomUUID();
    await f.budgets.createRun({
      id,
      kind: "admin",
      actorId: "U" + "2".repeat(32),
    });
    const other = new Budgets(new Store(f.pool, undefined, "other"));
    await assert.rejects(
      other.reserve({
        id: randomUUID(),
        runId: id,
        provider: "openai",
        model: "fixture",
        purpose: "answer",
        inputTokens: 1,
        maxOutputTokens: 1,
        price,
      }),
      /run_fenced/,
    );
  },
);
test(
  "reservations cover the longest cache-write tariff and settle each retention tier separately",
  { skip: !databaseEnabled },
  async (t) => {
    const f = await fixture(t),
      runId = await f.run(),
      id = randomUUID();
    await f.budgets.reserve({
      id,
      runId,
      provider: "openai",
      model: "fixture",
      purpose: "answer",
      inputTokens: 1000,
      maxOutputTokens: 100,
      price: {
        ...price,
        cachedInputMicrosPerMillion: 50000,
        cacheWriteMicrosPerMillion: 1250000,
        cacheWriteLongMicrosPerMillion: 2500000,
      },
    });
    assert.equal(
      (
        await f.pool.query(
          "SELECT reserved_micros FROM model_calls WHERE id=$1",
          [id],
        )
      ).rows[0].reserved_micros,
      "3600",
    );
    await f.budgets.settle(id, {
      inputTokens: 1000,
      outputTokens: 100,
      cachedInputTokens: 500,
      cacheWriteTokens: 100,
      cacheWriteLongTokens: 100,
    });
    assert.equal(
      (
        await f.pool.query(
          "SELECT actual_micros FROM model_calls WHERE id=$1",
          [id],
        )
      ).rows[0].actual_micros,
      "1200",
    );
    await assert.rejects(
      f.budgets.settle(id, {
        inputTokens: 1000,
        outputTokens: 100,
        cachedInputTokens: 500,
        cacheWriteTokens: 100,
        cacheWriteLongTokens: 101,
      }),
      /usage_conflict/,
    );
  },
);
