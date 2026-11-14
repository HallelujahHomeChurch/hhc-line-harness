import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { database, databaseEnabled } from "./database.ts";
import { Store } from "../src/persistence/store.ts";
import { IndexWorker } from "../src/worker/indexer.ts";
import { Search } from "../src/search/search.ts";
import { invalidate } from "../src/domain/lifecycle.ts";
const actor = "U" + "1".repeat(32);
const now = new Date("2026-11-13T00:00:00Z");
async function fixture(t: Parameters<typeof database>[0]) {
  const pool = await database(t);
  await pool.query("UPDATE runtime_state SET mode='open',ingest_floor=$1", [
    now,
  ]);
  const group = (
    await pool.query(
      "INSERT INTO groups(channel_id,line_group_id,state,active_from) VALUES('test',$1,'active',$2) RETURNING id",
      ["C" + "2".repeat(32), now],
    )
  ).rows[0].id;
  const store = new Store(pool, undefined, "test", () => now);
  const add = async (text: string, name?: string) => {
    const source = (
      await pool.query(
        "INSERT INTO sources(group_id,message_id,author_id,kind,body,file_name,published_at,expires_at,state) VALUES($1,$2,$3,'text',$4,$5,$6,$6::timestamptz+interval '2160 hours','ready') RETURNING id",
        [group, randomUUID(), actor, text, name ?? null, now],
      )
    ).rows[0].id;
    await pool.query(
      "INSERT INTO jobs(source_id,kind,runtime_generation,source_revision,created_at,available_at) VALUES($1,'index',1,1,$2,$2)",
      [source, now],
    );
    return source;
  };
  const indexer = new IndexWorker(store, async () => {
    throw new Error("unexpected_content_fetch");
  });
  return { pool, store, group, add, indexer };
}
test(
  "30-case Chinese/English retrieval reaches top five without inferred versions",
  { skip: !databaseEnabled },
  async (t) => {
    const f = await fixture(t);
    const corpus = [
      "敬拜團輪值",
      "兒童主日學教材",
      "停車場引導",
      "聖誕節詩歌",
      "復活節受洗",
      "教會午餐菜單",
      "青年營交通",
      "長青團契聚會",
      "小組查經進度",
      "財務報帳規範",
      "直播設備清單",
      "音控操作手冊",
      "投影歌詞排版",
      "場地借用申請",
      "門訓課程時間",
      "宣教禱告事項",
      "招待同工排班",
      "福音茶會海報",
      "洗禮見證分享",
      "探訪關懷名單",
      "婚禮攝影流程",
      "音樂教室使用",
      "聖經閱讀計畫",
      "新朋友歡迎卡",
      "清潔服務輪值",
      "兒童安全指引",
      "volunteer schedule",
      "camera calibration",
      "network maintenance",
      "worship rehearsal",
    ];
    const expected: string[] = [];
    for (const text of corpus)
      expected.push(await f.add(text + " synthetic fixture", text));
    while (await f.indexer.processOne()) {}
    const search = new Search(f.store, async () => true);
    let hits = 0;
    for (let i = 0; i < corpus.length; i++) {
      const result = await search.query(f.group, actor, { query: corpus[i]! });
      if (result.items.some((x) => x.id === expected[i])) hits++;
      assert.ok(result.items.every((x) => x.versions.length === 0));
    }
    assert.ok(hits / corpus.length >= 0.9, `${hits}/30`);
    t.diagnostic(`retrieval top-5 ${hits}/30`);
  },
);
test(
  "pending extraction is not not-found; revoked content and foreign members are denied",
  { skip: !databaseEnabled },
  async (t) => {
    const f = await fixture(t),
      id = await f.add("同工排班");
    const search = new Search(f.store, async () => true);
    assert.equal(
      (await search.query(f.group, actor, { query: "不存在" })).status,
      "pending_index",
    );
    await f.indexer.processOne();
    assert.equal(
      (await search.query(f.group, actor, { query: "不存在" })).status,
      "not_found",
    );
    await assert.rejects(
      new Search(f.store, async () => false).query(f.group, actor, {
        query: "同工",
      }),
      /forbidden/,
    );
    await f.store.transaction((c) => invalidate(c, id, now, "revoked"));
    assert.equal(
      (await search.query(f.group, actor, { query: "同工" })).items.length,
      0,
    );
    assert.equal(
      (await f.pool.query("SELECT * FROM source_indexes")).rowCount,
      0,
    );
  },
);
test(
  "membership/source changes during query fail closed and pause never produces empty success",
  { skip: !databaseEnabled },
  async (t) => {
    const f = await fixture(t),
      id = await f.add("schedule");
    await f.indexer.processOne();
    let calls = 0;
    const search = new Search(f.store, async () => {
      if (++calls === 2)
        await f.store.transaction((c) => invalidate(c, id, now, "revoked"));
      return true;
    });
    await assert.rejects(
      search.query(f.group, actor, { query: "schedule" }),
      /unavailable/,
    );
    await f.pool.query("UPDATE groups SET state='paused' WHERE id=$1", [
      f.group,
    ]);
    await assert.rejects(
      search.query(f.group, actor, { query: "schedule" }),
      /paused/,
    );
  },
);
test(
  "late indexing cannot resurrect a source revoked while its bytes are read",
  { skip: !databaseEnabled },
  async (t) => {
    const f = await fixture(t),
      id = await f.add("pdf");
    await f.pool.query(
      "UPDATE sources SET kind='file',mime_type='application/pdf',asset_id=$2,asset_etag='etag' WHERE id=$1",
      [id, randomUUID()],
    );
    const worker = new IndexWorker(f.store, async () => {
      await f.store.transaction((c) => invalidate(c, id, now, "revoked"));
      return new Response("pdf", {
        headers: { etag: "etag", "content-type": "application/pdf" },
      });
    });
    assert.equal(await worker.processOne(), true);
    assert.equal(
      (await f.pool.query("SELECT * FROM source_indexes")).rowCount,
      0,
    );
  },
);

