import { assetHeaders, type AssetCredential } from "./asset-auth.ts";
import { inspectLineUploadPolicy } from "./asset-policy.ts";

export async function queryLineUploadPolicy(
  origin: string,
  token: AssetCredential,
  fetcher: typeof fetch = fetch,
) {
  try {
    const base = new URL(origin);
    if (
      base.protocol !== "https:" ||
      base.username ||
      base.password ||
      base.pathname !== "/" ||
      base.search ||
      base.hash
    )
      throw new Error();
    const signal = AbortSignal.timeout(2000);
    const authorization = await assetHeaders(token)(signal);
    const response = await fetcher(
      new URL("/priv/assets/upload-policy", base),
      {
        method: "POST",
        redirect: "error",
        signal,
        headers: {
          "content-type": "application/json",
          ...authorization,
        },
        body: JSON.stringify({
          namespace: "line.group.media-sync",
          securityProfile: "line-source-unscanned-v1",
          processingProfile: "no-processing-v1",
        }),
      },
    );
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error();
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 32768) throw new Error();
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
    return inspectLineUploadPolicy(
      JSON.parse(Buffer.concat(chunks).toString("utf8")),
    );
  } catch {
    throw new Error("asset_policy_unavailable");
  }
}
