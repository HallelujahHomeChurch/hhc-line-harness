import { createHash } from "node:crypto";
import { z } from "zod";
import { Budgets, RUN_LIMITS } from "./budgets.ts";
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value;
}
export class ToolLedger {
  readonly budgets: Budgets;
  readonly runId: string;
  readonly authorize: () => Promise<void>;
  constructor(budgets: Budgets, runId: string, authorize: () => Promise<void>) {
    this.budgets = budgets;
    this.runId = runId;
    this.authorize = authorize;
  }
  async invoke<S extends z.ZodType, R>(
    name: string,
    schema: S,
    input: unknown,
    execute: (args: z.infer<S>) => Promise<R>,
  ): Promise<R> {
    const args = schema.parse(input),
      encoded = JSON.stringify(canonical(args));
    if (!/^[a-z_]{1,64}$/.test(name) || Buffer.byteLength(encoded) > 8192)
      throw new Error("invalid_tool_arguments");
    const key = createHash("sha256")
        .update(name + "\n" + encoded)
        .digest("hex"),
      context = `tool:${this.runId}:${key}`,
      store = this.budgets.store;
    await this.authorize();
    const previous = await store.transaction(async (c) => {
      const run = await this.budgets.guard(c, this.runId);
      const old = (
        await c.query("SELECT * FROM agent_tools WHERE run_id=$1 AND key=$2", [
          this.runId,
          key,
        ])
      ).rows[0];
      if (old) {
        if (old.state !== "completed") throw new Error("tool_outcome_unknown");
        return old.result_ciphertext as string;
      }
      if (run.tools >= RUN_LIMITS.tools)
        throw new Error("run_budget_exhausted");
      await c.query("UPDATE model_runs SET tools=tools+1 WHERE id=$1", [
        this.runId,
      ]);
      await c.query(
        "INSERT INTO agent_tools(run_id,key,name,arguments_ciphertext,state) VALUES($1,$2,$3,$4,'started')",
        [
          this.runId,
          key,
          name,
          store.cipher.sealPayload(encoded, context + ":args"),
        ],
      );
    });
    if (previous)
      return JSON.parse(
        store.cipher.openPayload(previous, context + ":result"),
      ) as R;
    const result = await execute(args);
    await this.authorize();
    const serialized = JSON.stringify(result);
    if (serialized === undefined || Buffer.byteLength(serialized) > 32768)
      throw new Error("tool_output_limit");
    await store.transaction(async (c) => {
      await this.budgets.guard(c, this.runId);
      await c.query(
        "UPDATE agent_tools SET state='completed',result_ciphertext=$3 WHERE run_id=$1 AND key=$2",
        [
          this.runId,
          key,
          store.cipher.sealPayload(serialized, context + ":result"),
        ],
      );
    });
    return result;
  }
}
