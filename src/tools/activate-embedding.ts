import { readFile } from "node:fs/promises";
import { z } from "zod";
import pg from "pg";
import { loadEmbeddingConfig } from "../providers/embeddings.ts";
import { EmbeddingIndex } from "../search/embeddings.ts";
import { Store } from "../persistence/store.ts";
async function main() {
  const [path, expected] = process.argv.slice(2),
    config = loadEmbeddingConfig(process.env),
    channel = process.env.LINE_CHANNEL_ID;
  if (
    !path ||
    expected === undefined ||
    !config ||
    !channel ||
    !process.env.DATABASE_URL
  )
    throw new Error("invalid_activation");
  const report = z
    .object({
      version: z.string(),
      provider: z.enum(["openai", "azure"]),
      model: z.string(),
      dimensions: z.number().int(),
      cases: z.number().int().min(30),
      top5: z.number().min(0.9).max(1),
      checksum: z.string().regex(/^[0-9a-f]{64}$/),
    })
    .strict()
    .parse(JSON.parse(await readFile(path, "utf8")));
  if (
    report.version !== config.version ||
    report.provider !== config.provider ||
    report.model !== config.model ||
    report.dimensions !== config.dimensions
  )
    throw new Error("invalid_activation");
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
  });
  try {
    const index = new EmbeddingIndex(new Store(pool, undefined, channel), {
      ...config,
      embed: async () => {
        throw new Error("activation_never_calls_model");
      },
    });
    await index.prepare();
    await index.activate(report, expected === "none" ? null : expected);
    process.stdout.write("embedding_version_activated\n");
  } finally {
    await pool.end();
  }
}
main().catch(() => {
  process.stderr.write("embedding_activation_failed\n");
  process.exitCode = 1;
});
