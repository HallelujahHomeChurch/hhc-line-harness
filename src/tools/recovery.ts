import pg from "pg";
import { readFile, writeFile, stat } from "node:fs/promises";
import { Store } from "../persistence/store.ts";
import { Recovery } from "../domain/recovery.ts";
async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!process.env.DATABASE_URL || !process.env.RESTORE_JOURNAL_KEY)
    throw new Error("missing_restore_config");
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
    connectionTimeoutMillis: 2000,
    statement_timeout: 30000,
    query_timeout: 35000,
  });
  try {
    const recovery = new Recovery(
      new Store(pool, undefined, process.env.LINE_CHANNEL_ID ?? ""),
      process.env.RESTORE_JOURNAL_KEY,
    );
    if (
      command === "quiesce" &&
      args.length === 1 &&
      args[0] === "stop-intake-and-reads"
    )
      await recovery.quiesce();
    else if (
      command === "journal" &&
      args.length === 2 &&
      args[1] === "all-writers-stopped"
    ) {
      const journal = await recovery.exportJournal();
      await writeFile(args[0]!, JSON.stringify(journal), {
        flag: "wx",
        mode: 0o600,
      });
    } else if (
      command === "restore" &&
      args.length === 4 &&
      args[3] === "reviewed-current-journal"
    ) {
      const info = await stat(args[0]!);
      if (!info.isFile() || info.size > 128 * 1024 * 1024)
        throw new Error("journal_limit");
      const journal = JSON.parse(await readFile(args[0]!, "utf8"));
      await recovery.restore(journal, new Date(args[2]!), args[1]!);
    } else if (
      command === "admit" &&
      args.length === 3 &&
      args[2] === "verified-policy-and-generation"
    )
      await recovery.admit(args[0]!, args[1]!);
    else throw new Error("invalid_recovery_command");
  } finally {
    await pool.end();
  }
}
main().catch(() => {
  process.stderr.write("recovery_command_failed\n");
  process.exitCode = 1;
});
