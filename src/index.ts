import { Retention } from "./domain/retention.ts";
import { Operations, BudgetAlerts } from "./operations.ts";
import pg from "pg";
import { createRuntime } from "./bootstrap/runtime.ts";
import { WakeQueue } from "./providers/queue.ts";
import { WakeDispatcher } from "./worker/wakes.ts";
import { sweepExpired } from "./domain/lifecycle.ts";
import { loadConfig } from "./bootstrap/config.ts";
import { createServer } from "./bootstrap/server.ts";

async function main() {
  const config = loadConfig(process.env);
  const pool = new pg.Pool({
    connectionString: config.databaseUrl,
    max: 8,
    connectionTimeoutMillis: 2000,
    query_timeout: 2000,
    statement_timeout: 2000,
    application_name: "hhc-line-harness",
  });
  pool.on("error", () => {
    process.stderr.write("database_connection_error\n");
  });
  const runtime = config.runtime
    ? createRuntime(pool, config.runtime)
    : undefined;
  if (runtime) {
    try {
      await runtime.initialize();
    } catch {
      await runtime.close();
      await pool.end();
      throw new Error("runtime_initialization_failed");
    }
  }
  const app = createServer({
    ...(runtime
      ? {
          management: runtime.management,
          intake: runtime.intake,
          sourceAccess: runtime.sourceAccess,
          content: runtime.content,
          searchAccess: runtime.searchAccess,
        }
      : {}),
    channelSecret: config.channelSecret,
    checkDatabase: async () => {
      if (runtime) {
        const row = (await pool.query("SELECT mode FROM runtime_state"))
          .rows[0];
        if (row?.mode !== "open") throw new Error("runtime_closed");
      } else await pool.query("SELECT 1");
    },
  });
  const timers: NodeJS.Timeout[] = [];
  const running = new Set<Promise<void>>();
  const repeat = (interval: number, operation: () => Promise<unknown>) => {
    let busy = false;
    timers.push(
      setInterval(() => {
        if (busy) return;
        busy = true;
        const work = operation()
          .then(
            () => {},
            () => {
              process.stderr.write("background_dependency_unavailable\n");
            },
          )
          .finally(() => {
            busy = false;
            running.delete(work);
          });
        running.add(work);
      }, interval),
    );
  };
  app.addHook("onReady", async () => {
    if (!runtime || !config.runtime) return;
    const queue = new WakeQueue(
      config.runtime.queueUrl,
      config.runtime.identityClientId,
    );
    const wakes = new WakeDispatcher(runtime.store, (id) => queue.send(id));
    if (runtime.audit)
      repeat(1000, async () => {
        for (let i = 0; i < 20 && (await runtime.audit!.processOne()); i++);
      });
    const operations = new Operations(runtime.store);
    const alerts = new BudgetAlerts(runtime.store, async (event) => {
      await new Promise<void>((resolve, reject) =>
        process.stdout.write(JSON.stringify(event) + "\n", (error) =>
          error ? reject(error) : resolve(),
        ),
      );
    });
    repeat(30_000, () => alerts.processOne());
    repeat(60_000, async () => {
      process.stdout.write(
        JSON.stringify({
          event: "line_harness_health",
          auditConfigured: Boolean(runtime.audit),
          ...(await operations.snapshot()),
        }) + "\n",
      );
    });
    repeat(100, () => runtime.interactions.processOne());
    repeat(250, () => runtime.conversations.processOne());
    if (runtime.adminQueries)
      repeat(250, () => runtime.adminQueries!.processOne());
    repeat(1000, async () => {
      for (let i = 0; i < 32 && (await wakes.processOne()); i++);
    });
    repeat(60_000, async () => {
      await sweepExpired(runtime.store);
      await new Retention(runtime.store).sweep();
    });
  });
  app.addHook("onClose", async () => {
    for (const timer of timers) clearInterval(timer);
    await Promise.allSettled([...running]);
    await runtime?.close();
    await pool.end();
  });
  const shutdown = () => {
    void app.close().catch(() => {
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  try {
    await app.listen({ host: config.host, port: config.port });
  } catch {
    await app.close();
    throw new Error("startup_failed");
  }
}

main().catch(() => {
  process.stderr.write("startup_failed\n");
  process.exitCode = 1;
});
