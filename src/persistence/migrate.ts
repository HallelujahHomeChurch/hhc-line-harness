import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { Pool } from "pg";

class MigrationFailure extends Error {
  readonly step: number;
  readonly code: string;
  constructor(step: number, error: unknown) {
    super("migration_failed");
    this.step = step;
    this.code = migrationDiagnostic(error).code;
  }
}

export function migrationDiagnostic(error: unknown) {
  const code =
    error && typeof error === "object" && "code" in error
      ? error.code
      : undefined;
  return {
    event: "migration_failed",
    step: error instanceof MigrationFailure ? error.step : 0,
    code:
      typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? code : "unknown",
  };
}

export async function migrate(pool: Pool, directory = resolve("migrations")) {
  const files = (await readdir(directory))
    .filter((name) => /^\d{3}_[a-z0-9_]+\.sql$/.test(name))
    .sort();
  if (!files.length) throw new Error("migrations_missing");
  const client = await pool.connect();
  let discard = false;
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended(current_schema() || ':harness_migrations',0))",
    );
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, checksum text NOT NULL)",
    );
    const applied = new Map<string, string>(
      (
        await client.query(
          "SELECT name,checksum FROM schema_migrations ORDER BY name",
        )
      ).rows.map((row) => [row.name, row.checksum]),
    );
    if ([...applied.keys()].some((name, index) => files[index] !== name))
      throw new Error("migration_history_mismatch");
    for (const name of files) {
      const sql = await readFile(resolve(directory, name), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      if (applied.has(name)) {
        if (applied.get(name) !== checksum)
          throw new Error("migration_checksum_mismatch");
        continue;
      }
      try {
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)",
          [name, checksum],
        );
      } catch (error) {
        throw new MigrationFailure(Number(name.slice(0, 3)), error);
      }
    }
    await client.query("COMMIT");
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      discard = true;
    }
    throw error;
  } finally {
    client.release(discard);
  }
}
