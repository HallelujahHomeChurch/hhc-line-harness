import { IndexWorker } from "../worker/indexer.ts";
import type { Pool } from "pg";
import type { WorkerConfig } from "./config.ts";
import { Store, requireRuntimeGeneration } from "../persistence/store.ts";
import { DownloadClient } from "../providers/download.ts";
import { AssetOriginalClient } from "../providers/asset-original.ts";
import { AssetPublicationClient } from "../providers/asset-publication.ts";
import { AssetClient } from "../providers/asset.ts";
import { OriginalWorker } from "../worker/original.ts";
import { PublicationWorker } from "../worker/publication.ts";
import { UnpublishWorker } from "../worker/unpublish.ts";
import { CleanupWorker } from "../worker/cleanup.ts";
export function createWorkers(
  pool: Pool,
  config: WorkerConfig,
  fetcher: typeof fetch = fetch,
) {
  const store = new Store(pool, undefined, config.channelId);
  const asset = new AssetOriginalClient(
    config.assetOrigin,
    config.assetToken,
    config.uploadOrigins,
    fetcher,
  );
  const download = new DownloadClient(config.lineDownloadToken, fetcher);
  const original = new OriginalWorker(store, {
    download: (s) => download.download(s),
    lookup: (id) => asset.lookup(id),
    inspect: (id) => asset.inspect(id),
    create: (s, f) => asset.create(s, f),
    put: (u, f) => asset.put(u, f),
    complete: (id, f) => asset.complete(id, f),
  });
  const indexer = new IndexWorker(store, (id) => asset.content(id, "GET", {}));
  const publicationClient = new AssetPublicationClient(asset.http);
  const publication = new PublicationWorker(store, {
    lookup: (p) => publicationClient.lookup(p),
    stage: (p, s) => publicationClient.stage(p, s),
    activate: (p) => publicationClient.activate(p),
  });
  const cleanup = new CleanupWorker(store, {
    lookup: (id) => asset.lookup(id),
    remove: (id) => asset.remove(id),
  });
  const unpublish = new UnpublishWorker(store, {
    lookup: (p) => publicationClient.lookup(p),
    remove: (p) => publicationClient.remove(p),
  });
  return {
    store,
    initialize: async () => {
      await requireRuntimeGeneration(pool, config.runtimeGeneration ?? "1");
      await new AssetClient(
        config.assetOrigin,
        config.assetToken,
        fetcher,
      ).checkPolicy();
    },
    processOne: async () =>
      (await cleanup.processOne()) ||
      (await unpublish.processOne()) ||
      (await original.processOne()) ||
      (await publication.processOne()) ||
      (await indexer.processOne()),
  };
}
