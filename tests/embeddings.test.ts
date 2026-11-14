import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { database, databaseEnabled } from "./database.ts";
import { Store } from "../src/persistence/store.ts";
import { Budgets } from "../src/agent/budgets.ts";
import {
  EmbeddingIndex,
  chunks,
  type EmbeddingProvider,
} from "../src/search/embeddings.ts";
const config = {
  version: "fixture-v1",
  provider: "openai" as const,
  model: "fixture-embedding",
  dimensions: 3,
  inputMicrosPerMillion: 100000,
};
async function fixture(
  t: Parameters<typeof database>[0],
  embed?: EmbeddingProvider["embed"],
) {
  const pool = await database(t),
    now = new Date();
  await pool.query("UPDATE runtime_state SET mode='open'");
  const group = (
    await pool.query(
      "INSERT INTO groups(channel_id,line_group_id,state,active_from) VALUES('fixture',$1,'active',$2) RETURNING id",
      ["C" + "1".repeat(32), now],
    )
  ).rows[0].id;
  const store = new Store(pool, undefined, "fixture");
  let calls = 0;
  const provider = {
    ...config,
    embed: async (inputs: string[], signal: AbortSignal) => {
      calls++;
      return embed
        ? embed(inputs, signal)
        : {
            vectors: inputs.map((text) =>
              text.includes("敬拜") ? [1, 0, 0] : [0, 1, 0],
            ),
            inputTokens: inputs.reduce((n, s) => n + Buffer.byteLength(s), 0),
          };
    },
  };
  const index = new EmbeddingIndex(store, provider);
  const add = async (text: string, groupId = group) => {
    const id = (
      await pool.query(
        "INSERT INTO sources(group_id,message_id,kind,body,published_at,expires_at,state) VALUES($1,$2,'text',$3,$4,$4::timestamptz+interval '90 days','ready') RETURNING id",
        [groupId, randomUUID(), text, now],
      )
    ).rows[0].id;
    await pool.query(
      "INSERT INTO source_indexes(source_id,source_revision,runtime_generation,extractor_version,state,code,extracted_text,terms,indexed_at) VALUES($1,1,1,'fixture','ready','embedded_text',$2,'{}',$3)",
      [id, text, now],
    );
    return id;
  };
  return { pool, store, index, group, add, calls: () => calls };
}
test("embedding chunks preserve Unicode and enforce the byte bound", () => {
  const text = "敬拜😀a".repeat(2000),
    parts = chunks(text);
  assert.equal(parts.join(""), text);
  assert.ok(parts.every((s) => Buffer.byteLength(s) <= 2000));
  assert.ok(parts.every((s) => !s.includes("\ufffd")));
});
test(
  "a version becomes active only after complete backfill and reviewed evaluation; scoped search and revocation are immediate",
  { skip: !databaseEnabled },
  async (t) => {
    const f = await fixture(t);
    const source = await f.add("敬拜輪值");
    await f.index.prepare();
    await assert.rejects(
      f.index.activate({ cases: 30, top5: 1, checksum: "a".repeat(64) }, null),
      /embedding_backfill_incomplete/,
    );
    assert.equal(await f.index.processOne(), true);
    assert.equal(await f.index.processOne(), false);
    await assert.rejects(
      f.index.activate({ cases: 10, top5: 1, checksum: "a".repeat(64) }, null),
      /invalid_embedding_evaluation/,
    );
    const evaluation = await f.index.evaluate(
      Array.from({ length: 30 }, (_, i) => ({
        groupId: f.group,
        query: "敬拜 query " + i,
        expectedIds: [source],
      })),
    );
    await f.index.activate(evaluation, null);
    const run = randomUUID();
    await new Budgets(f.store).createRun({
      id: run,
      kind: "query",
      groupId: f.group,
      actorId: "U" + "2".repeat(32),
    });
    assert.deepEqual(await f.index.search(run, f.group, "敬拜"), [source]);
    await f.pool.query(
      "UPDATE sources SET state='revoked',revision=revision+1 WHERE id=$1",
      [source],
    );
    assert.deepEqual(await f.index.search(run, f.group, "敬拜"), []);
    assert.equal(
      (
        await f.pool.query(
          "SELECT count(*) n FROM model_calls WHERE purpose='embedding'",
        )
      ).rows[0].n,
      "33",
    );
  },
);
test(
  "unknown embedding usage is reserved; bad vectors cannot publish and a version never changes its model in place",
  { skip: !databaseEnabled },
  async (t) => {
    const f = await fixture(t, async () => ({
      vectors: [[1, 0]],
      inputTokens: 4,
    }));
    await f.add("敬拜輪值");
    await f.index.prepare();
    await f.index.processOne();
    assert.equal(
      (await f.pool.query("SELECT count(*) n FROM source_vectors")).rows[0].n,
      "0",
    );
    const changed = new EmbeddingIndex(f.store, {
      ...config,
      model: "other-model",
      embed: async () => {
        throw new Error("must not call");
      },
    });
    await assert.rejects(changed.prepare(), /embedding_version_conflict/);
    await assert.rejects(
      f.index.activate({ cases: 30, top5: 1, checksum: "a".repeat(64) }, null),
      /embedding_backfill_incomplete/,
    );
  },
);
test(
  "late embedding completion cannot resurrect a revoked source and unknown usage retains cost reservations",
  { skip: !databaseEnabled },
  async (t) => {
    let f: Awaited<ReturnType<typeof fixture>>, id: string;
    f = await fixture(t, async () => {
      const { invalidate } = await import("../src/domain/lifecycle.ts");
      await f.store.transaction((c) =>
        invalidate(c, id, f.store.now(), "revoked"),
      );
      return { vectors: [[1, 0, 0]], inputTokens: 4 };
    });
    id = await f.add("敬拜輪值");
    await f.index.prepare();
    await f.index.processOne();
    assert.equal(
      (await f.pool.query("SELECT count(*) n FROM source_vectors")).rows[0].n,
      "0",
    );
    assert.equal(
      (await f.pool.query("SELECT count(*) n FROM embedding_documents")).rows[0]
        .n,
      "0",
    );
    const other = await fixture(t, async () => ({
      vectors: [[1, 0, 0]],
      inputTokens: NaN,
    }));
    await other.add("敬拜輪值");
    await other.index.prepare();
    await other.index.processOne();
    const call = (
      await other.pool.query("SELECT state,reserved_micros FROM model_calls")
    ).rows[0];
    assert.equal(call.state, "unknown");
    assert.ok(BigInt(call.reserved_micros) > 0n);
  },
);
test(
  "semantic metadata filters apply before the candidate limit and cannot cross groups",
  { skip: !databaseEnabled },
  async (t) => {
    const f = await fixture(t),
      ids: string[] = [];
    for (let i = 0; i < 21; i++) ids.push(await f.add("敬拜 " + i));
    ids.sort();
    const target = ids.at(-1)!;
    await f.pool.query("UPDATE sources SET kind='file' WHERE id=$1", [target]);
    const foreign = (
      await f.pool.query(
        "INSERT INTO groups(channel_id,line_group_id,state,active_from) VALUES('fixture',$1,'active',now()) RETURNING id",
        ["C" + "3".repeat(32)],
      )
    ).rows[0].id;
    const other = await f.add("敬拜 foreign", foreign);
    await f.pool.query("UPDATE sources SET kind='file' WHERE id=$1", [other]);
    await f.index.prepare();
    while (await f.index.processOne()) {}
    const evaluation = await f.index.evaluate(
      Array.from({ length: 30 }, (_, i) => ({
        groupId: f.group,
        query: "敬拜 eval " + i,
        expectedIds: [ids[0]!],
      })),
    );
    await f.index.activate(evaluation, null);
    const run = randomUUID();
    await new Budgets(f.store).createRun({
      id: run,
      kind: "query",
      groupId: f.group,
      actorId: "U" + "2".repeat(32),
    });
    const unfiltered = await f.index.search(run, f.group, "敬拜");
    assert.equal(unfiltered.length, 20);
    assert.ok(!unfiltered.includes(target));
    assert.deepEqual(
      await f.index.search(run, f.group, "敬拜", { kind: "file" }),
      [target],
    );
  },
);
test(
  "30 distinct synthetic semantic cases verify exact pgvector retrieval before atomic activation",
  { skip: !databaseEnabled },
  async (t) => {
    const f = await fixture(t);
    f.index.provider.embed = async (text) => ({
      vectors: text.map((s) => {
        const n = Number(s.match(/\d+/)?.[0]);
        const angle = (n * 2 * Math.PI) / 31;
        return [Math.cos(angle), Math.sin(angle), 0];
      }),
      inputTokens: text.reduce((n, s) => n + Buffer.byteLength(s), 0),
    });
    const cases = [];
    for (let i = 0; i < 30; i++)
      cases.push({
        groupId: f.group,
        query: "semantic " + i,
        expectedIds: [await f.add("document " + i)],
      });
    await f.index.prepare();
    while (await f.index.processOne()) {}
    const report = await f.index.evaluate(cases);
    assert.equal(report.top5, 1);
    assert.equal(report.cases, 30);
    await assert.rejects(
      f.index.activate({ ...report, checksum: "f".repeat(64) }, null),
      /embedding_evaluation_required/,
    );
    await f.index.activate(report, null);
    t.diagnostic(
      "synthetic pgvector engine top-5 30/30; no real model quality claim",
    );
  },
);
