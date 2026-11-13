import OpenAI from "openai";
import { OpenAIResponsesModel, setTracingDisabled } from "@openai/agents";
import {
  ManagedIdentityCredential,
  getBearerTokenProvider,
} from "@azure/identity";
import { z } from "zod";
import type { Price } from "./budgets.ts";
import type { ModelProviders } from "./model.ts";
import {
  createOpenAiTransport,
  readOpenAiProxyUrl,
} from "../providers/openai-proxy.ts";
setTracingDisabled(true);
const tariff = z
  .object({
    inputMicrosPerMillion: z.number().int().positive().safe(),
    outputMicrosPerMillion: z.number().int().positive().safe(),
    cachedInputMicrosPerMillion: z.number().int().nonnegative().safe(),
    cacheWriteMicrosPerMillion: z.number().int().positive().safe(),
    cacheWriteLongMicrosPerMillion: z.number().int().positive().safe(),
  })
  .strict();
export interface AgentConfig {
  openaiKey: string;
  openaiModel: string;
  openaiProxyUrl?: string;
  azureEndpoint: string;
  azureDeployment: string;
  identityClientId: string;
  openaiPrice: Price;
  azurePrice: Price;
}
export function loadAgentConfig(
  env: NodeJS.ProcessEnv,
): AgentConfig | undefined {
  if (![undefined, "false", "true"].includes(env.AGENT_ENABLED))
    throw new Error("invalid_agent_config");
  if (env.AGENT_ENABLED !== "true") return;
  const value = (key: string) => {
    const v = env[key]?.trim();
    if (!v) throw new Error("invalid_agent_config");
    return v;
  };
  try {
    const config = {
      openaiKey: value("OPENAI_API_KEY"),
      openaiModel: value("OPENAI_MODEL"),
      openaiProxyUrl: readOpenAiProxyUrl(env.OPENAI_PROXY_URL),
      azureEndpoint: value("AZURE_OPENAI_ENDPOINT"),
      azureDeployment: value("AZURE_OPENAI_DEPLOYMENT"),
      identityClientId: value("AZURE_CLIENT_ID"),
      openaiPrice: tariff.parse(JSON.parse(value("OPENAI_TARIFF_JSON"))),
      azurePrice: tariff.parse(JSON.parse(value("AZURE_OPENAI_TARIFF_JSON"))),
    };
    validate(config);
    return config;
  } catch {
    throw new Error("invalid_agent_config");
  }
}
function validate(config: AgentConfig) {
  readOpenAiProxyUrl(config.openaiProxyUrl);
  const url = new URL(config.azureEndpoint);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/openai/v1/" ||
    !/^[a-z0-9-]+\.(openai\.azure\.com|services\.ai\.azure\.com)$/.test(
      url.hostname,
    ) ||
    url.port
  )
    throw new Error("invalid_agent_endpoint");
  for (const model of [config.openaiModel, config.azureDeployment])
    if (!/^[A-Za-z0-9_.-]{1,128}$/.test(model))
      throw new Error("invalid_agent_model");
  tariff.parse(config.openaiPrice);
  tariff.parse(config.azurePrice);
}
export function createModelProviders(
  config: AgentConfig,
  fetcher: typeof fetch = fetch,
  azureToken?: () => Promise<string>,
): ModelProviders & { close(): Promise<void> } {
  validate(config);
  const token =
    azureToken ??
    getBearerTokenProvider(
      new ManagedIdentityCredential(config.identityClientId),
      "https://cognitiveservices.azure.com/.default",
    );
  const common = {
    maxRetries: 0,
    timeout: 40000,
    fetch: fetcher,
    logLevel: "off" as const,
  };
  const transport = createOpenAiTransport(config.openaiProxyUrl, fetcher);
  const primary = new OpenAI({
    ...common,
    apiKey: config.openaiKey,
    fetch: transport.fetch,
  });
  const secondary = new OpenAI({
    ...common,
    baseURL: config.azureEndpoint,
    apiKey: token,
  });
  return {
    close: transport.close,
    openai: {
      model: new OpenAIResponsesModel(primary, config.openaiModel),
      name: config.openaiModel,
      price: config.openaiPrice,
    },
    azure: {
      model: new OpenAIResponsesModel(secondary, config.azureDeployment),
      name: config.azureDeployment,
      price: config.azurePrice,
    },
  };
}
