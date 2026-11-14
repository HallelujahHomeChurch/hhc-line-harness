import pg from "pg";
import {
  loadEmbeddingConfig,
  createEmbeddingProvider,
} from "./providers/embeddings.ts";
import { EmbeddingIndex } from "./search/embeddings.ts";
import { Store, requireRuntimeGeneration } from "./persistence/store.ts";
async function main() {
  const config = loadEmbeddingConfig(process.env),
    channel = process.env.LINE_CHANNEL_ID;
  if (!config || !channel || !process.env.DATABASE_URL)
    throw new Error("embedding_worker_disabled");
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max: 3,
    connectionTimeoutMillis: 2000,
    statement_timeout: 5000,
    query_timeout: 5000,
    application_name: "hhc-line-embedding-worker",
  });
  pool.on("error", () =>
    process.stderr.write("embedding_database_unavailable\n"),
  );
  let stopped = false;
  process.once("SIGTERM", () => {
    stopped = true;
  });
  process.once("SIGINT", () => {
    stopped = true;
  });
  const provider = createEmbeddingProvider(config);
  try {
    await requireRuntimeGeneration(
      pool,
      process.env.HARNESS_RUNTIME_GENERATION ?? "1",
    );
    const index = new EmbeddingIndex(
      new Store(pool, undefined, channel),
      provider,
    );
    await index.prepare();
    const deadline = Date.now() + 10 * 60000;
    for (let n = 0; n < 100 && !stopped && Date.now() < deadline; n++)
      if (!(await index.processOne())) break;
  } finally {
    await provider.close();
    await pool.end();
  }
}
main().catch(() => {
  process.stderr.write("embedding_worker_failed\n");
  process.exitCode = 1;
});
