import { Search, type SearchInput } from "./search.ts";
import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { Store } from "../persistence/store.ts";
import { Budgets, type Provider } from "../agent/budgets.ts";
export interface EmbeddingProvider {
  version: string;
  provider: Provider;
  model: string;
  responseModel?: string;
  dimensions: number;
  inputMicrosPerMillion: number;
  embed: (
    text: string[],
    signal: AbortSignal,
  ) => Promise<{ vectors: number[][]; inputTokens: number }>;
}
const CHUNKER = "utf8-2000-v1";
export function chunks(text: string): string[] {
  const result: string[] = [];
  let part = "",
    size = 0;
  for (const char of text) {
    const bytes = Buffer.byteLength(char);
    if (size + bytes > 2000) {
      result.push(part);
      part = "";
      size = 0;
    }
    part += char;
    size += bytes;
  }
  if (part) result.push(part);
  return result;
}
const eligible = `SELECT s.id AS source_id,s.group_id,s.revision AS source_revision,s.description_revision,r.generation AS runtime_generation,
 concat_ws(E'\\n',s.file_name,s.description,i.extracted_text) AS text,
 encode(sha256(convert_to(concat_ws(E'\\n',s.file_name,s.description,i.extracted_text),'UTF8')),'hex') AS text_hash
 FROM sources s JOIN groups g ON g.id=s.group_id JOIN source_indexes i ON i.source_id=s.id CROSS JOIN runtime_state r
 WHERE g.channel_id=$1 AND g.state='active' AND r.mode='open' AND s.state='ready' AND s.expires_at>$2
 AND i.source_revision=s.revision AND i.runtime_generation=r.generation AND i.state<>'failed'
 AND length(trim(concat_ws(E'\\n',s.file_name,s.description,i.extracted_text)))>0`;
