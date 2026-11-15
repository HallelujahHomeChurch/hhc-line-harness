import { managedAssetToken } from "../providers/asset-auth.ts";
import { queryLineUploadPolicy } from "../providers/asset-preflight.ts";

try {
  const result = await queryLineUploadPolicy(
    process.env.ASSET_API_ORIGIN ?? "",
    managedAssetToken(
      process.env.AZURE_CLIENT_ID ?? "",
      process.env.ASSET_WORKLOAD_AUDIENCE ?? "",
    ),
  );
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.status === "source_ready" ? 0 : 1;
} catch {
  process.stderr.write("asset_policy_unavailable\n");
  process.exitCode = 1;
}
