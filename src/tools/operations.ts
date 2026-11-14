import pg from "pg";
import { Store } from "../persistence/store.ts";
import { Operations, BudgetAlerts } from "../operations.ts";
import { AuditDispatcher } from "../audit/outbox.ts";
async function main() {
  const [command, id, confirmation, ...extra] = process.argv.slice(2);
  if (
    extra.length ||
    !["status", "audit-retry", "alert-ack"].includes(command ?? "")
  )
    throw new Error("invalid_command");
  if (!process.env.DATABASE_URL) throw new Error("missing_database");
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
    connectionTimeoutMillis: 2000,
    query_timeout: 5000,
    statement_timeout: 5000,
  });
  try {
    const store = new Store(pool, undefined, process.env.LINE_CHANNEL_ID ?? "");
    if (command === "status") {
      if (id || !store.channelId) throw new Error("invalid_status_arguments");
      process.stdout.write(
        JSON.stringify(await new Operations(store).snapshot()) + "\n",
      );
    } else if (command === "audit-retry") {
      if (!id || confirmation !== "retry-identical-fact")
        throw new Error("confirmation_required");
      await new AuditDispatcher(store, async () => {
        throw new Error("no_delivery_from_cli");
      }).retry(id);
    } else {
      if (!id || !confirmation) throw new Error("confirmation_required");
      await new BudgetAlerts(store, async () => {}).acknowledge(
        id,
        confirmation,
      );
    }
  } finally {
    await pool.end();
  }
}
main().catch(() => {
  process.stderr.write("operations_command_failed\n");
  process.exitCode = 1;
});
