import type { PoolClient } from "pg";
import type { Store } from "../persistence/store.ts";
export type Provider = "openai" | "azure";
export interface Price {
  inputMicrosPerMillion: number;
  outputMicrosPerMillion: number;
  cachedInputMicrosPerMillion?: number;
  cacheWriteMicrosPerMillion?: number;
  cacheWriteLongMicrosPerMillion?: number;
}
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  cacheWriteLongTokens?: number;
}
export const RUN_LIMITS = {
  milliseconds: 45_000,
  tokens: 32_000,
  calls: 4,
  tools: 8,
} as const;
export function taipeiMonth(date: Date): string {
  return new Date(date.getTime() + 8 * 3600_000).toISOString().slice(0, 7);
}
function integer(value: number, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 0 || value > max)
    throw new Error("invalid_usage");
}
function cost(
  input: number,
  output: number,
  price: Price,
  cached = 0,
  written = 0,
  longWritten = 0,
): bigint {
  for (const v of [
    input,
    output,
    cached,
    written,
    longWritten,
    price.inputMicrosPerMillion,
    price.outputMicrosPerMillion,
    price.cachedInputMicrosPerMillion ?? price.inputMicrosPerMillion,
    price.cacheWriteMicrosPerMillion ?? price.inputMicrosPerMillion,
    price.cacheWriteLongMicrosPerMillion ??
      price.cacheWriteMicrosPerMillion ??
      price.inputMicrosPerMillion,
  ])
    integer(v);
  if (cached + written + longWritten > input) throw new Error("invalid_usage");
  return (
    (BigInt(input - cached - written - longWritten) *
      BigInt(price.inputMicrosPerMillion) +
      BigInt(cached) *
        BigInt(
          price.cachedInputMicrosPerMillion ?? price.inputMicrosPerMillion,
        ) +
      BigInt(written) *
        BigInt(
          price.cacheWriteMicrosPerMillion ?? price.inputMicrosPerMillion,
        ) +
      BigInt(longWritten) *
        BigInt(
          price.cacheWriteLongMicrosPerMillion ??
            price.cacheWriteMicrosPerMillion ??
            price.inputMicrosPerMillion,
        ) +
      BigInt(output) * BigInt(price.outputMicrosPerMillion) +
      999999n) /
    1000000n
  );
}
export interface ReserveInput {
  id: string;
  runId: string;
  provider: Provider;
  model: string;
  purpose: "answer" | "embedding" | "summary";
  inputTokens: number;
  maxOutputTokens: number;
  price: Price;
}
export class Budgets {
  readonly store: Store;
  constructor(store: Store) {
    this.store = store;
  }
  async createRun(input: {
    id: string;
    kind: "query" | "admin" | "index";
    groupId?: string;
    actorId?: string;
  }) {
    if (
      !/^[0-9a-f-]{36}$/.test(input.id) ||
      (!input.groupId && input.kind !== "admin") ||
      (input.kind !== "index" && !input.actorId) ||
      (input.actorId !== undefined && !/^U[0-9a-f]{32}$/.test(input.actorId))
    )
      throw new Error("invalid_run");
    await this.store.transaction(async (c) => {
      const runtime = (await c.query("SELECT * FROM runtime_state FOR SHARE"))
        .rows[0];
      if (runtime.mode !== "open") throw new Error("run_fenced");
      if (input.groupId) {
        const group = (
          await c.query(
            "SELECT state,channel_id FROM groups WHERE id=$1 FOR SHARE",
            [input.groupId],
          )
        ).rows[0];
        if (
          group?.state !== "active" ||
          group.channel_id !== this.store.channelId
        )
          throw new Error("run_fenced");
      }
      await c.query(
        "INSERT INTO model_runs(id,kind,group_id,actor_id,runtime_generation,created_at,deadline,channel_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING",
        [
          input.id,
          input.kind,
          input.groupId ?? null,
          input.actorId ?? null,
          runtime.generation,
          this.store.now(),
          new Date(this.store.now().getTime() + RUN_LIMITS.milliseconds),
          this.store.channelId,
        ],
      );
      const current = (
        await c.query("SELECT * FROM model_runs WHERE id=$1", [input.id])
      ).rows[0];
      if (
        current.channel_id !== this.store.channelId ||
        current.kind !== input.kind ||
        current.group_id !== (input.groupId ?? null) ||
        current.actor_id !== (input.actorId ?? null) ||
        current.runtime_generation !== runtime.generation
      )
        throw new Error("run_fenced");
    });
  }
  async guard(c: PoolClient, id: string) {
    const runtime = (await c.query("SELECT * FROM runtime_state FOR SHARE"))
      .rows[0];
    const identity = (
      await c.query("SELECT group_id FROM model_runs WHERE id=$1", [id])
    ).rows[0];
    if (identity?.group_id) {
      const group = (
        await c.query(
          "SELECT state,channel_id FROM groups WHERE id=$1 FOR SHARE",
          [identity.group_id],
        )
      ).rows[0];
      if (
        group?.state !== "active" ||
        group.channel_id !== this.store.channelId
      )
        throw new Error("run_fenced");
    }
    const run = (
      await c.query("SELECT * FROM model_runs WHERE id=$1 FOR UPDATE", [id])
    ).rows[0];
    if (
      !run ||
      run.channel_id !== this.store.channelId ||
      run.state !== "running" ||
      run.deadline <= this.store.now() ||
      runtime.mode !== "open" ||
      runtime.generation !== run.runtime_generation
    )
      throw new Error("run_fenced");
    return run;
  }
  async reserve(
    input: ReserveInput,
  ): Promise<{ id: string; month: string; reservedMicros: bigint }> {
    integer(input.inputTokens, RUN_LIMITS.tokens);
    integer(input.maxOutputTokens, RUN_LIMITS.tokens);
    if (
      !/^[0-9a-f-]{36}$/.test(input.id) ||
      !["openai", "azure"].includes(input.provider) ||
      !input.model ||
      input.model.length > 128
    )
      throw new Error("invalid_usage");
    const reserve =
      (cost(input.inputTokens, input.maxOutputTokens, {
        ...input.price,
        inputMicrosPerMillion: Math.max(
          input.price.inputMicrosPerMillion,
          input.price.cacheWriteMicrosPerMillion ?? 0,
          input.price.cacheWriteLongMicrosPerMillion ?? 0,
          input.price.cachedInputMicrosPerMillion ?? 0,
        ),
      }) *
        120n +
        99n) /
      100n;
    return this.store.transaction(async (c) => {
      const run = await this.guard(c, input.runId);
      if (
        (await c.query("SELECT id FROM model_calls WHERE id=$1", [input.id]))
          .rowCount
      )
        throw new Error("call_already_started");
      if (
        run.calls >= RUN_LIMITS.calls ||
        BigInt(run.used_tokens) +
          BigInt(run.reserved_tokens) +
          BigInt(input.inputTokens + input.maxOutputTokens) >
          BigInt(RUN_LIMITS.tokens)
      )
        throw new Error("run_budget_exhausted");
      const month = taipeiMonth(this.store.now());
      await c.query(
        "INSERT INTO model_months(provider,month) VALUES($1,$2) ON CONFLICT DO NOTHING",
        [input.provider, month],
      );
      const row = (
        await c.query(
          "SELECT * FROM model_months WHERE provider=$1 AND month=$2 FOR UPDATE",
          [input.provider, month],
        )
      ).rows[0];
      const exposure =
        BigInt(row.charged_micros) + BigInt(row.reserved_micros) + reserve;
      if (input.provider === "openai" && exposure > 500_000_000n)
        throw new Error("provider_budget_exhausted");
      await c.query(
        "UPDATE model_months SET reserved_micros=reserved_micros+$3 WHERE provider=$1 AND month=$2",
        [input.provider, month, reserve.toString()],
      );
      await c.query(
        "UPDATE model_runs SET calls=calls+1,reserved_tokens=reserved_tokens+$2 WHERE id=$1",
        [input.runId, input.inputTokens + input.maxOutputTokens],
      );
      await c.query(
        `INSERT INTO model_calls(id,run_id,provider,month,model,purpose,price,input_limit,output_limit,reserved_micros,started_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          input.id,
          input.runId,
          input.provider,
          month,
          input.model,
          input.purpose,
          input.price,
          input.inputTokens,
          input.maxOutputTokens,
          reserve.toString(),
          this.store.now(),
        ],
      );
      if (input.provider === "azure" && exposure > 100_000_000n)
        await this.alert(c, input.provider, month, "azure_threshold");
      return { id: input.id, month, reservedMicros: reserve };
    });
  }
  async alert(
    c: PoolClient,
    provider: Provider,
    month: string,
    kind: "azure_threshold" | "reservation_overrun",
  ) {
    await c.query(
      "INSERT INTO model_budget_alerts(provider,month,kind,created_at,next_attempt_at) VALUES($1,$2,$3,$4,$4) ON CONFLICT(provider,month,kind) DO NOTHING",
      [provider, month, kind, this.store.now()],
    );
  }
  async unknown(id: string) {
    await this.store.pool.query(
      "UPDATE model_calls SET state='unknown' WHERE id=$1 AND state='started'",
      [id],
    );
  }
  async settle(id: string, usage: TokenUsage) {
    integer(usage.inputTokens);
    integer(usage.outputTokens);
    return this.store.transaction(async (c) => {
      const identity = (
        await c.query("SELECT * FROM model_calls WHERE id=$1", [id])
      ).rows[0];
      if (!identity) throw new Error("unknown_model_call");
      await c.query("SELECT id FROM model_runs WHERE id=$1 FOR UPDATE", [
        identity.run_id,
      ]);
      await c.query(
        "SELECT provider FROM model_months WHERE provider=$1 AND month=$2 FOR UPDATE",
        [identity.provider, identity.month],
      );
      const call = (
        await c.query("SELECT * FROM model_calls WHERE id=$1 FOR UPDATE", [id])
      ).rows[0];
      if (call.settlement_fenced) throw new Error("restored_model_call");
      const actual = cost(
        usage.inputTokens,
        usage.outputTokens,
        call.price as Price,
        usage.cachedInputTokens ?? 0,
        usage.cacheWriteTokens ?? 0,
        usage.cacheWriteLongTokens ?? 0,
      );
      if (call.state === "settled") {
        if (
          call.input_tokens !== usage.inputTokens ||
          call.output_tokens !== usage.outputTokens ||
          call.cached_input_tokens !== (usage.cachedInputTokens ?? 0) ||
          call.cache_write_tokens !== (usage.cacheWriteTokens ?? 0) ||
          call.cache_write_long_tokens !== (usage.cacheWriteLongTokens ?? 0)
        )
          throw new Error("usage_conflict");
        return;
      }
      await c.query(
        "UPDATE model_months SET reserved_micros=reserved_micros-$3,charged_micros=charged_micros+$4 WHERE provider=$1 AND month=$2",
        [call.provider, call.month, call.reserved_micros, actual.toString()],
      );
      const overrun =
        actual > BigInt(call.reserved_micros) ||
        usage.inputTokens > call.input_limit ||
        usage.outputTokens > call.output_limit;
      await c.query(
        "UPDATE model_runs SET reserved_tokens=reserved_tokens-$2,used_tokens=used_tokens+$3,state=CASE WHEN $4 THEN 'failed' ELSE state END WHERE id=$1",
        [
          call.run_id,
          call.input_limit + call.output_limit,
          usage.inputTokens + usage.outputTokens,
          overrun,
        ],
      );
      await c.query(
        "UPDATE model_calls SET state='settled',actual_micros=$2,input_tokens=$3,output_tokens=$4,settled_at=$5,cached_input_tokens=$6,cache_write_tokens=$7,cache_write_long_tokens=$8 WHERE id=$1",
        [
          id,
          actual.toString(),
          usage.inputTokens,
          usage.outputTokens,
          this.store.now(),
          usage.cachedInputTokens ?? 0,
          usage.cacheWriteTokens ?? 0,
          usage.cacheWriteLongTokens ?? 0,
        ],
      );
      if (overrun)
        await this.alert(c, call.provider, call.month, "reservation_overrun");
      if (call.provider === "azure") {
        const month = (
          await c.query(
            "SELECT charged_micros,reserved_micros FROM model_months WHERE provider=$1 AND month=$2",
            [call.provider, call.month],
          )
        ).rows[0];
        if (
          BigInt(month.charged_micros) + BigInt(month.reserved_micros) >
          100_000_000n
        )
          await this.alert(c, call.provider, call.month, "azure_threshold");
      }
    });
  }
}
