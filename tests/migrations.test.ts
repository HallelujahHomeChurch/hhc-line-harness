import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, rm, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool } from "pg";
import { database, databaseEnabled } from "./database.ts";
import { migrate, migrationDiagnostic } from "../src/persistence/migrate.ts";
test("failed rollback preserves the migration error and discards the connection", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "harness-migration-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "001_fixture.sql"), "SELECT 1;");
  const releases: unknown[] = [];
  const pool = {
    connect: async () => ({
      query: async (sql: string) => {
        if (sql === "SELECT 1;")
          throw Object.assign(new Error("private-query"), { code: "57P01" });
        if (sql === "ROLLBACK") throw new Error("private-connection-detail");
        return { rows: [] };
      },
      release: (discard: boolean) => releases.push(discard),
    }),
  } as unknown as Pool;
  await assert.rejects(migrate(pool, directory), (error) => {
    assert.deepEqual(migrationDiagnostic(error), {
      event: "migration_failed",
      step: 1,
      code: "57P01",
    });
    return true;
  });
  assert.deepEqual(releases, [true]);
});
test("migration diagnostics contain only a bounded step and database code", () => {
  for (const error of [
    new Error("private-query-and-credential"),
    { code: "private-query-and-credential", message: "private-data" },
    { code: "42501\nprivate-data" },
    { code: "42501\n" },
    null,
  ]) {
    assert.deepEqual(migrationDiagnostic(error), {
      event: "migration_failed",
      step: 0,
      code: "unknown",
    });
  }
  assert.equal(
    migrationDiagnostic({ code: "42501", detail: "private-data" }).code,
    "42501",
  );
});
test(
  "a failed migration reports its step without SQL text and rolls back",
  { skip: !databaseEnabled },
  async (t) => {
    const pool = await database(t);
    const directory = await mkdtemp(join(tmpdir(), "harness-migration-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    await cp("migrations", directory, { recursive: true });
    await writeFile(
      join(directory, "030_fixture.sql"),
      "CREATE TABLE rollback_probe(id int); SELECT 1/0; -- private-query-and-credential",
    );
    await assert.rejects(migrate(pool, directory), (error) => {
      assert.deepEqual(migrationDiagnostic(error), {
        event: "migration_failed",
        step: 30,
        code: "22012",
      });
      assert.equal((error as Error).message, "migration_failed");
      return true;
    });
    assert.equal(
      (await pool.query("SELECT to_regclass('rollback_probe') AS table_name"))
        .rows[0].table_name,
      null,
    );
  },
);
test(
  "migration replay is idempotent and rejects drift or unknown history",
  { skip: !databaseEnabled },
  async (t) => {
    const pool = await database(t);
    await Promise.all([migrate(pool), migrate(pool)]);
    assert.equal(
      (await pool.query("SELECT mode FROM runtime_state")).rows[0].mode,
      "closed",
    );
    await pool.query(
      "UPDATE schema_migrations SET checksum='wrong' WHERE name='001_intake.sql'",
    );
    await assert.rejects(migrate(pool), /migration_checksum_mismatch/);
    await pool.query(
      "INSERT INTO schema_migrations(name,checksum) VALUES('000_unknown.sql','wrong')",
    );
    await assert.rejects(migrate(pool), /migration_history_mismatch/);
  },
);
