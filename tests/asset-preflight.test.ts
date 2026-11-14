import assert from "node:assert/strict";
import { test } from "node:test";
import { queryLineUploadPolicy } from "../src/providers/asset-preflight.ts";

test("preflight uses only explicit workload credentials and the exact read-only contract", async () => {
  const result = await queryLineUploadPolicy(
    "https://asset.example",
    "synthetic-token",
    async (url, init) => {
      assert.equal(
        String(url),
        "https://asset.example/priv/assets/upload-policy",
      );
      assert.equal(init?.method, "POST");
      assert.equal(init?.redirect, "error");
      assert.deepEqual(init?.headers, {
        "content-type": "application/json",
        "x-hhc-workload-authorization": "Bearer synthetic-token",
      });
      assert.deepEqual(JSON.parse(String(init?.body)), {
        namespace: "line.group.media-sync",
        securityProfile: "line-source-unscanned-v1",
        processingProfile: "no-processing-v1",
      });
      return new Response(
        JSON.stringify({
          version: 1,
          namespace: "line.group.media-sync",
          securityProfile: "line-media-v1",
          processingProfile: "no-processing-v1",
          scanRequired: true,
          readinessVersion: 1,
          maxSizeBytes: 209715200,
          mimeTypes: ["image/jpeg"],
          visibilities: ["restricted"],
        }),
      );
    },
  );
  assert.deepEqual(result, { status: "scan_required" });
});

test("preflight rejects insecure destinations, failed responses and oversized metadata without fallback", async () => {
  for (const url of [
    "http://asset.example",
    "https://user:password@asset.example",
    "https://asset.example/other",
    "https://asset.example?token=secret",
  ]) {
    await assert.rejects(
      queryLineUploadPolicy(url, "synthetic-token", async () => {
        assert.fail("invalid destination must not be contacted");
      }),
    );
  }
  await assert.rejects(
    queryLineUploadPolicy("https://asset.example", "", async () => {
      assert.fail("credential required");
    }),
  );
  for (const response of [
    new Response("secret-upstream-details", { status: 403 }),
    new Response("{"),
    new Response("x".repeat(32769)),
  ]) {
    await assert.rejects(
      queryLineUploadPolicy(
        "https://asset.example",
        "synthetic-token",
        async () => response,
      ),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, "asset_policy_unavailable");
        return true;
      },
    );
  }
});
