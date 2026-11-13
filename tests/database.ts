import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import pg from "pg";
import { migrate } from "../src/persistence/migrate.ts";

export const databaseEnabled = Boolean(process.env.TEST_DATABASE_URL);
if (process.env.REQUIRE_POSTGRES_TESTS === "true" && !databaseEnabled)
  throw new Error("TEST_DATABASE_URL is required");
export async function database(t: TestContext) {
  const url = new URL(process.env.TEST_DATABASE_URL ?? "");
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname));
  assert.ok(url.pathname.endsWith("_test"), "use a disposable test database");
  const admin = new pg.Pool({ connectionString: url.toString(), max: 1 });
  const schema = `test_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({
    connectionString: url.toString(),
    max: 5,
    options: `-c search_path=${schema},public`,
  });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });
  await migrate(pool);
  return pool;
}
