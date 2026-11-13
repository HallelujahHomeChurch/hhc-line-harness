import OpenAI from "openai";
import {
  ManagedIdentityCredential,
  getBearerTokenProvider,
} from "@azure/identity";
import type { EmbeddingProvider } from "../search/embeddings.ts";
export interface EmbeddingConfig extends Omit<EmbeddingProvider, "embed"> {
  responseModel: string;
  openaiKey?: string;
  azureEndpoint?: string;
  identityClientId?: string;
}
export function loadEmbeddingConfig(
  env: NodeJS.ProcessEnv,
): EmbeddingConfig | undefined {
  if (![undefined, "true", "false"].includes(env.EMBEDDING_ENABLED))
    throw new Error("invalid_embedding_config");
  if (env.EMBEDDING_ENABLED !== "true") return;
  const required = (key: string) => {
    const value = env[key]?.trim();
    if (!value) throw new Error("invalid_embedding_config");
    return value;
  };
  try {
    const provider = required("EMBEDDING_PROVIDER");
    if (provider !== "openai" && provider !== "azure") throw new Error();
    const config: EmbeddingConfig = {
      provider,
      model: required("EMBEDDING_MODEL"),
      responseModel: required("EMBEDDING_RESPONSE_MODEL"),
      version: required("EMBEDDING_VERSION"),
      dimensions: Number(required("EMBEDDING_DIMENSIONS")),
      inputMicrosPerMillion: Number(
        required("EMBEDDING_INPUT_MICROS_PER_MILLION"),
      ),
      ...(provider === "openai"
        ? { openaiKey: required("OPENAI_API_KEY") }
        : {
            azureEndpoint: required("AZURE_OPENAI_ENDPOINT"),
            identityClientId: required("AZURE_CLIENT_ID"),
          }),
    };
    validate(config);
    return config;
  } catch {
    throw new Error("invalid_embedding_config");
  }
}
function validate(config: EmbeddingConfig) {
  for (const s of [config.model, config.responseModel, config.version])
    if (!/^[A-Za-z0-9_.-]{1,100}$/.test(s))
      throw new Error("invalid_embedding_config");
  if (
    !Number.isSafeInteger(config.dimensions) ||
    config.dimensions < 1 ||
    config.dimensions > 2000 ||
    !Number.isSafeInteger(config.inputMicrosPerMillion) ||
    config.inputMicrosPerMillion <= 0
  )
    throw new Error("invalid_embedding_config");
  if (config.provider === "openai") {
    if (!config.openaiKey) throw new Error("invalid_embedding_config");
  } else if (config.provider === "azure") {
    const url = new URL(config.azureEndpoint ?? "");
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.port ||
      url.pathname !== "/openai/v1/" ||
      !/^[a-z0-9-]+\.(openai\.azure\.com|services\.ai\.azure\.com)$/.test(
        url.hostname,
      ) ||
      !config.identityClientId
    )
      throw new Error("invalid_embedding_config");
  } else throw new Error("invalid_embedding_config");
}
export function createEmbeddingProvider(
  config: EmbeddingConfig,
  fetcher: typeof fetch = fetch,
  azureToken?: () => Promise<string>,
): EmbeddingProvider {
  validate(config);
  const client = new OpenAI({
    apiKey:
      config.provider === "openai"
        ? config.openaiKey!
        : (azureToken ??
          getBearerTokenProvider(
            new ManagedIdentityCredential(config.identityClientId!),
            "https://cognitiveservices.azure.com/.default",
          )),
    ...(config.provider === "azure" ? { baseURL: config.azureEndpoint } : {}),
    maxRetries: 0,
    timeout: 40000,
    logLevel: "off",
    fetch: fetcher,
  });
  return {
    version: config.version,
    provider: config.provider,
    model: config.model,
    responseModel: config.responseModel,
    dimensions: config.dimensions,
    inputMicrosPerMillion: config.inputMicrosPerMillion,
    embed: async (text, signal) => {
      const result = await client.embeddings.create(
        {
          model: config.model,
          input: text,
          dimensions: config.dimensions,
          encoding_format: "float",
        },
        { signal },
      );
      if (
        result.model !== config.responseModel ||
        !result.usage ||
        !Number.isSafeInteger(result.usage.prompt_tokens) ||
        result.usage.prompt_tokens < 0 ||
        result.usage.total_tokens !== result.usage.prompt_tokens
      )
        throw new Error("embedding_identity_or_usage_unknown");
      if (
        !Array.isArray(result.data) ||
        result.data.length !== text.length ||
        new Set(result.data.map((r) => r.index)).size !== text.length ||
        result.data.some(
          (r) =>
            !Number.isInteger(r.index) || r.index < 0 || r.index >= text.length,
        )
      )
        throw new Error("invalid_embedding_response");
      return {
        vectors: [...result.data]
          .sort((a, b) => a.index - b.index)
          .map((r) => r.embedding),
        inputTokens: result.usage.prompt_tokens,
      };
    },
  };
}
