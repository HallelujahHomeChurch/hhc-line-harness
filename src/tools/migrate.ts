import pg from "pg";
import { migrate, migrationDiagnostic } from "../persistence/migrate.ts";
async function main() {
  if (!process.env.DATABASE_URL) throw new Error("database_url_required");
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
    connectionTimeoutMillis: 2000,
    statement_timeout: 30_000,
  });
  try {
    await migrate(pool);
  } finally {
    await pool.end();
  }
}
main().catch((error: unknown) => {
  process.stderr.write(JSON.stringify(migrationDiagnostic(error)) + "\n");
  process.exitCode = 1;
});
