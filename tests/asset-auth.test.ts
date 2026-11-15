import assert from "node:assert/strict";
import test from "node:test";
import { managedAssetToken } from "../src/providers/asset-auth.ts";
import { AssetClient } from "../src/providers/asset.ts";
import { AssetOriginalClient } from "../src/providers/asset-original.ts";
import { DependencyError } from "../src/providers/http.ts";
import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";

const clientId = "11111111-1111-4111-8111-111111111111";
const audience = "api://22222222-2222-4222-8222-222222222222";

test("an uncooperative identity request cannot overrun the deadline or send its late token", async () => {
  let calls = 0;
  let finish: (token: {
    token: string;
    expiresOnTimestamp: number;
  }) => void = () => {};
  const valid = { token: "fixture", expiresOnTimestamp: Date.now() + 60000 };
  const token = managedAssetToken(clientId, audience, {
    async getToken() {
      if (++calls === 1)
        return new Promise((resolve) => {
          finish = resolve;
        });
      return valid;
    },
  });
  let requests = 0;
  const api = new AssetClient("https://asset.invalid", token, async () => {
    requests++;
    return Response.json({});
  });
  const outcome = await Promise.race([
    api.http
      .json("/priv/assets/upload-policy", "POST", {}, { timeoutMs: 10 })
      .then(
        () => "sent",
        () => "rejected",
      ),
    new Promise((resolve) => setTimeout(() => resolve("still-pending"), 100)),
  ]);
  assert.equal(outcome, "rejected");
  finish(valid);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests, 0);
  await api.http.json("/priv/assets/upload-policy", "POST", {});
  assert.equal(requests, 1);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(token(controller.signal), DependencyError);
  assert.equal(calls, 2);
});

test("Asset metadata and protected content resolve the current identity token per request", async () => {
  let calls = 0;
  const signals: AbortSignal[] = [];
  const token = managedAssetToken(clientId, audience, {
    async getToken(scope, options) {
      assert.equal(scope, audience + "/.default");
      assert.ok(options?.abortSignal);
      signals.push(options.abortSignal as AbortSignal);
      return {
        token: `fixture-${++calls}`,
        expiresOnTimestamp: Date.now() + 60000,
      };
    },
  });
  const seen: string[] = [];
  const fetcher: typeof fetch = async (_url, init) => {
    assert.equal(init?.signal, signals.at(-1));
    seen.push(new Headers(init?.headers).get("X-HHC-Workload-Authorization")!);
    return Response.json({});
  };
  const api = new AssetClient("https://asset.invalid", token, fetcher);
  await api.http.json("/priv/assets/upload-policy", "POST", {});
  const content = new AssetOriginalClient(
    "https://asset.invalid",
    token,
    ["https://blob.invalid"],
    fetcher,
  );
  await (await content.content("asset-id", "HEAD", {})).body?.cancel();
  assert.deepEqual(seen, ["Bearer fixture-1", "Bearer fixture-2"]);
});

test("missing, expired or failed identity tokens stop before Asset receives a request", async () => {
  for (const result of [
    null,
    { token: "fixture", expiresOnTimestamp: 0 },
    { token: "fixture", expiresOnTimestamp: Number.NaN },
    { token: "bad token", expiresOnTimestamp: Date.now() + 60000 },
  ]) {
    let requests = 0;
    const token = managedAssetToken(clientId, audience, {
      async getToken() {
        return result;
      },
    });
    const api = new AssetClient("https://asset.invalid", token, async () => {
      requests++;
      return Response.json({});
    });
    await assert.rejects(
      api.http.json("/priv/assets/upload-policy", "POST", {}),
      DependencyError,
    );
    assert.equal(requests, 0);
  }
  const token = managedAssetToken(clientId, audience, {
    async getToken() {
      throw new Error("private-provider-detail");
    },
  });
  await assert.rejects(token(AbortSignal.timeout(1000)), (error: unknown) => {
    assert.ok(error instanceof DependencyError);
    assert.doesNotMatch(error.message, /private-provider-detail/);
    return true;
  });
});

test("identity and audience configuration cannot select developer credentials or another endpoint", () => {
  for (const [id, resource] of [
    ["", audience],
    [clientId, "https://untrusted.invalid"],
    [clientId, audience + "/.default"],
    [clientId, audience + "?scope=x"],
  ]) {
    assert.throws(() => managedAssetToken(id!, resource!));
  }
});

test("Blob upload never obtains or forwards the Asset workload token", async () => {
  let requests = 0;
  const original = new AssetOriginalClient(
    "https://asset.invalid",
    async () => {
      throw new Error("Asset identity must not be used for Blob upload");
    },
    ["https://blob.invalid"],
    async (url, init) => {
      assert.equal(new URL(String(url)).origin, "https://blob.invalid");
      assert.equal(
        new Headers(init?.headers).has("X-HHC-Workload-Authorization"),
        false,
      );
      await new Response(init?.body).arrayBuffer();
      requests++;
      return new Response(null, { status: 201 });
    },
  );
  const path = fileURLToPath(
    new URL("./fixtures/asset-wire.json", import.meta.url),
  );
  await original.put(
    {
      asset: {
        id: "asset",
        ref: "source",
        revision: "1",
        publishedAt: "",
        expiresAt: "",
        ready: false,
        etag: "",
        size: 0,
        checksum: "",
        mime: "",
      },
      target: {
        method: "PUT",
        url: "https://blob.invalid/object",
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        headers: { "content-type": "application/json" },
      },
    },
    {
      path,
      size: statSync(path).size,
      checksum: "",
      mime: "application/json",
      fileName: "fixture.json",
      dispose: async () => {},
    },
  );
  assert.equal(requests, 1);
});
