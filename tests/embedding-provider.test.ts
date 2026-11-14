import assert from "node:assert/strict";
import test from "node:test";
import {
  loadEmbeddingConfig,
  createEmbeddingProvider,
} from "../src/providers/embeddings.ts";
test("embedding configuration is off by default and requires a separate fixed model/dimension/rate version", () => {
  assert.equal(loadEmbeddingConfig({}), undefined);
  assert.throws(() => loadEmbeddingConfig({ EMBEDDING_ENABLED: "true" }));
  assert.throws(() => loadEmbeddingConfig({ EMBEDDING_ENABLED: "yes" }));
});
test("official embedding transport disables retry and checks model identity, dimensions, count and usage", async () => {
  let calls = 0;
  const config = {
    version: "fixture-v1",
    provider: "openai" as const,
    model: "fixture-model",
    responseModel: "fixture-model",
    dimensions: 3,
    inputMicrosPerMillion: 100000,
    openaiKey: "synthetic",
  };
  const provider = createEmbeddingProvider(config, async (input, init) => {
    calls++;
    assert.equal(String(input), "https://api.openai.com/v1/embeddings");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.dimensions, 3);
    assert.equal(body.encoding_format, "float");
    return new Response(
      JSON.stringify({
        object: "list",
        model: "fixture-model",
        data: [{ index: 0, embedding: [1, 0, 0] }],
        usage: { prompt_tokens: 4, total_tokens: 4 },
      }),
      { headers: { "content-type": "application/json" } },
    );
  });
  assert.deepEqual(await provider.embed(["text"], AbortSignal.timeout(1000)), {
    vectors: [[1, 0, 0]],
    inputTokens: 4,
  });
  assert.equal(calls, 1);
  const failing = createEmbeddingProvider(config, async () => {
    calls++;
    return new Response(
      JSON.stringify({ error: { message: "fixture unavailable" } }),
      { status: 503, headers: { "content-type": "application/json" } },
    );
  });
  await assert.rejects(failing.embed(["text"], AbortSignal.timeout(1000)));
  assert.equal(calls, 2);
  const wrong = createEmbeddingProvider(
    config,
    async () =>
      new Response(
        JSON.stringify({
          model: "other-model",
          data: [{ index: 0, embedding: [1, 0, 0] }],
          usage: { prompt_tokens: 4, total_tokens: 4 },
        }),
        { headers: { "content-type": "application/json" } },
      ),
  );
  await assert.rejects(
    wrong.embed(["text"], AbortSignal.timeout(1000)),
    /embedding_identity_or_usage_unknown/,
  );
});
