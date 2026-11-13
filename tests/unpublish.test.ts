import assert from "node:assert/strict";
import { test } from "node:test";
import { database, databaseEnabled } from "./database.ts";
import { Store } from "../src/persistence/store.ts";
import { sweepExpired } from "../src/domain/lifecycle.ts";
import { UnpublishWorker } from "../src/worker/unpublish.ts";
const now = new Date("2026-11-12T12:00:00Z"),
  group = `C${"c".repeat(32)}`,
  collection = "22222222-2222-4222-8222-222222222222";
test(
  "changed destination reconciles unknown item metadata and removes only publication",
  { skip: !databaseEnabled },
  async (t) => {
    const pool = await database(t);
    await pool.query("UPDATE runtime_state SET mode='open',ingest_floor=$1", [
      now,
    ]);
    await pool.query(
      "INSERT INTO groups(channel_id,line_group_id,state,active_from,collection_id,acl_revision,binding_generation) VALUES('channel',$1,'active',$2,$3,1,1)",
      [group, now, collection],
    );
    const store = new Store(pool, undefined, "channel", () => now);
    await store.ingest({
      id: "e",
      type: "message",
      scope: "group",
      scopeId: group,
      publishedAt: now,
      message: { id: "m", type: "file", mentionsBot: false },
    });
    const s = (
      await pool.query(
        "UPDATE sources SET state='ready',asset_id='11111111-1111-4111-8111-111111111111',asset_etag='etag' RETURNING *",
      )
    ).rows[0];
    await pool.query(
      "INSERT INTO publications(source_id,collection_id,source_revision,group_revision,acl_revision,binding_generation,created_at) VALUES($1,$2,1,1,1,1,$3)",
      [s.id, collection, now],
    );
    await pool.query(
      "UPDATE groups SET collection_id=NULL,binding_generation=binding_generation+1",
    );
    await sweepExpired(store);
    assert.equal(
      (await pool.query("SELECT state FROM publications")).rows[0].state,
      "revoked",
    );
    let removed = 0;
    const worker = new UnpublishWorker(store, {
      lookup: async (p) => ({
        itemId: "33333333-3333-4333-8333-333333333333",
        collectionId: p.collection_id,
        assetId: s.asset_id,
        revision: p.id,
        state: "staged",
      }),
      remove: async (p) => {
        assert.equal(p.item_id, "33333333-3333-4333-8333-333333333333");
        removed++;
      },
    });
    await worker.processOne();
    assert.equal(removed, 1);
    assert.equal(
      (await pool.query("SELECT state FROM sources")).rows[0].state,
      "ready",
    );
    assert.ok(
      (await pool.query("SELECT removed_at FROM publications")).rows[0]
        .removed_at,
    );
  },
);

test(
  "stopping sharing keeps valid publications recoverable until destination changes",
  { skip: !databaseEnabled },
  async (t) => {
    const pool = await database(t);
    await pool.query("UPDATE runtime_state SET mode='open'");
    const g = (
      await pool.query(
        "INSERT INTO groups(channel_id,line_group_id,state,active_from,collection_id,sharing_enabled,acl_revision,binding_generation) VALUES('channel',$1,'active',$2,$3,false,1,1) RETURNING id",
        [group, now, collection],
      )
    ).rows[0];
    const s = (
      await pool.query(
        "INSERT INTO sources(group_id,message_id,kind,published_at,expires_at,state) VALUES($1,'m','file',$2,$3,'ready') RETURNING id",
        [g.id, now, new Date(now.getTime() + 90 * 86400000)],
      )
    ).rows[0];
    await pool.query(
      "INSERT INTO publications(source_id,collection_id,source_revision,group_revision,acl_revision,binding_generation,state,created_at) VALUES($1,$2,1,1,1,1,'active',$3)",
      [s.id, collection, now],
    );
    await sweepExpired(new Store(pool, undefined, "channel", () => now));
    assert.equal(
      (await pool.query("SELECT state FROM publications")).rows[0].state,
      "active",
    );
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int n FROM jobs WHERE kind='unpublish'",
        )
      ).rows[0].n,
      0,
    );
  },
);

