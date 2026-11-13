import assert from "node:assert/strict";
import { test } from "node:test";
import { database, databaseEnabled } from "./database.ts";
import { Store } from "../src/persistence/store.ts";
import { ReplyTokenCipher } from "../src/reply/token.ts";
import { SourceAccess } from "../src/domain/source-access.ts";
import { PublicationWorker } from "../src/worker/publication.ts";
import type { PublicationRecord } from "../src/worker/publication.ts";
const now = new Date("2026-11-12T12:00:00Z"),
  group = `C${"c".repeat(32)}`,
  collection = "cccccccccccccccccccccccccccccccc";
test(
  "staging and activation unknown outcomes recover through metadata without duplicate publication",
  { skip: !databaseEnabled },
  async (t) => {
    const pool = await database(t);
    await pool.query("UPDATE runtime_state SET mode='open',ingest_floor=$1", [
      now,
    ]);
    await pool.query(
      "INSERT INTO groups(channel_id,line_group_id,state,active_from,sharing_enabled,collection_id,acl_revision,binding_generation) VALUES('channel',$1,'active',$2,true,$3,1,1)",
      [group, now, collection],
    );
    let clock = now;
    const store = new Store(
      pool,
      new ReplyTokenCipher("a".repeat(64)),
      "channel",
      () => clock,
    );
    await store.ingest({
      id: "e",
      type: "message",
      scope: "group",
      scopeId: group,
      publishedAt: now,
      message: {
        id: "m",
        type: "file",
        fileName: "file.pdf",
        mentionsBot: false,
      },
    });
    await pool.query(
      "UPDATE sources SET state='ready',asset_id='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',asset_etag='etag'",
    );
    await pool.query(
      "INSERT INTO jobs(source_id,kind,runtime_generation,source_revision,created_at,available_at) SELECT id,'publish',1,revision,$1,$1 FROM sources",
      [now],
    );
    let remote: PublicationRecord | undefined;
    let stages = 0,
      activations = 0;
    const worker = new PublicationWorker(store, {
      lookup: async () => remote,
      stage: async (p, s) => {
        stages++;
        const input = {
          version: 1,
          mode: "stage",
          source: {
            version: 1,
            ref: s.id,
            revision: s.asset_source_revision,
            publishedAt: s.published_at.toISOString(),
            expiresAt: s.expires_at.toISOString(),
          },
          collectionId: p.collection_id,
          publicationRevision: p.id,
          aclRevision: Number(p.acl_revision),
          bindingGeneration: Number(p.binding_generation),
        };
        assert.equal(
          (await new SourceAccess(store).check(input)).state,
          "active",
        );
        assert.equal(
          (
            await new SourceAccess(store).check({
              ...input,
              mode: "activate",
              itemId: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
            })
          ).state,
          "revoked",
        );
        remote = {
          itemId: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
          collectionId: p.collection_id,
          assetId: s.asset_id!,
          revision: p.id,
          state: "staged",
        };
        throw new Error("stage response lost");
      },
      activate: async (p) => {
        activations++;
        assert.equal(
          (
            await pool.query("SELECT state FROM publications WHERE id=$1", [
              p.id,
            ])
          ).rows[0].state,
          "approved",
        );
        const s = (
          await pool.query("SELECT * FROM sources WHERE id=$1", [p.source_id])
        ).rows[0];
        const input = {
          version: 1,
          mode: "activate",
          source: {
            version: 1,
            ref: s.id,
            revision: s.asset_source_revision,
            publishedAt: s.published_at.toISOString(),
            expiresAt: s.expires_at.toISOString(),
          },
          collectionId: p.collection_id,
          itemId: p.item_id,
          publicationRevision: p.id,
          aclRevision: Number(p.acl_revision),
          bindingGeneration: Number(p.binding_generation),
        };
        assert.equal(
          (await new SourceAccess(store).check(input)).state,
          "active",
        );
        assert.equal(
          (
            await new SourceAccess(store).check({
              ...input,
              bindingGeneration: 2,
            })
          ).state,
          "revoked",
        );
        remote = { ...remote!, state: "active" };
        throw new Error("activation response lost");
      },
    });
    for (let i = 0; i < 3; i++) {
      await worker.processOne();
      clock = new Date(clock.getTime() + 60_000);
    }
    assert.equal(stages, 1);
    assert.equal(activations, 1);
    assert.equal(
      (await pool.query("SELECT state FROM publications")).rows[0].state,
      "active",
    );
    assert.equal(
      (await pool.query("SELECT state FROM jobs WHERE kind='publish'")).rows[0]
        .state,
      "completed",
    );
  },
);
