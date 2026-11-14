import assert from "node:assert/strict";
import test from "node:test";
import {
  createModelProviders,
  loadAgentConfig,
} from "../src/agent/providers.ts";
import { Agent, Runner } from "@openai/agents";
const rates = {
  inputMicrosPerMillion: 1000000,
  outputMicrosPerMillion: 5000000,
  cachedInputMicrosPerMillion: 50000,
  cacheWriteMicrosPerMillion: 1250000,
  cacheWriteLongMicrosPerMillion: 2500000,
};
test("models are opt-in and require explicit deployments and tariff snapshots", () => {
  assert.equal(loadAgentConfig({}), undefined);
  assert.throws(() => loadAgentConfig({ AGENT_ENABLED: "yes" }));
  assert.throws(() => loadAgentConfig({ AGENT_ENABLED: "true" }));
});
test("official Responses adapters never retry, store responses or export sensitive traces", async () => {
  const seen: { url: string; body: Record<string, unknown> }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    seen.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    return new Response(
      JSON.stringify({
        error: { message: "unavailable", type: "server_error" },
      }),
      { status: 503, headers: { "content-type": "application/json" } },
    );
  };
  const providers = createModelProviders(
    {
      openaiKey: "synthetic",
      openaiModel: "gpt-6.1-terra",
      azureEndpoint: "https://fixture.openai.azure.com/openai/v1/",
      azureDeployment: "fixture-deployment",
      identityClientId: "fixture",
      openaiPrice: rates,
      azurePrice: rates,
    },
    fetcher,
    async () => "synthetic-entra-token",
  );
  const runner = new Runner({
    tracingDisabled: true,
    traceIncludeSensitiveData: false,
    modelSettings: {
      store: false,
      preserveRawUsage: true,
      retry: { maxRetries: 0 },
    },
  });
  await assert.rejects(
    runner.run(
      new Agent({ name: "fixture", model: providers.openai.model }),
      "private fixture",
    ),
    { status: 503 },
  );
  await assert.rejects(
    runner.run(
      new Agent({ name: "fixture", model: providers.azure.model }),
      "private fixture",
    ),
    { status: 503 },
  );
  assert.equal(seen.length, 2);
  assert.ok(seen[0]!.url.endsWith("/v1/responses"));
  assert.ok(seen[1]!.url.endsWith("/openai/v1/responses"));
  assert.equal(seen[0]!.body.store, false);
  assert.equal(seen[1]!.body.model, "fixture-deployment");
});
