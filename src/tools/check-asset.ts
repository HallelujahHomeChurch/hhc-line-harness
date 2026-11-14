import { queryLineUploadPolicy } from "../providers/asset-preflight.ts";

try {
  const result = await queryLineUploadPolicy(
    process.env.ASSET_API_ORIGIN ?? "",
    process.env.ASSET_WORKLOAD_TOKEN ?? "",
  );
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.status === "source_ready" ? 0 : 1;
} catch {
  process.stderr.write("asset_policy_unavailable\n");
  process.exitCode = 1;
}
