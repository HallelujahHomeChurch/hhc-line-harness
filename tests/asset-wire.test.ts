import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { AssetClient } from "../src/providers/asset.ts";
import { AssetOriginalClient } from "../src/providers/asset-original.ts";
import { AssetPublicationClient } from "../src/providers/asset-publication.ts";
import { database, databaseEnabled } from "./database.ts";
const wire = JSON.parse(
  await readFile(
    new URL("./fixtures/asset-wire.json", import.meta.url),
    "utf8",
  ),
);
const assetId = "a".repeat(32),
  collectionId = "c".repeat(32),
  itemId = "e".repeat(32),
  aclId = "d".repeat(32);
test("actual Go-serialized Asset responses support create/lookup/readiness and collection/publication metadata", async () => {
  const original = new AssetOriginalClient("https://asset.invalid", "fixture", [
    "https://blob.invalid",
  ]);
  assert.equal(original.record(wire.created.asset).id, assetId);
  assert.equal(original.record(wire.lookup.asset).ready, false);
  assert.equal(original.record(wire.ready, true).ready, true);
  assert.throws(() =>
    original.record({ ...wire.ready, sourcePolicy: undefined }, true),
  );
  assert.equal(
    original.record(
      { ...wire.ready, safetyEvidence: { kind: "scanned" } },
      true,
    ).ready,
    false,
  );
  let response = wire.collections;
  const client = new AssetClient("https://asset.invalid", "fixture", async () =>
    Response.json(response),
  );
  assert.equal((await client.collections()).collections[0]!.id, collectionId);
  response = wire.collectionCreated;
  assert.equal(
    (
      await client.createCollection(
        "11111111-1111-4111-8111-111111111111",
        "Fixture",
        "33333333-3333-4333-8333-333333333333",
      )
    ).id,
    collectionId,
  );
  response = wire.collection;
  assert.equal((await client.collection(collectionId)).readers![0]!.id, aclId);
  const publications = new AssetPublicationClient(client.http);
  assert.equal(publications.record(wire.staged).itemId, itemId);
  assert.equal(publications.record(wire.active).state, "active");
});
test(
  "all persisted Asset identities keep their exact opaque representation through PostgreSQL and recovery",
  { skip: !databaseEnabled },
  async (t) => {
    const pool = await database(t),
      now = new Date("2026-11-13T00:00:00Z");
    const group = (
      await pool.query(
        "INSERT INTO groups(channel_id,line_group_id,collection_id) VALUES('channel','Cfixture',$1) RETURNING id,collection_id",
        [collectionId],
      )
    ).rows[0];
    assert.equal(group.collection_id, collectionId);
    const source = (
      await pool.query(
        "INSERT INTO sources(group_id,message_id,kind,state,published_at,expires_at,asset_id,publication_collection_id) VALUES($1,'m','file','queued',$2,$3,$4,$5) RETURNING id,asset_id,publication_collection_id",
        [
          group.id,
          now,
          new Date(now.getTime() + 90 * 86400000),
          assetId,
          collectionId,
        ],
      )
    ).rows[0];
    assert.equal(source.asset_id, assetId);
    assert.equal(source.publication_collection_id, collectionId);
    await pool.query(
      "INSERT INTO publications(source_id,collection_id,item_id,source_revision,group_revision,acl_revision,binding_generation,created_at) VALUES($1,$2,$3,1,1,1,1,$4)",
      [source.id, collectionId, itemId, now],
    );
    await pool.query(
      "INSERT INTO orphan_assets(asset_id,source_id,created_at) VALUES($1,$2,$3)",
      [assetId, source.id, now],
    );
    assert.equal(
      (await pool.query("SELECT item_id FROM publications")).rows[0].item_id,
      itemId,
    );
    assert.equal(
      (await pool.query("SELECT asset_id FROM orphan_assets")).rows[0].asset_id,
      assetId,
    );
    const { Recovery } = await import("../src/domain/recovery.ts");
    const { Store } = await import("../src/persistence/store.ts");
    const recovery = new Recovery(
      new Store(pool, undefined, "channel", () => now),
      "a".repeat(64),
    );
    const journal = await recovery.exportJournal();
    await recovery.restore(journal, now, "2");
    assert.equal(
      (await pool.query("SELECT collection_id FROM groups")).rows[0]
        .collection_id,
      collectionId,
    );
  },
);
