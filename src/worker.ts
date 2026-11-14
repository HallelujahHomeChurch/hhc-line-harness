import pg from "pg";
import { loadWorkerConfig } from "./bootstrap/config.ts";
import { createWorkers } from "./bootstrap/worker-runtime.ts";
import { WakeQueue, decodeWake } from "./providers/queue.ts";
async function main() {
  const config = loadWorkerConfig(process.env);
  const pool = new pg.Pool({
    connectionString: config.databaseUrl,
    max: 3,
    connectionTimeoutMillis: 2000,
    statement_timeout: 5000,
    query_timeout: 5000,
    application_name: "hhc-line-harness-worker",
  });
  pool.on("error", () => process.stderr.write("worker_database_unavailable\n"));
  let stopped = false;
  process.once("SIGTERM", () => {
    stopped = true;
  });
  process.once("SIGINT", () => {
    stopped = true;
  });
  try {
    const worker = createWorkers(pool, config);
    await worker.initialize();
    const queue = new WakeQueue(config.queueUrl, config.identityClientId);
    const deadline = Date.now() + 10 * 60_000;
    for (let i = 0; i < 100 && !stopped && Date.now() < deadline; i++) {
      const message = await queue.receive();
      if (!message) break;
      decodeWake(message.messageText);
      await worker.processOne();
      await queue.acknowledge(message.messageId, message.popReceipt);
    }
  } finally {
    await pool.end();
  }
}
main().catch(() => {
  process.stderr.write("worker_failed\n");
  process.exitCode = 1;
});