test(
  "failed indexing is reported as unavailable rather than a negative search result",
  { skip: !databaseEnabled },
  async (t) => {
    const f = await fixture(t);
    const id = await f.add("synthetic");
    await f.pool.query(
      "UPDATE jobs SET state='failed' WHERE source_id=$1 AND kind='index'",
      [id],
    );
    const search = new Search(f.store, async () => true);
    assert.equal(
      (await search.query(f.group, actor, { query: "missing" })).status,
      "unavailable",
    );
    const metadata = await search.query(f.group, actor, { query: "synthetic" });
    assert.equal(metadata.items[0]?.indexState, "failed");
  },
);

test(
  "version evidence stays group-scoped and expires without deleting either original",
  { skip: !databaseEnabled },
  async (t) => {
    const f = await fixture(t),
      old = await f.add("old timetable", "schedule-old.pdf"),
      next = await f.add("new timetable", "schedule-new.pdf"),
      evidence = await f.add("新排班取代舊排班，請以新檔為準");
    while (await f.indexer.processOne()) {}
    await f.pool.query(
      "INSERT INTO source_relations(source_id,related_source_id,evidence_source_id,kind,confidence,status) VALUES($1,$2,$3,'version',1,'confirmed')",
      [next, old, evidence],
    );
    const search = new Search(f.store, async () => true),
      result = await search.query(f.group, actor, { query: "new timetable" });
    assert.equal(result.items.find((i) => i.id === next)?.versions[0]?.id, old);
    assert.match(
      result.items.find((i) => i.id === next)!.versions[0]!.evidence,
      /新排班/,
    );
    await f.store.transaction((c) => invalidate(c, evidence, now, "revoked"));
    assert.equal(
      (
        await search.query(f.group, actor, { query: "new timetable" })
      ).items.find((i) => i.id === next)?.versions.length,
      0,
    );
    assert.equal(
      (
        await f.pool.query(
          "SELECT count(*) AS n FROM sources WHERE id=ANY($1::uuid[]) AND state='ready'",
          [[old, next]],
        )
      ).rows[0].n,
      "2",
    );
  },
);
