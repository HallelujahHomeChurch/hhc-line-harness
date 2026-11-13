import { readFile } from "node:fs/promises";
import { z } from "zod";
import pg from "pg";
import {
  loadEmbeddingConfig,
  createEmbeddingProvider,
} from "../providers/embeddings.ts";
import { EmbeddingIndex } from "../search/embeddings.ts";
import { Store } from "../persistence/store.ts";
async function main() {
  const [path] = process.argv.slice(2),
    config = loadEmbeddingConfig(process.env),
    channel = process.env.LINE_CHANNEL_ID;
  if (!path || !config || !channel || !process.env.DATABASE_URL)
    throw new Error("invalid_evaluation");
  const cases = z
    .array(
      z
        .object({
          groupId: z.string().uuid(),
          query: z.string().min(1).max(200),
          expectedIds: z.array(z.string().uuid()).min(1).max(5),
        })
        .strict(),
    )
    .min(30)
    .max(100)
    .parse(JSON.parse(await readFile(path, "utf8")));
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max: 3,
    statement_timeout: 5000,
    query_timeout: 5000,
  });
  try {
    const index = new EmbeddingIndex(
      new Store(pool, undefined, channel),
      createEmbeddingProvider(config),
    );
    await index.prepare();
    const report = await index.evaluate(cases);
    process.stdout.write(JSON.stringify(report) + "\n");
  } finally {
    await pool.end();
  }
}
main().catch(() => {
  process.stderr.write("embedding_evaluation_failed\n");
  process.exitCode = 1;
});
