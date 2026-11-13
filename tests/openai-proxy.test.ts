import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { getGlobalDispatcher } from "undici";
import {
  createOpenAiTransport,
  readOpenAiProxyUrl,
} from "../src/providers/openai-proxy.ts";
import {
  createModelProviders,
  loadAgentConfig,
} from "../src/agent/providers.ts";
import {
  createEmbeddingProvider,
  loadEmbeddingConfig,
} from "../src/providers/embeddings.ts";
import { Agent, Runner } from "@openai/agents";

test("OpenAI relay accepts only a credential-free HTTP(S) origin", () => {
  assert.equal(readOpenAiProxyUrl(undefined), undefined);
  assert.equal(readOpenAiProxyUrl("  "), undefined);
  assert.equal(
    readOpenAiProxyUrl("http://relay.invalid:18443/"),
    "http://relay.invalid:18443",
  );
  for (const value of [
    "socks5://relay",
    "http://secret:credential@relay",
    "http://relay/path",
    "http://relay/?secret",
    "http://relay/#secret",
    "secret",
  ])
    assert.throws(() => readOpenAiProxyUrl(value), {
      message: "invalid_openai_proxy_origin",
    });
});

test("enabled provider configurations preserve the relay and reject invalid origins", () => {
  const rates = JSON.stringify({
    inputMicrosPerMillion: 1,
    outputMicrosPerMillion: 1,
    cachedInputMicrosPerMillion: 0,
    cacheWriteMicrosPerMillion: 1,
    cacheWriteLongMicrosPerMillion: 1,
  });
  const env = {
    AGENT_ENABLED: "true",
    OPENAI_API_KEY: "synthetic",
    OPENAI_MODEL: "fixture",
    OPENAI_PROXY_URL: "http://relay.invalid:18443/",
    AZURE_OPENAI_ENDPOINT: "https://fixture.openai.azure.com/openai/v1/",
    AZURE_OPENAI_DEPLOYMENT: "fixture",
    AZURE_CLIENT_ID: "fixture",
    OPENAI_TARIFF_JSON: rates,
    AZURE_OPENAI_TARIFF_JSON: rates,
    EMBEDDING_ENABLED: "true",
    EMBEDDING_PROVIDER: "openai",
    EMBEDDING_MODEL: "fixture",
    EMBEDDING_RESPONSE_MODEL: "fixture",
    EMBEDDING_VERSION: "fixture",
    EMBEDDING_DIMENSIONS: "3",
    EMBEDDING_INPUT_MICROS_PER_MILLION: "1",
  };
  assert.equal(
    loadAgentConfig(env)?.openaiProxyUrl,
    "http://relay.invalid:18443",
  );
  assert.equal(
    loadEmbeddingConfig(env)?.openaiProxyUrl,
    "http://relay.invalid:18443",
  );
  assert.throws(
    () => loadAgentConfig({ ...env, OPENAI_PROXY_URL: "http://relay/secret" }),
    /invalid_agent_config/,
  );
  assert.throws(
    () =>
      loadEmbeddingConfig({ ...env, OPENAI_PROXY_URL: "http://relay/secret" }),
    /invalid_embedding_config/,
  );
  assert.equal(
    loadEmbeddingConfig({
      ...env,
      EMBEDDING_PROVIDER: "azure",
      OPENAI_PROXY_URL: "invalid",
    })?.openaiProxyUrl,
    undefined,
  );
});

test("Responses and embeddings use the configured relay while Azure keeps its own transport", async () => {
  const server = createServer();
  let connects = 0;
  const direct: string[] = [];
  server.on("connect", (_req, socket) => {
    connects++;
    socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const openaiProxyUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const fetcher: typeof fetch = async (input) => {
    direct.push(String(input));
    return new Response(JSON.stringify({ error: { message: "fixture" } }), {
      status: 503,
    });
  };
  const price = {
    inputMicrosPerMillion: 1,
    outputMicrosPerMillion: 1,
    cachedInputMicrosPerMillion: 0,
    cacheWriteMicrosPerMillion: 1,
    cacheWriteLongMicrosPerMillion: 1,
  };
  const models = createModelProviders(
    {
      openaiKey: "synthetic",
      openaiModel: "fixture",
      openaiProxyUrl,
      azureEndpoint: "https://fixture.openai.azure.com/openai/v1/",
      azureDeployment: "fixture",
      identityClientId: "fixture",
      openaiPrice: price,
      azurePrice: price,
    },
    fetcher,
    async () => "synthetic",
  );
  const embedding = createEmbeddingProvider(
    {
      provider: "openai",
      model: "fixture",
      responseModel: "fixture",
      version: "fixture",
      dimensions: 3,
      inputMicrosPerMillion: 1,
      openaiKey: "synthetic",
      openaiProxyUrl,
    },
    fetcher,
  );
  try {
    const runner = new Runner({
      tracingDisabled: true,
      modelSettings: { store: false, retry: { maxRetries: 0 } },
    });
    await assert.rejects(
      runner.run(
        new Agent({ name: "fixture", model: models.openai.model }),
        "fixture",
      ),
    );
    await assert.rejects(
      embedding.embed(["fixture"], AbortSignal.timeout(2000)),
    );
    assert.equal(connects, 2);
    assert.deepEqual(direct, []);
    await assert.rejects(
      runner.run(
        new Agent({ name: "fixture", model: models.azure.model }),
        "fixture",
      ),
    );
    assert.deepEqual(direct, [
      "https://fixture.openai.azure.com/openai/v1/responses",
    ]);
    assert.equal(connects, 2);
  } finally {
    await models.close?.();
    await embedding.close?.();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("OpenAI uses its own CONNECT tunnel and never falls back to the direct client", async () => {
  const globalDispatcher = getGlobalDispatcher();
  const server = createServer((_req, res) => res.end("direct"));
  const destinations: string[] = [];
  let exposed = false,
    directCalls = 0;
  server.on("connect", (req, socket) => {
    destinations.push(req.url!);
    exposed ||= Boolean(req.headers.authorization);
    socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const transport = createOpenAiTransport(origin, async () => {
    directCalls++;
    return new Response("direct");
  });
  try {
    for (const url of [
      origin,
      "https://api.openai.com.evil.invalid/",
      "https://api.openai.com:444/",
      "https://secret@api.openai.com/",
      "https://fixture.openai.azure.com/openai/v1/",
    ])
      await assert.rejects(
        transport.fetch(url),
        /openai_proxy_destination_denied/,
      );
    assert.deepEqual(destinations, []);
    await assert.rejects(
      transport.fetch("https://api.openai.com/v1/responses", {
        headers: { authorization: "Bearer synthetic" },
        signal: AbortSignal.timeout(2000),
      }),
    );
    assert.deepEqual(destinations, ["api.openai.com:443"]);
    assert.equal(directCalls, 0);
    assert.equal(exposed, false);
    assert.equal(getGlobalDispatcher(), globalDispatcher);
    assert.equal(await (await fetch(origin)).text(), "direct");
    await transport.close();
    await assert.rejects(
      transport.fetch("https://api.openai.com/v1/responses"),
    );
  } finally {
    await transport.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
