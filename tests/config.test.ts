import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/bootstrap/config.ts";

test("startup requires explicit credentials and valid port without leaking values", () => {
  const env = {
    DATABASE_URL: "postgres://fixture@localhost/line_harness",
    LINE_CHANNEL_SECRET: "synthetic",
  };
  assert.equal(loadConfig(env).port, 3000);
  for (const patch of [
    { DATABASE_URL: "" },
    { DATABASE_URL: "https://secret.invalid" },
    { LINE_CHANNEL_SECRET: "" },
    { PORT: "0" },
    { PORT: "3000junk" },
    { PORT: "65536" },
  ]) {
    assert.throws(
      () => loadConfig({ ...env, ...patch }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.doesNotMatch(error.message, /synthetic|secret.invalid|fixture/);
        return true;
      },
    );
  }
});

test("runtime is opt-in and worker config does not need reply or Account credentials", async () => {
  const { loadWorkerConfig } = await import("../src/bootstrap/config.ts");
  const env = {
    DATABASE_URL: "postgres://fixture@localhost/harness_test",
    LINE_CHANNEL_SECRET: "secret",
  };
  assert.equal(loadConfig(env).runtime, undefined);
  assert.throws(() => loadConfig({ ...env, HARNESS_ENABLED: "true" }));
  assert.throws(() => loadConfig({ ...env, HARNESS_ENABLED: "yes" }));
  const config = loadWorkerConfig({
    HARNESS_ENABLED: "true",
    DATABASE_URL: env.DATABASE_URL,
    LINE_CHANNEL_ID: "channel",
    LINE_DOWNLOAD_ACCESS_TOKEN: "download-token",
    ASSET_API_ORIGIN: "https://asset.invalid",
    ASSET_WORKLOAD_TOKEN: "asset-token",
    ASSET_UPLOAD_ORIGINS: "https://blob.invalid",
    HARNESS_QUEUE_URL: "https://fixture.queue.core.windows.net/harness",
    AZURE_CLIENT_ID: "11111111-1111-4111-8111-111111111111",
  });
  assert.equal(config.channelId, "channel");
  assert.equal("replyEncryptionKey" in config, false);
  assert.equal("accountToken" in config, false);
});

test("Audit delivery requires paired HTTPS config and a distinct private credential", () => {
  const env = {
    HARNESS_ENABLED: "true",
    DATABASE_URL: "postgres://fixture@localhost/harness_test",
    LINE_CHANNEL_SECRET: "synthetic",
    LINE_CHANNEL_ID: "channel",
    ASSET_API_ORIGIN: "https://asset.invalid",
    ASSET_WORKLOAD_TOKEN: "asset-token",
    HARNESS_QUEUE_URL: "https://fixture.queue.core.windows.net/harness",
    AZURE_CLIENT_ID: "11111111-1111-4111-8111-111111111111",
    LINE_BOT_ID: `U${"a".repeat(32)}`,
    LINE_HARNESS_PROFILE: "harness",
    LINE_API_ACCESS_TOKEN: "line",
    LINE_LOGIN_CHANNEL_ID: "login",
    REPLY_ENCRYPTION_KEY: "a".repeat(64),
    ASSET_SOURCE_GATE_TOKEN: "b".repeat(64),
    HARNESS_GATEWAY_PRIVATE_TOKEN: "c".repeat(64),
    ACCOUNT_API_ORIGIN: "https://account.invalid",
    ACCOUNT_HARNESS_PRIVATE_TOKEN: "d".repeat(64),
    ADMIN_ORIGIN: "https://admin.invalid",
  };
  assert.equal(loadConfig(env).runtime?.audit, undefined);
  assert.throws(() =>
    loadConfig({ ...env, AUDIT_API_ORIGIN: "https://audit.invalid" }),
  );
  assert.throws(() =>
    loadConfig({
      ...env,
      AUDIT_API_ORIGIN: "http://audit.invalid",
      AUDIT_HARNESS_TOKEN: "e".repeat(64),
    }),
  );
  assert.throws(() =>
    loadConfig({
      ...env,
      AUDIT_API_ORIGIN: "https://audit.invalid",
      AUDIT_HARNESS_TOKEN: env.ACCOUNT_HARNESS_PRIVATE_TOKEN,
    }),
  );
  assert.equal(
    loadConfig({
      ...env,
      AUDIT_API_ORIGIN: "https://audit.invalid",
      AUDIT_HARNESS_TOKEN: "e".repeat(64),
    }).runtime?.audit?.origin,
    "https://audit.invalid",
  );
});
