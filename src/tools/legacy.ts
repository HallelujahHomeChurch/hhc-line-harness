import pg from "pg";
import { readFile, stat, writeFile } from "node:fs/promises";
import { Store } from "../persistence/store.ts";
import {
  LegacyHandoff,
  retirementBlockers,
  legacySnapshot,
} from "../domain/legacy.ts";
async function input(path: string) {
  const info = await stat(path);
  if (!info.isFile() || info.size > 16 * 1024 * 1024)
    throw new Error("manifest_limit");
  return JSON.parse(await readFile(path, "utf8"));
}
async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!process.env.DATABASE_URL || !process.env.LINE_CHANNEL_ID)
    throw new Error("missing_legacy_config");
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
    connectionTimeoutMillis: 2000,
    statement_timeout: 30000,
  });
  try {
    const store = new Store(pool, undefined, process.env.LINE_CHANNEL_ID),
      handoff = new LegacyHandoff(store);
    if (
      command === "import" &&
      args.length === 2 &&
      args[1] === "reviewed-lifecycle-manifest"
    )
      await handoff.import(await input(args[0]!));
    else if (command === "status" && args.length === 1)
      await writeFile(
        args[0]!,
        JSON.stringify(await store.transaction((c) => legacySnapshot(c))),
        { flag: "wx", mode: 0o600 },
      );
    else if (
      command === "freeze" &&
      args.length === 3 &&
      args[2] === "all-legacy-writers-fenced"
    )
      await handoff.freeze(args[0]!, args[1]!);
    else if (
      command === "activate" &&
      args.length === 3 &&
      args[2] === "reviewed-consumer-and-owner-evidence"
    )
      await handoff.activate(args[0]!, await input(args[1]!));
    else if (command === "reconcile" && args.length === 3)
      await handoff.reconcile(args[0]!, Number(args[1]), await input(args[2]!));
    else if (
      command === "deny" &&
      args.length === 2 &&
      args[1] === "confirmed-source-denial"
    )
      await handoff.deny(args[0]!);
    else if (
      command === "ack-cleanup" &&
      args.length === 4 &&
      args[3] === "owner-verified-all-handles"
    )
      await handoff.acknowledge(args[0]!, args[1]!, args[2]!);
    else if (command === "retirement-check" && args.length === 1) {
      const blockers = await retirementBlockers(store, await input(args[0]!));
      process.stdout.write(JSON.stringify({ blockers }) + "\n");
      if (blockers.length) process.exitCode = 1;
    } else throw new Error("invalid_legacy_command");
  } finally {
    await pool.end();
  }
}
main().catch(() => {
  process.stderr.write("legacy_command_failed\n");
  process.exitCode = 1;
});
