import assert from "node:assert/strict";
import { test } from "node:test";
import { database, databaseEnabled } from "./database.ts";
import { migrate } from "../src/persistence/migrate.ts";
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
