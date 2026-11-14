import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import {
  Usage,
  type Model,
  type ModelRequest,
  type ModelResponse,
} from "@openai/agents";
import { database, databaseEnabled } from "./database.ts";
import { ReplyTokenCipher } from "../src/reply/token.ts";
import { Store } from "../src/persistence/store.ts";
import { Budgets } from "../src/agent/budgets.ts";
import { BudgetModel } from "../src/agent/model.ts";
const request: ModelRequest = {
  input: "find file",
  tools: [],
  handoffs: [],
  outputType: "text",
  modelSettings: {},
  tracing: false,
};
const response = (): ModelResponse => ({
  usage: new Usage({ inputTokens: 10, outputTokens: 5 }),
  rawUsage: {
    input_tokens: 10,
    output_tokens: 5,
    input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
  },
  output: [
    {
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "done" }],
    },
  ],
  responseId: "private-response",
  providerData: { secret: "hidden" },
});
const model = (getResponse: Model["getResponse"]): Model => ({
  getResponse,
  async *getStreamedResponse() {
    throw new Error("unused");
  },
});
async function fixture(
  t: Parameters<typeof database>[0],
  primary: Model,
  secondary: Model,
) {
  const pool = await database(t);
  await pool.query("UPDATE runtime_state SET mode='open'");
  const store = new Store(
      pool,
      new ReplyTokenCipher("a".repeat(64)),
      "fixture",
    ),
    budgets = new Budgets(store),
    id = randomUUID();
  await budgets.createRun({ id, kind: "admin", actorId: "U" + "1".repeat(32) });
  const providers = {
    openai: {
      model: primary,
      name: "fixture",
      price: {
        inputMicrosPerMillion: 1000000,
        outputMicrosPerMillion: 5000000,
      },
    },
    azure: {
      model: secondary,
      name: "fixture-deployment",
      price: {
        inputMicrosPerMillion: 1000000,
        outputMicrosPerMillion: 5000000,
      },
    },
  };
  return {
    pool,
    store,
    id,
    make: () => new BudgetModel(budgets, id, providers, async () => {}),
  };
}
test(
  "safe fallback is sticky and strips provider state; restart replays completed steps without another call",
  { skip: !databaseEnabled },
  async (t) => {
    let p = 0,
      a = 0;
    const f = await fixture(
      t,
      model(async () => {
        p++;
        throw Object.assign(new Error("temporary"), { status: 503 });
      }),
      model(async (r) => {
        a++;
        assert.equal(r.previousResponseId, undefined);
        assert.equal(r.conversationId, undefined);
        assert.equal(r.modelSettings.store, false);
        assert.equal(r.modelSettings.retry?.maxRetries, 0);
        return response();
      }),
    );
    const runner = f.make();
    const first = await runner.getResponse({
      ...request,
      previousResponseId: "old",
      conversationId: "old",
    });
    assert.equal(first.responseId, undefined);
    assert.equal(first.providerData, undefined);
    await runner.getResponse({ ...request, input: "second step" });
    assert.equal(p, 1);
    assert.equal(a, 2);
    await f.make().getResponse(request);
    assert.equal(a, 2);
    assert.equal(
      (
        await f.pool.query(
          "SELECT count(*) n FROM model_calls WHERE state='unknown'",
        )
      ).rows[0].n,
      "1",
    );
  },
);
test(
  "bad arguments and authorization errors do not trigger provider fallback",
  { skip: !databaseEnabled },
  async (t) => {
    let a = 0;
    const f = await fixture(
      t,
      model(async () => {
        throw Object.assign(new Error("bad arguments"), { status: 400 });
      }),
      model(async () => {
        a++;
        return response();
      }),
    );
    await assert.rejects(f.make().getResponse(request));
    assert.equal(a, 0);
  },
);
test(
  "missing usage holds the reservation and cannot execute an unaccounted model response",
  { skip: !databaseEnabled },
  async (t) => {
    let a = 0;
    const f = await fixture(
      t,
      model(async () => {
        const r = response();
        delete r.rawUsage;
        return r;
      }),
      model(async () => {
        a++;
        return response();
      }),
    );
    await assert.rejects(f.make().getResponse(request), /model_usage_unknown/);
    assert.equal(a, 0);
    assert.equal(
      (await f.pool.query("SELECT state FROM model_calls")).rows[0].state,
      "unknown",
    );
    await assert.rejects(f.make().getResponse(request), /model_step_unknown/);
  },
);
test(
  "resumed model inputs must match their durable request and scope is rechecked",
  { skip: !databaseEnabled },
  async (t) => {
    const f = await fixture(
      t,
      model(async () => response()),
      model(async () => response()),
    );
    await f.make().getResponse(request);
    await assert.rejects(
      f.make().getResponse({ ...request, input: "changed" }),
      /model_step_conflict/,
    );
    await f.pool.query("UPDATE runtime_state SET generation=generation+1");
    await assert.rejects(f.make().getResponse(request), /run_fenced/);
  },
);
test(
  "official OpenAI connection exceptions trigger fallback even when Error.name is generic",
  { skip: !databaseEnabled },
  async (t) => {
    const { APIConnectionError } = await import("openai");
    let secondary = 0;
    const error = new APIConnectionError({
      message: "fixture connection failure",
    });
    assert.equal(error.name, "Error");
    const f = await fixture(
      t,
      model(async () => {
        throw error;
      }),
      model(async () => {
        secondary++;
        return response();
      }),
    );
    await f.make().getResponse(request);
    assert.equal(secondary, 1);
  },
);
test(
  "incomplete assistant output is never promoted to a completed safe model step",
  { skip: !databaseEnabled },
  async (t) => {
    let secondary = 0;
    const f = await fixture(
      t,
      model(async () => ({
        ...response(),
        output: [
          {
            type: "message",
            role: "assistant",
            status: "incomplete",
            content: [{ type: "output_text", text: "partial" }],
          },
        ],
      })),
      model(async () => {
        secondary++;
        return response();
      }),
    );
    await assert.rejects(
      f.make().getResponse(request),
      /incomplete_model_response/,
    );
    assert.equal(secondary, 0);
    assert.equal(
      (
        await f.pool.query(
          "SELECT count(*) n FROM model_steps WHERE state='completed'",
        )
      ).rows[0].n,
      "0",
    );
  },
);
