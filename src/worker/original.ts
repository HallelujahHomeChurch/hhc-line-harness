import { isAssetId } from "../domain/asset-id.ts";
import type { Store } from "../persistence/store.ts";
import { Jobs } from "./jobs.ts";
import type { Job } from "./jobs.ts";
export interface Source {
  id: string;
  group_id: string;
  message_id: string;
  kind: string;
  file_name: string | null;
  byte_size: string | null;
  published_at: Date;
  expires_at: Date;
  revision: string;
  asset_source_revision: string;
  asset_id: string | null;
  asset_etag: string | null;
  mime_type: string | null;
  checksum_sha256: string | null;
  upload_file_name: string | null;
  upload_state: string;
  publication_collection_id: string | null;
  publication_acl_revision: string | null;
  publication_binding_generation: string | null;
}
export interface DownloadedFile {
  path: string;
  size: number;
  checksum: string;
  mime: string;
  fileName: string;
  dispose: () => Promise<void>;
}
export interface AssetRecord {
  id: string;
  ref: string;
  revision: string;
  publishedAt: string;
  expiresAt: string;
  ready: boolean;
  etag: string;
  size: number;
  checksum: string;
  mime: string;
}
export interface Upload {
  asset: AssetRecord;
  target: unknown;
}
export interface OriginalPorts {
  download: (source: Source) => Promise<DownloadedFile>;
  lookup: (operation: string) => Promise<AssetRecord | undefined>;
  inspect: (assetId: string) => Promise<AssetRecord>;
  create: (source: Source, file: DownloadedFile) => Promise<Upload>;
  put: (upload: Upload, file: DownloadedFile) => Promise<void>;
  complete: (assetId: string, file: DownloadedFile) => Promise<AssetRecord>;
}
export class PermanentSourceError extends Error {
  constructor() {
    super("source_permanent_failure");
  }
}
export class OriginalWorker {
  readonly store: Store;
  readonly ports: OriginalPorts;
  readonly jobs: Jobs;
  constructor(store: Store, ports: OriginalPorts) {
    this.store = store;
    this.ports = ports;
    this.jobs = new Jobs(store);
  }
  matches(source: Source, asset: AssetRecord) {
    if (
      !isAssetId(asset.id) ||
      asset.ref !== source.id ||
      asset.revision !== source.asset_source_revision ||
      Date.parse(asset.publishedAt) !== source.published_at.getTime() ||
      Date.parse(asset.expiresAt) !== source.expires_at.getTime() ||
      (source.asset_id && source.asset_id !== asset.id)
    )
      throw new PermanentSourceError();
  }
  async remember(source: Source, asset: AssetRecord): Promise<void> {
    this.matches(source, asset);
    await this.store.transaction(async (c) => {
      await c.query("SELECT id FROM groups WHERE id=$1 FOR SHARE", [
        source.group_id,
      ]);
      const current = (
        await c.query("SELECT * FROM sources WHERE id=$1 FOR UPDATE", [
          source.id,
        ])
      ).rows[0];
      if (!current || (current.asset_id && current.asset_id !== asset.id))
        throw new PermanentSourceError();
      await c.query(
        "UPDATE sources SET asset_id=$2,upload_state=CASE WHEN upload_state='completed' THEN upload_state ELSE 'created' END WHERE id=$1",
        [source.id, asset.id],
      );
      if (
        ["revoked", "expired", "failed"].includes(current.state) ||
        current.expires_at <= this.store.now()
      )
        await c.query(
          "INSERT INTO orphan_assets(asset_id,source_id,created_at) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
          [asset.id, source.id, this.store.now()],
        );
    });
  }
  async saved(job: Job, source: Source, asset: AssetRecord): Promise<void> {
    this.matches(source, asset);
    if (
      !asset.ready ||
      !asset.etag ||
      asset.checksum !== source.checksum_sha256 ||
      asset.mime !== source.mime_type ||
      String(asset.size) !== source.byte_size
    )
      throw new PermanentSourceError();
    await this.store.transaction(async (c) => {
      await this.jobs.guard(job, c);
      await c.query(
        "UPDATE sources SET state='ready',asset_etag=$2,upload_state='completed' WHERE id=$1",
        [source.id, asset.etag],
      );
      await c.query(
        "UPDATE jobs SET state='completed',lease_until=NULL WHERE id=$1",
        [job.id],
      );
      const kinds = [
        "index",
        ...(source.publication_collection_id ? ["publish"] : []),
      ];
      for (const kind of kinds) {
        const next = (
          await c.query(
            "INSERT INTO jobs(source_id,kind,runtime_generation,source_revision,created_at,available_at) VALUES($1,$2,$3,$4,$5,$5) ON CONFLICT DO NOTHING RETURNING id",
            [
              source.id,
              kind,
              job.runtime_generation,
              job.source_revision,
              this.store.now(),
            ],
          )
        ).rows[0];
        if (next)
          await c.query(
            "INSERT INTO job_wakes(job_id,created_at) VALUES($1,$2)",
            [next.id, this.store.now()],
          );
      }
    });
  }
  async processOne(): Promise<boolean> {
    const job = await this.jobs.claim("download");
    if (!job) return false;
    let file: DownloadedFile | undefined;
    try {
      let source = (
        await this.store.pool.query<Source>(
          "SELECT * FROM sources WHERE id=$1",
          [job.source_id],
        )
      ).rows[0]!;
      let asset = source.asset_id
        ? await this.ports.inspect(source.asset_id)
        : source.upload_state === "intent"
          ? await this.ports.lookup(source.id)
          : undefined;
      if (asset) {
        await this.remember(source, asset);
        await this.jobs.guard(job);
        if (!asset.ready) asset = await this.ports.inspect(asset.id);
        if (asset.ready) {
          await this.saved(job, source, asset);
          return true;
        }
      }
      file = await this.ports.download(source);
      await this.store.transaction(async (c) => {
        await this.jobs.guard(job, c);
        if (
          source.checksum_sha256 &&
          (source.checksum_sha256 !== file!.checksum ||
            source.mime_type !== file!.mime ||
            source.byte_size !== String(file!.size))
        )
          throw new PermanentSourceError();
        await c.query(
          "UPDATE sources SET checksum_sha256=$2,mime_type=$3,byte_size=$4,upload_file_name=$5,upload_state='intent' WHERE id=$1",
          [source.id, file!.checksum, file!.mime, file!.size, file!.fileName],
        );
      });
      source = (
        await this.store.pool.query<Source>(
          "SELECT * FROM sources WHERE id=$1",
          [job.source_id],
        )
      ).rows[0]!;
      const upload = await this.ports.create(source, file);
      await this.remember(source, upload.asset);
      await this.jobs.guard(job);
      if (upload.asset.ready) {
        await this.saved(job, source, upload.asset);
        return true;
      }
      await this.ports.put(upload, file);
      await this.jobs.guard(job);
      const completed = await this.ports.complete(upload.asset.id, file);
      await this.remember(source, completed);
      await this.saved(job, source, completed);
    } catch (error) {
      try {
        await this.jobs.fail(job, error instanceof PermanentSourceError);
      } catch (fenced) {
        if (!(fenced instanceof Error && fenced.message === "job_fenced"))
          throw fenced;
      }
    } finally {
      await file?.dispose();
    }
    return true;
  }
}
