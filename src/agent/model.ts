import { APIConnectionError } from "openai";
import { createHash, randomUUID } from "node:crypto";
import {
  Usage,
  protocol,
  type Model,
  type ModelRequest,
  type ModelResponse,
  type AgentInputItem,
  type AgentOutputItem,
} from "@openai/agents";
import {
  Budgets,
  type Provider,
  type Price,
  type TokenUsage,
} from "./budgets.ts";
export interface ProviderModel {
  model: Model;
  name: string;
  price: Price;
}
export type ModelProviders = Record<Provider, ProviderModel>;
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
// Only application-owned text and complete function calls cross provider boundaries.
export function portable(input: AgentInputItem[]): AgentInputItem[] {
  return input
    .filter((i) => i.type !== "reasoning")
    .map((i) => {
      if (i.type === undefined || i.type === "message") {
        if (i.role === "assistant" && i.status !== "completed")
          throw new Error("incomplete_model_response");
        if (typeof i.content === "string") {
          if (i.role === "assistant")
            return {
              type: "message",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: i.content }],
            };
          return { type: "message", role: i.role, content: i.content };
        }
        return {
          type: "message",
          role: i.role,
          ...(i.role === "assistant" ? { status: "completed" as const } : {}),
          content: i.content.map((c) => {
            if (c.type === "input_text" || c.type === "output_text")
              return { type: c.type, text: c.text };
            if (c.type === "refusal")
              return { type: c.type, refusal: c.refusal };
            throw new Error("unsupported_model_content");
          }),
        } as AgentInputItem;
      }
      if (i.type === "function_call") {
        if (i.status && i.status !== "completed")
          throw new Error("incomplete_tool_call");
        if (Buffer.byteLength(i.arguments) > 8192)
          throw new Error("invalid_tool_arguments");
        JSON.parse(i.arguments);
        return {
          type: i.type,
          callId: i.callId,
          name: i.name,
          arguments: i.arguments,
          status: "completed",
        };
      }
      if (i.type === "function_call_result" && i.status === "completed") {
        let output: string;
        if (typeof i.output === "string") output = i.output;
        else if (!Array.isArray(i.output) && i.output.type === "text")
          output = i.output.text;
        else throw new Error("unsupported_model_content");
        return {
          type: i.type,
          callId: i.callId,
          name: i.name,
          status: i.status,
          output,
        };
      }
      throw new Error("unsupported_model_content");
    });
}
function usage(raw: Record<string, unknown> | undefined): TokenUsage {
  const details = raw?.input_tokens_details as
    Record<string, unknown> | undefined;
  const input = raw?.input_tokens,
    output = raw?.output_tokens,
    cached = details?.cached_tokens,
    written = details?.cache_write_tokens ?? 0;
  if (
    [input, output, cached, written].some(
      (n) => typeof n !== "number" || !Number.isSafeInteger(n) || n < 0,
    )
  )
    throw new Error("model_usage_unknown");
  const retention = details?.cache_write_tokens_details as
    Record<string, unknown> | undefined;
  const short = retention?.ttl_30m_tokens ?? (written === 0 ? 0 : undefined);
  const long = retention?.ttl_12h_tokens ?? (written === 0 ? 0 : undefined);
  if (
    [short, long].some(
      (n) => typeof n !== "number" || !Number.isSafeInteger(n) || n < 0,
    ) ||
    (short as number) + (long as number) !== written
  )
    throw new Error("model_usage_unknown");
  return {
    inputTokens: input as number,
    outputTokens: output as number,
    cachedInputTokens: cached as number,
    cacheWriteTokens: short as number,
    cacheWriteLongTokens: long as number,
  };
}
function retryable(e: unknown) {
  if (!(e instanceof Error)) return false;
  const status = "status" in e ? e.status : undefined;
  return (
    e.message === "provider_budget_exhausted" ||
    e instanceof APIConnectionError ||
    status === 429 ||
    (typeof status === "number" && status >= 500 && status <= 599)
  );
}
export class BudgetModel implements Model {
  readonly budgets: Budgets;
  readonly runId: string;
  readonly providers: ModelProviders;
  readonly authorize: () => Promise<void>;
  ordinal = 0;
  constructor(
    budgets: Budgets,
    runId: string,
    providers: ModelProviders,
    authorize: () => Promise<void>,
  ) {
    this.budgets = budgets;
    this.runId = runId;
    this.providers = providers;
    this.authorize = authorize;
  }
  async *getStreamedResponse(): AsyncGenerator<never> {
    throw new Error("streaming_disabled");
  }
  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    await this.authorize();
    const safe: ModelRequest = {
      input:
        typeof request.input === "string"
          ? request.input
          : portable(request.input),
      systemInstructions: request.systemInstructions,
      tools: request.tools,
      outputType: request.outputType,
      handoffs: [],
      tracing: false,
      modelSettings: {
        maxTokens: 2048,
        store: false,
        preserveRawUsage: true,
        parallelToolCalls: false,
        retry: { maxRetries: 0 },
      },
    };
    if (
      request.handoffs.length ||
      request.tools.some((t) => t.type !== "function")
    )
      throw new Error("unsupported_model_tool");
    const encoded = JSON.stringify(safe),
      hash = digest(encoded),
      ordinal = this.ordinal++;
    const state = await this.budgets.store.transaction(async (c) => {
      const run = await this.budgets.guard(c, this.runId);
      const old = (
        await c.query(
          "SELECT * FROM model_steps WHERE run_id=$1 AND ordinal=$2",
          [this.runId, ordinal],
        )
      ).rows[0];
      if (old) {
        if (old.request_hash !== hash) throw new Error("model_step_conflict");
        if (old.state !== "completed") throw new Error("model_step_unknown");
        return {
          provider: run.provider as Provider,
          ciphertext: old.response_ciphertext as string,
          deadline: run.deadline as Date,
        };
      }
      await c.query(
        "INSERT INTO model_steps(run_id,ordinal,request_hash,state) VALUES($1,$2,$3,'started')",
        [this.runId, ordinal, hash],
      );
      return {
        provider: run.provider as Provider,
        deadline: run.deadline as Date,
      };
    });
    if (state.ciphertext) {
      const saved = JSON.parse(
        this.budgets.store.cipher.openPayload(
          state.ciphertext,
          `model:${this.runId}:${ordinal}`,
        ),
      ) as { output: AgentOutputItem[]; usage: TokenUsage };
      return { output: saved.output, usage: new Usage(saved.usage) };
    }
    let provider = state.provider;
    for (;;) {
      let callId: string | undefined;
      try {
        await this.authorize();
        const selected = this.providers[provider];
        const id = randomUUID();
        // UTF-8 bytes upper-bound text BPE tokens; allow additional serialized protocol overhead.
        await this.budgets.reserve({
          id,
          runId: this.runId,
          provider,
          model: selected.name,
          purpose: "answer",
          inputTokens: Buffer.byteLength(encoded) + 1024,
          maxOutputTokens: 2048,
          price: selected.price,
        });
        callId = id;
        const remaining =
          state.deadline.getTime() - this.budgets.store.now().getTime();
        if (remaining <= 0) throw new Error("run_fenced");
        const signal = AbortSignal.any([
          AbortSignal.timeout(remaining),
          ...(request.signal ? [request.signal] : []),
        ]);
        const response = await selected.model.getResponse({ ...safe, signal });
        const tokens = usage(response.rawUsage);
        await this.budgets.settle(id, tokens);
        const output = portable(response.output).map((o) =>
          o.type === "function_call"
            ? protocol.FunctionCallItem.parse(o)
            : protocol.AssistantMessageItem.parse(o),
        );
        if (!output.length) throw new Error("empty_model_response");
        await this.authorize();
        const value = JSON.stringify({ output, usage: tokens });
        await this.budgets.store.transaction(async (c) => {
          await this.budgets.guard(c, this.runId);
          await c.query(
            "UPDATE model_steps SET state='completed',response_ciphertext=$3 WHERE run_id=$1 AND ordinal=$2",
            [
              this.runId,
              ordinal,
              this.budgets.store.cipher.sealPayload(
                value,
                `model:${this.runId}:${ordinal}`,
              ),
            ],
          );
        });
        return { output, usage: new Usage(tokens) };
      } catch (e) {
        if (callId) await this.budgets.unknown(callId);
        if (provider !== "openai" || !retryable(e)) throw e;
        await this.budgets.store.transaction(async (c) => {
          await this.budgets.guard(c, this.runId);
          await c.query("UPDATE model_runs SET provider='azure' WHERE id=$1", [
            this.runId,
          ]);
        });
        provider = "azure";
      }
    }
  }
}
