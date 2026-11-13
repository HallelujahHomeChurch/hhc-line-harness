import { createHash } from "node:crypto";
import { mkdtemp, open, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Store } from "../persistence/store.ts";
import { Jobs } from "./jobs.ts";
import { extractFile } from "../extraction/process.ts";
import type { Extraction } from "../extraction/parse.ts";
import { terms } from "../search/terms.ts";
const EXTRACTOR = "pdfjs-6.5.438+xlsx-cached-v1";
export class IndexWorker {
  readonly jobs: Jobs;
  readonly store: Store;
  readonly content: (id: string) => Promise<Response>;
  constructor(store: Store, content: (id: string) => Promise<Response>) {
    this.store = store;
    this.content = content;
    this.jobs = new Jobs(store);
  }
  async processOne(): Promise<boolean> {
    const job = await this.jobs.claim("index");
    if (!job) return false;
    let directory: string | undefined;
    try {
      const source = (
        await this.store.pool.query("SELECT * FROM sources WHERE id=$1", [
          job.source_id,
        ])
      ).rows[0]!;
      if (source.state !== "ready") throw new Error("source_not_ready");
      let extraction: Extraction = {
        version: 1,
        state: "not_applicable",
        code: "metadata_only",
        text: "",
        units: 0,
      };
      if (source.kind === "text")
        extraction = {
          version: 1,
          state: "ready",
          code: "embedded_text",
          text: source.body ?? "",
          units: 1,
        };
      else if (source.mime_type === "application/vnd.ms-excel")
        extraction = {
          ...extraction,
          state: "incomplete",
          code: "unsupported_spreadsheet",
        };
      else if (
        [
          "application/pdf",
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ].includes(source.mime_type)
      ) {
        const response = await this.content(source.asset_id);
        if (
          response.status !== 200 ||
          !response.body ||
          response.headers.get("etag") !== source.asset_etag ||
          response.headers.get("content-type")?.split(";")[0] !==
            source.mime_type
        ) {
          await response.body?.cancel();
          throw new Error("index_content_unavailable");
        }
        directory = await mkdtemp(join(tmpdir(), "harness-index-"));
        const path = join(directory, "original");
        const file = await open(path, "wx", 0o600);
        const hash = createHash("sha256");
        let size = 0;
        try {
          for await (const chunk of response.body) {
            size += chunk.length;
            if (size > 25 * 1024 * 1024) throw new Error("index_size_limit");
            hash.update(chunk);
            await file.writeFile(chunk);
          }
        } finally {
          await file.close();
        }
        if (
          String(size) !== source.byte_size ||
          hash.digest("hex") !== source.checksum_sha256
        )
          throw new Error("index_integrity_failed");
        await this.jobs.guard(job);
        extraction = await extractFile(path, source.mime_type);
      }
      await this.store.transaction(async (c) => {
        await this.jobs.guard(job, c);
        // Description writes lock the source and refresh their own searchable terms.
        const current = (
          await c.query("SELECT description FROM sources WHERE id=$1", [
            job.source_id,
          ])
        ).rows[0]!;
        await c.query(
          `INSERT INTO source_indexes(source_id,source_revision,runtime_generation,extractor_version,state,code,extracted_text,terms,indexed_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(source_id) DO UPDATE SET source_revision=EXCLUDED.source_revision,runtime_generation=EXCLUDED.runtime_generation,extractor_version=EXCLUDED.extractor_version,state=EXCLUDED.state,code=EXCLUDED.code,extracted_text=EXCLUDED.extracted_text,terms=EXCLUDED.terms,indexed_at=EXCLUDED.indexed_at`,
          [
            source.id,
            job.source_revision,
            job.runtime_generation,
            EXTRACTOR,
            extraction.state,
            extraction.code,
            extraction.text,
            terms(
              [source.file_name, current.description, extraction.text]
                .filter(Boolean)
                .join("\n"),
            ),
            this.store.now(),
          ],
        );
        await c.query(
          "UPDATE jobs SET state='completed',lease_until=NULL WHERE id=$1",
          [job.id],
        );
      });
    } catch (error) {
      try {
        await this.jobs.fail(job);
      } catch (fenced) {
        if (!(fenced instanceof Error && fenced.message === "job_fenced"))
          throw fenced;
      }
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true });
    }
    return true;
  }
}