for (const cause of ["unsend", "leave", "expired"] as const) {
  test(
    `unpublish survives ${cause} and repairs previously interrupted cleanup`,
    { skip: !databaseEnabled },
    async (t) => {
      for (const state of [
        "queued",
        "leased",
        "retry_wait",
        "held",
        "cancelled",
        "completed",
      ]) {
        const pool = await database(t);
        await pool.query("UPDATE runtime_state SET mode='open'");
        const g = (
          await pool.query(
            "INSERT INTO groups(channel_id,line_group_id,state,active_from) VALUES('channel',$1,'active',$2) RETURNING id",
            [group, now],
          )
        ).rows[0];
        const s = (
          await pool.query(
            "INSERT INTO sources(group_id,message_id,kind,published_at,expires_at,state,asset_id) VALUES($1,'m','file',$2,$3,'ready','asset-id') RETURNING id",
            [
              g.id,
              new Date(
                now.getTime() - (cause === "expired" ? 90 * 86400000 : 0),
              ),
              new Date(
                now.getTime() + (cause === "expired" ? 0 : 90 * 86400000),
              ),
            ],
          )
        ).rows[0];
        await pool.query(
          "INSERT INTO publications(source_id,collection_id,source_revision,group_revision,acl_revision,binding_generation,state,created_at) VALUES($1,$2,1,1,1,1,'revoked',$3)",
          [s.id, collection, now],
        );
        await pool.query(
          "INSERT INTO jobs(source_id,kind,state,runtime_generation,source_revision,created_at,available_at,lease_until) VALUES($1,'unpublish',$2,1,1,$3,$3,$4)",
          [s.id, state, now, new Date(now.getTime() - 1)],
        );
        const store = new Store(pool, undefined, "channel", () => now);
        if (cause !== "expired")
          await store.ingest({
            id: cause,
            scope: "group",
            scopeId: group,
            publishedAt: now,
            type: cause,
            ...(cause === "unsend" ? { unsentMessageId: "m" } : {}),
          });
        await sweepExpired(store);
        const worker = new UnpublishWorker(store, {
          lookup: async (p) => ({
            itemId: "item-id",
            collectionId: p.collection_id,
            assetId: "asset-id",
            revision: p.id,
            state: "deleted",
          }),
          remove: async () => assert.fail("already deleted"),
        });
        assert.equal(await worker.processOne(), true, state);
        assert.ok(
          (await pool.query("SELECT removed_at FROM publications")).rows[0]
            .removed_at,
          state,
        );
        if (cause !== "leave") {
          const { CleanupWorker } = await import("../src/worker/cleanup.ts");
          await new CleanupWorker(store, {
            lookup: async () => undefined,
            remove: async () => {},
          }).processOne();
          await pool.query("UPDATE groups SET state='deleting'");
          await sweepExpired(store);
          assert.equal(
            (await pool.query("SELECT state FROM groups")).rows[0].state,
            "deleted",
            state,
          );
        }
      }
    },
  );
}

test(
  "closed admission continues expiry cleanup while restoring freezes all effects",
  { skip: !databaseEnabled },
  async (t) => {
    const pool = await database(t);
    const g = (
      await pool.query(
        "INSERT INTO groups(channel_id,line_group_id,state,active_from) VALUES('channel',$1,'active',$2) RETURNING id",
        [group, now],
      )
    ).rows[0];
    const s = (
      await pool.query(
        "INSERT INTO sources(group_id,message_id,kind,published_at,expires_at,state,asset_id,body,description) VALUES($1,'m','file',$2,$3,'ready','asset-id','private','private') RETURNING id",
        [g.id, new Date(now.getTime() - 90 * 86400000), now],
      )
    ).rows[0];
    await pool.query(
      "INSERT INTO publications(source_id,collection_id,source_revision,group_revision,acl_revision,binding_generation,state,created_at) VALUES($1,$2,1,1,1,1,'active',$3)",
      [s.id, collection, now],
    );
    const store = new Store(pool, undefined, "channel", () => now);
    await sweepExpired(store);
    assert.deepEqual(
      (await pool.query("SELECT state,body,description FROM sources")).rows[0],
      { state: "expired", body: null, description: null },
    );
    const { CleanupWorker } = await import("../src/worker/cleanup.ts");
    let removed = 0;
    const cleanup = new CleanupWorker(store, {
      lookup: async () => undefined,
      remove: async () => {
        removed++;
      },
    });
    const unpublish = new UnpublishWorker(store, {
      lookup: async (p) => ({
        itemId: "item-id",
        collectionId: p.collection_id,
        assetId: "asset-id",
        revision: p.id,
        state: "deleted",
      }),
      remove: async () => {
        throw Error("already deleted");
      },
    });
    await pool.query("UPDATE runtime_state SET mode='restoring'");
    assert.equal(await cleanup.processOne(), false);
    assert.equal(await unpublish.processOne(), false);
    assert.equal(removed, 0);
    await pool.query("UPDATE runtime_state SET mode='closed'");
    assert.equal(await cleanup.processOne(), true);
    assert.equal(await unpublish.processOne(), true);
    assert.equal(removed, 1);
    assert.ok(
      (await pool.query("SELECT removed_at FROM publications")).rows[0]
        .removed_at,
    );
  },
);