interface Document {
  source_id: string;
  group_id: string;
  source_revision: string;
  description_revision: string;
  runtime_generation: string;
  text_hash: string;
  text: string;
  next_chunk: number;
  fence: string;
  lease_until: Date;
  state: string;
}
export class EmbeddingIndex {
  readonly store: Store;
  readonly provider: EmbeddingProvider;
  readonly budgets: Budgets;
  constructor(store: Store, provider: EmbeddingProvider) {
    if (
      !/^[a-zA-Z0-9_.-]{1,100}$/.test(provider.version) ||
      !provider.model ||
      provider.model.length > 128 ||
      !Number.isInteger(provider.dimensions) ||
      provider.dimensions < 1 ||
      provider.dimensions > 2000 ||
      !Number.isSafeInteger(provider.inputMicrosPerMillion) ||
      provider.inputMicrosPerMillion <= 0
    )
      throw new Error("invalid_embedding_config");
    this.store = store;
    this.provider = provider;
    this.budgets = new Budgets(store);
  }
  async prepare() {
    const p = this.provider;
    await this.store.transaction(async (c) => {
      await c.query(
        "INSERT INTO embedding_versions(id,channel_id,provider,model,dimensions,chunker,created_at,response_model) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING",
        [
          p.version,
          this.store.channelId,
          p.provider,
          p.model,
          p.dimensions,
          CHUNKER,
          this.store.now(),
          p.responseModel ?? p.model,
        ],
      );
      const row = (
        await c.query("SELECT * FROM embedding_versions WHERE id=$1", [
          p.version,
        ])
      ).rows[0];
      if (
        row.channel_id !== this.store.channelId ||
        row.provider !== p.provider ||
        row.model !== p.model ||
        row.response_model !== (p.responseModel ?? p.model) ||
        row.dimensions !== p.dimensions ||
        row.chunker !== CHUNKER
      )
        throw new Error("embedding_version_conflict");
    });
  }
  async evaluate(
    cases: { groupId: string; query: string; expectedIds: string[] }[],
  ) {
    if (
      cases.length < 30 ||
      cases.length > 100 ||
      new Set(cases.map((c) => c.groupId + "\n" + c.query)).size !==
        cases.length ||
      cases.some(
        (c) =>
          !c.query.trim() ||
          Buffer.byteLength(c.query) > 2000 ||
          !c.expectedIds.length ||
          c.expectedIds.length > 5 ||
          c.expectedIds.some((id) => !/^[0-9a-f-]{36}$/.test(id)),
      )
    )
      throw new Error("invalid_embedding_evaluation");
    const details: {
      queryHash: string;
      expectedIds: string[];
      top5: string[];
    }[] = [];
    for (const sample of cases) {
      const allowed = await this.store.pool.query(
        `${eligible} AND s.group_id=$3 AND s.id=ANY($4::uuid[])`,
        [
          this.store.channelId,
          this.store.now(),
          sample.groupId,
          sample.expectedIds,
        ],
      );
      if (allowed.rowCount !== sample.expectedIds.length)
        throw new Error("invalid_embedding_evaluation");
      const id = randomUUID();
      await this.budgets.createRun({
        id,
        kind: "index",
        groupId: sample.groupId,
      });
      try {
        const ids = await this.similarity(
          id,
          sample.groupId,
          sample.query,
          true,
        );
        details.push({
          queryHash: createHash("sha256").update(sample.query).digest("hex"),
          expectedIds: sample.expectedIds,
          top5: ids.slice(0, 5),
        });
        await this.store.pool.query(
          "UPDATE model_runs SET state='completed' WHERE id=$1",
          [id],
        );
      } catch (error) {
        await this.store.pool.query(
          "UPDATE model_runs SET state='failed' WHERE id=$1",
          [id],
        );
        throw error;
      }
    }
    const result = {
      version: this.provider.version,
      provider: this.provider.provider,
      model: this.provider.model,
      dimensions: this.provider.dimensions,
      cases: cases.length,
      top5:
        details.filter((d) => d.expectedIds.some((id) => d.top5.includes(id)))
          .length / cases.length,
      checksum: createHash("sha256")
        .update(JSON.stringify(details))
        .digest("hex"),
    };
    const changed = await this.store.pool.query(
      "UPDATE embedding_versions SET evaluation=$2 WHERE id=$1 AND state='building'",
      [this.provider.version, result],
    );
    if (!changed.rowCount) throw new Error("embedding_version_conflict");
    return result;
  }
  async activate(
    evaluation: { cases: number; top5: number; checksum: string },
    expectedCurrent: string | null,
  ) {
    if (
      !Number.isInteger(evaluation.cases) ||
      evaluation.cases < 30 ||
      !Number.isFinite(evaluation.top5) ||
      evaluation.top5 < 0.9 ||
      evaluation.top5 > 1 ||
      !/^[a-f0-9]{64}$/.test(evaluation.checksum)
    )
      throw new Error("invalid_embedding_evaluation");
    await this.store.transaction(async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        "embedding-activation:" + this.store.channelId,
      ]);
      const runtime = (await c.query("SELECT * FROM runtime_state FOR SHARE"))
        .rows[0];
      if (runtime.mode !== "open") throw new Error("embedding_unavailable");
      const active = (
        await c.query(
          "SELECT id FROM embedding_versions WHERE channel_id=$1 AND state='active' FOR UPDATE",
          [this.store.channelId],
        )
      ).rows[0];
      if ((active?.id ?? null) !== expectedCurrent)
        throw new Error("embedding_version_conflict");
      const target = (
        await c.query(
          "SELECT * FROM embedding_versions WHERE id=$1 FOR UPDATE",
          [this.provider.version],
        )
      ).rows[0];
      if (
        !target ||
        target.channel_id !== this.store.channelId ||
        target.state !== "building"
      )
        throw new Error("embedding_version_conflict");
      const missing = await c.query(
        `WITH current_sources AS (${eligible}) SELECT s.source_id FROM current_sources s LEFT JOIN embedding_documents d ON d.source_id=s.source_id AND d.version=$3 WHERE d.state IS DISTINCT FROM 'ready' OR d.text_hash<>s.text_hash OR d.source_revision<>s.source_revision OR d.description_revision<>s.description_revision OR d.runtime_generation<>s.runtime_generation LIMIT 1`,
        [this.store.channelId, this.store.now(), this.provider.version],
      );
      if (missing.rowCount) throw new Error("embedding_backfill_incomplete");
      if (
        !target.evaluation ||
        target.evaluation.checksum !== evaluation.checksum ||
        target.evaluation.cases !== evaluation.cases ||
        target.evaluation.top5 !== evaluation.top5
      )
        throw new Error("embedding_evaluation_required");
      await c.query(
        "UPDATE embedding_versions SET state='retired' WHERE channel_id=$1 AND state='active'",
        [this.store.channelId],
      );
      await c.query(
        "UPDATE embedding_versions SET state='active',evaluation=$2 WHERE id=$1",
        [this.provider.version, evaluation],
      );
    });
  }
  async embed(runId: string, text: string[]): Promise<number[][]> {
    if (
      !text.length ||
      text.length > 4 ||
      text.some((s) => !s || Buffer.byteLength(s) > 2000)
    )
      throw new Error("embedding_input_limit");
    const id = randomUUID(),
      p = this.provider;
    const run = await this.store.transaction((c) =>
      this.budgets.guard(c, runId),
    );
    await this.budgets.reserve({
      id,
      runId,
      provider: p.provider,
      model: p.model,
      purpose: "embedding",
      inputTokens: text.reduce((n, s) => n + Buffer.byteLength(s), 0),
      maxOutputTokens: 0,
      price: {
        inputMicrosPerMillion: p.inputMicrosPerMillion,
        outputMicrosPerMillion: 0,
      },
    });
    try {
      const remaining = run.deadline.getTime() - this.store.now().getTime();
      if (remaining <= 0) throw new Error("run_fenced");
      const result = await p.embed(text, AbortSignal.timeout(remaining));
      if (!Number.isSafeInteger(result.inputTokens) || result.inputTokens < 0)
        throw new Error("embedding_usage_unknown");
      await this.budgets.settle(id, {
        inputTokens: result.inputTokens,
        outputTokens: 0,
      });
      if (
        result.vectors.length !== text.length ||
        result.vectors.some(
          (v) =>
            v.length !== p.dimensions ||
            v.some(
              (n) => !Number.isFinite(n) || !Number.isFinite(Math.fround(n)),
            ) ||
            !v.some((n) => Math.fround(n) !== 0),
        )
      )
        throw new Error("invalid_embedding_vector");
      await this.store.transaction((c) => this.budgets.guard(c, runId));
      return result.vectors;
    } catch (error) {
      await this.budgets.unknown(id);
      throw error;
    }
  }
  async guard(c: PoolClient, job: Document) {
    const runtime = (await c.query("SELECT * FROM runtime_state FOR SHARE"))
      .rows[0];
    if (
      runtime.mode !== "open" ||
      runtime.generation !== job.runtime_generation
    )
      throw new Error("embedding_fenced");
    await c.query("SELECT id FROM groups WHERE id=$1 FOR SHARE", [
      job.group_id,
    ]);
    await c.query("SELECT id FROM sources WHERE id=$1 FOR SHARE", [
      job.source_id,
    ]);
    const source = (
      await c.query<Document>(`${eligible} AND s.id=$3`, [
        this.store.channelId,
        this.store.now(),
        job.source_id,
      ])
    ).rows[0];
    const doc = (
      await c.query<Document>(
        "SELECT * FROM embedding_documents WHERE source_id=$1 AND version=$2 FOR UPDATE",
        [job.source_id, this.provider.version],
      )
    ).rows[0];
    if (
      !source ||
      source.source_revision !== job.source_revision ||
      source.description_revision !== job.description_revision ||
      source.text_hash !== job.text_hash ||
      !doc ||
      doc.state !== "processing" ||
      doc.fence !== job.fence ||
      doc.lease_until <= this.store.now()
    )
      throw new Error("embedding_fenced");
  }
  async processOne(): Promise<boolean> {
    const job = await this.store.transaction(async (c) => {
      const runtime = (await c.query("SELECT * FROM runtime_state FOR SHARE"))
        .rows[0];
      if (runtime.mode !== "open") return;
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        "embedding-worker:" + this.store.channelId,
      ]);
      if (
        (
          await c.query(
            "SELECT id FROM model_runs WHERE channel_id=$1 AND kind IN ('query','admin') AND state='running' AND deadline>$2 LIMIT 1",
            [this.store.channelId, this.store.now()],
          )
        ).rowCount
      )
        return;
      if (
        (
          await c.query(
            "SELECT d.source_id FROM embedding_documents d JOIN embedding_versions v ON v.id=d.version WHERE v.channel_id=$1 AND d.state='processing' AND d.lease_until>$2 LIMIT 1",
            [this.store.channelId, this.store.now()],
          )
        ).rowCount
      )
        return;
      const version = (
        await c.query(
          "SELECT state FROM embedding_versions WHERE id=$1 AND channel_id=$2",
          [this.provider.version, this.store.channelId],
        )
      ).rows[0];
      if (!version || version.state === "retired") return;
      const source = (
        await c.query<Document>(
          `WITH current_sources AS (${eligible}) SELECT s.* FROM current_sources s LEFT JOIN embedding_documents d ON d.source_id=s.source_id AND d.version=$3 WHERE d.source_id IS NULL OR d.source_revision<>s.source_revision OR d.description_revision<>s.description_revision OR d.text_hash<>s.text_hash OR d.runtime_generation<>s.runtime_generation OR (d.state='queued' AND d.available_at<=$2) OR (d.state='processing' AND d.lease_until<=$2) ORDER BY s.source_id LIMIT 1`,
          [this.store.channelId, this.store.now(), this.provider.version],
        )
      ).rows[0];
      if (!source) return;
      await c.query("SELECT id FROM groups WHERE id=$1 FOR SHARE", [
        source.group_id,
      ]);
      await c.query("SELECT id FROM sources WHERE id=$1 FOR SHARE", [
        source.source_id,
      ]);
      const current = (
        await c.query<Document>(`${eligible} AND s.id=$3`, [
          this.store.channelId,
          this.store.now(),
          source.source_id,
        ])
      ).rows[0];
      if (
        !current ||
        current.text_hash !== source.text_hash ||
        current.source_revision !== source.source_revision ||
        current.description_revision !== source.description_revision
      )
        return;
      const old = (
        await c.query<Document>(
          "SELECT * FROM embedding_documents WHERE source_id=$1 AND version=$2 FOR UPDATE",
          [source.source_id, this.provider.version],
        )
      ).rows[0];
      if (
        !old ||
        old.text_hash !== source.text_hash ||
        old.source_revision !== source.source_revision ||
        old.description_revision !== source.description_revision ||
        old.runtime_generation !== source.runtime_generation
      ) {
        if (old)
          await c.query(
            "DELETE FROM source_vectors WHERE source_id=$1 AND version=$2",
            [source.source_id, this.provider.version],
          );
        await c.query(
          "INSERT INTO embedding_documents(source_id,version,source_revision,description_revision,runtime_generation,text_hash,state,available_at) VALUES($1,$2,$3,$4,$5,$6,'queued',$7) ON CONFLICT(source_id,version) DO UPDATE SET source_revision=EXCLUDED.source_revision,description_revision=EXCLUDED.description_revision,runtime_generation=EXCLUDED.runtime_generation,text_hash=EXCLUDED.text_hash,state='queued',next_chunk=0,available_at=EXCLUDED.available_at",
          [
            source.source_id,
            this.provider.version,
            source.source_revision,
            source.description_revision,
            source.runtime_generation,
            source.text_hash,
            this.store.now(),
          ],
        );
      }
      const doc = (
        await c.query<Document>(
          "UPDATE embedding_documents SET state='processing',fence=fence+1,lease_until=$3 WHERE source_id=$1 AND version=$2 RETURNING *",
          [
            source.source_id,
            this.provider.version,
            new Date(this.store.now().getTime() + 60000),
          ],
        )
      ).rows[0]!;
      return { ...source, ...doc };
    });
    if (!job) return false;
    const runId = randomUUID();
    try {
      const parts = chunks(job.text),
        batch = parts.slice(job.next_chunk, job.next_chunk + 4);
      await this.budgets.createRun({
        id: runId,
        kind: "index",
        groupId: job.group_id,
      });
      const vectors = await this.embed(runId, batch);
      await this.store.transaction(async (c) => {
        await this.guard(c, job);
        await this.budgets.guard(c, runId);
        for (let i = 0; i < vectors.length; i++)
          await c.query(
            "INSERT INTO source_vectors(source_id,version,dimensions,ordinal,embedding) VALUES($1,$2,$3,$4,$5::vector) ON CONFLICT(source_id,version,ordinal) DO UPDATE SET embedding=EXCLUDED.embedding",
            [
              job.source_id,
              this.provider.version,
              this.provider.dimensions,
              job.next_chunk + i,
              JSON.stringify(vectors[i]),
            ],
          );
        const next = job.next_chunk + batch.length;
        await c.query(
          "UPDATE embedding_documents SET state=$3,next_chunk=$4,available_at=$5,lease_until=NULL WHERE source_id=$1 AND version=$2",
          [
            job.source_id,
            this.provider.version,
            next >= parts.length ? "ready" : "queued",
            next,
            this.store.now(),
          ],
        );
        await c.query("UPDATE model_runs SET state='completed' WHERE id=$1", [
          runId,
        ]);
      });
    } catch {
      await this.store.pool.query(
        "UPDATE embedding_documents SET state='queued',available_at=$4,lease_until=NULL WHERE source_id=$1 AND version=$2 AND fence=$3 AND state='processing'",
        [
          job.source_id,
          this.provider.version,
          job.fence,
          new Date(this.store.now().getTime() + 3600000),
        ],
      );
      await this.store.pool.query(
        "UPDATE model_runs SET state='failed' WHERE id=$1 AND state='running'",
        [runId],
      );
    }
    return true;
  }
  async search(
    runId: string,
    groupId: string,
    query: string,
    filters: Omit<SearchInput, "query"> = {},
  ): Promise<string[]> {
    Search.validateInput({ query, ...filters });
    return this.similarity(runId, groupId, query, false, filters);
  }
  private async similarity(
    runId: string,
    groupId: string,
    query: string,
    evaluation: boolean,
    filters: Omit<SearchInput, "query"> = {},
  ): Promise<string[]> {
    const active = (
      await this.store.pool.query(
        "SELECT id FROM embedding_versions WHERE channel_id=$1 AND id=$2 AND (state='active' OR ($3 AND state='building'))",
        [this.store.channelId, this.provider.version, evaluation],
      )
    ).rows[0];
    if (!active) throw new Error("embedding_unavailable");
    const run = await this.store.transaction((c) =>
      this.budgets.guard(c, runId),
    );
    if (
      run.kind !== (evaluation ? "index" : "query") ||
      run.group_id !== groupId
    )
      throw new Error("embedding_forbidden");
    const [vector] = await this.embed(runId, [query]);
    return this.store.transaction(async (c) => {
      await c.query("SET LOCAL statement_timeout='2000ms'");
      await this.budgets.guard(c, runId);
      const result = await c.query(
        `WITH current_sources AS MATERIALIZED (${eligible} AND s.group_id=$3 AND ($7::text IS NULL OR s.kind=$7) AND ($8::text IS NULL OR s.author_id=$8) AND ($9::timestamptz IS NULL OR s.published_at>=$9) AND ($10::timestamptz IS NULL OR s.published_at<$10)), candidates AS MATERIALIZED (
     SELECT v.source_id,v.embedding FROM current_sources s JOIN embedding_documents d ON d.source_id=s.source_id AND d.version=$4 JOIN source_vectors v ON v.source_id=d.source_id AND v.version=d.version JOIN embedding_versions version ON version.id=d.version AND (version.state='active' OR ($6 AND version.state='building'))
     WHERE d.state='ready' AND d.source_revision=s.source_revision AND d.description_revision=s.description_revision AND d.runtime_generation=s.runtime_generation AND d.text_hash=s.text_hash)
     SELECT source_id,min(embedding <=> $5::vector) AS distance FROM candidates GROUP BY source_id ORDER BY distance,source_id LIMIT 20`,
        [
          this.store.channelId,
          this.store.now(),
          groupId,
          this.provider.version,
          JSON.stringify(vector),
          evaluation,
          filters.kind ?? null,
          filters.authorId ?? null,
          filters.publishedFrom ?? null,
          filters.publishedBefore ?? null,
        ],
      );
      return result.rows.map((r) => r.source_id as string);
    });
  }
}
