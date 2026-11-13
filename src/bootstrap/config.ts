import { AuditClient } from "../audit/outbox.ts";
import { loadEmbeddingConfig } from "../providers/embeddings.ts";
import { loadAgentConfig } from "../agent/providers.ts";
import type { RuntimeConfig } from "./runtime.ts";
export interface WorkerConfig {
  runtimeGeneration?: string;
  databaseUrl: string;
  channelId: string;
  lineDownloadToken: string;
  assetOrigin: string;
  assetToken: string;
  uploadOrigins: string[];
  queueUrl: string;
  identityClientId: string;
}
function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`${key} is required`);
  return value;
}
function databaseUrl(env: NodeJS.ProcessEnv): string {
  let url: URL;
  try {
    url = new URL(env.DATABASE_URL ?? "");
  } catch {
    throw new Error("Invalid DATABASE_URL");
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !url.hostname ||
    url.pathname.length <= 1
  )
    throw new Error("Invalid DATABASE_URL");
  return url.toString();
}
function enabled(env: NodeJS.ProcessEnv): boolean {
  if (![undefined, "false", "true"].includes(env.HARNESS_ENABLED))
    throw new Error("Invalid HARNESS_ENABLED");
  return env.HARNESS_ENABLED === "true";
}
function shared(env: NodeJS.ProcessEnv) {
  return {
    runtimeGeneration: env.HARNESS_RUNTIME_GENERATION ?? "1",
    channelId: required(env, "LINE_CHANNEL_ID"),
    assetOrigin: required(env, "ASSET_API_ORIGIN"),
    assetToken: required(env, "ASSET_WORKLOAD_TOKEN"),
    queueUrl: required(env, "HARNESS_QUEUE_URL"),
    identityClientId: required(env, "AZURE_CLIENT_ID"),
  };
}
export function loadWorkerConfig(env: NodeJS.ProcessEnv): WorkerConfig {
  if (!enabled(env)) throw new Error("worker_disabled");
  return {
    databaseUrl: databaseUrl(env),
    ...shared(env),
    lineDownloadToken: required(env, "LINE_DOWNLOAD_ACCESS_TOKEN"),
    uploadOrigins: required(env, "ASSET_UPLOAD_ORIGINS")
      .split(",")
      .map((s) => s.trim()),
  };
}
export function loadConfig(env: NodeJS.ProcessEnv) {
  const rawPort = env.PORT ?? "3000",
    port = Number(rawPort),
    host = env.HOST ?? "127.0.0.1";
  if (!/^\d+$/.test(rawPort) || port < 1 || port > 65535)
    throw new Error("Invalid PORT");
  if (!["127.0.0.1", "0.0.0.0"].includes(host)) throw new Error("Invalid HOST");
  let runtime: RuntimeConfig | undefined;
  if (enabled(env)) {
    runtime = {
      ...shared(env),
      agent: loadAgentConfig(env),
      embeddings: loadEmbeddingConfig(env),
      botId: required(env, "LINE_BOT_ID"),
      lineProfile: required(env, "LINE_HARNESS_PROFILE"),
      lineAccessToken: required(env, "LINE_API_ACCESS_TOKEN"),
      lineLoginChannelId: required(env, "LINE_LOGIN_CHANNEL_ID"),
      ...(env.LINE_LIFF_ID ? { liffId: env.LINE_LIFF_ID } : {}),
      replyEncryptionKey: required(env, "REPLY_ENCRYPTION_KEY"),
      sourceAccessToken: required(env, "ASSET_SOURCE_GATE_TOKEN"),
      gatewayToken: required(env, "HARNESS_GATEWAY_PRIVATE_TOKEN"),
      accountOrigin: required(env, "ACCOUNT_API_ORIGIN"),
      accountToken: required(env, "ACCOUNT_HARNESS_PRIVATE_TOKEN"),
      adminOrigin: required(env, "ADMIN_ORIGIN"),
    };
    if (env.AUDIT_API_ORIGIN || env.AUDIT_HARNESS_TOKEN) {
      runtime.audit = {
        origin: required(env, "AUDIT_API_ORIGIN"),
        token: required(env, "AUDIT_HARNESS_TOKEN"),
      };
      new AuditClient(runtime.audit.origin, runtime.audit.token);
    }
    const secrets = [
      ...(runtime.audit ? [runtime.audit.token] : []),
      runtime.replyEncryptionKey,
      runtime.sourceAccessToken,
      runtime.accountToken,
      runtime.gatewayToken,
    ];
    if (
      secrets.some((s) => !/[0-9a-f]{64}/.test(s) || s.length !== 64) ||
      new Set(secrets).size !== secrets.length
    )
      throw new Error("invalid_private_credentials");
  }
  return {
    port,
    host,
    databaseUrl: databaseUrl(env),
    channelSecret: required(env, "LINE_CHANNEL_SECRET"),
    runtime,
  };
}
