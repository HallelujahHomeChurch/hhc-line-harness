import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { database, databaseEnabled } from "./database.ts";
import { createWorkers } from "../src/bootstrap/worker-runtime.ts";
import { createRuntime } from "../src/bootstrap/runtime.ts";
const id = "11111111-1111-4111-8111-111111111111",
  group = `C${"c".repeat(32)}`,
  actor = `U${"a".repeat(32)}`;
test(
  "local adapters save, restart, authorize download and revoke one immutable original",
  { skip: !databaseEnabled },
  async (t) => {
    const pool = await database(t),
      now = new Date();
    await pool.query("UPDATE runtime_state SET mode='open',ingest_floor=$1", [
      new Date(now.getTime() - 1000),
    ]);
    await pool.query(
      "INSERT INTO groups(channel_id,line_group_id,state,active_from) VALUES('channel',$1,'active',$2)",
      [group, new Date(now.getTime() - 1000)],
    );
    const bytes = Buffer.from("%PDF-1.7\nsynthetic fixture");
    let uploaded = Buffer.alloc(0),
      deleted = false,
      creates = 0,
      downloads = 0;
    let asset: Record<string, unknown> = {};
    const fetcher: typeof fetch = async (url, init) => {
      const target = new URL(String(url));
      if (target.hostname === "api-data.line.me") {
        downloads++;
        return new Response(bytes, {
          headers: { "content-type": "application/pdf" },
        });
      }
      if (target.hostname === "blob.invalid") {
        const chunks: Buffer[] = [];
        for await (const chunk of init!.body as AsyncIterable<Uint8Array>)
          chunks.push(Buffer.from(chunk));
        uploaded = Buffer.concat(chunks);
        return new Response(null, { status: 201 });
      }
      if (target.hostname === "api.line.me") {
        if (target.pathname === "/oauth2/v2.1/verify")
          return Response.json({
            iss: "https://access.line.me",
            aud: "123",
            sub: actor,
            exp: Math.floor(Date.now() / 1000) + 60,
          });
        if (target.pathname === `/v2/bot/group/${group}/member/${actor}`)
          return Response.json({ userId: actor });
      }
      if (target.hostname === "asset.invalid") {
        if (target.pathname === "/priv/assets/upload-policy") {
          const request = JSON.parse(String(init?.body));
          return Response.json({
            ...request,
            version: 2,
            readinessVersion: 2,
            sourceUploadRecoveryVersion: 1,
            scanRequired: false,
            maxSizeBytes: 200 * 1024 * 1024,
            mimeTypes: ["application/pdf"],
            mimeMaxSizeBytes: { "application/pdf": 25 * 1024 * 1024 },
            visibilities: ["restricted"],
          });
        }
        if (target.pathname === "/priv/assets/upload-sessions") {
          creates++;
          const request = JSON.parse(String(init?.body));
          asset = {
            ...request,
            id,
            sourcePolicy: {
              ...request.source,
              version: 1,
              expiresAt: new Date(
                Date.parse(request.source.publishedAt) + 90 * 86400000,
              ).toISOString(),
            },
            uploadStatus: "created",
            scanStatus: "pending",
            processingStatus: "not_required",
            deletedAt: "0001-01-01T00:00:00Z",
          };
          return Response.json({
            asset,
            session: { id: "session" },
            uploadTarget: {
              url: "https://blob.invalid/object?synthetic=signature",
              method: "PUT",
              headers: { "Content-Type": "application/pdf" },
              expiresAt: new Date(Date.now() + 60000).toISOString(),
            },
          });
        }
        if (target.pathname === `/priv/assets/${id}/complete`) {
          assert.deepEqual(uploaded, bytes);
          const request = JSON.parse(String(init?.body));
          assert.equal(
            request.checksumSha256,
            createHash("sha256").update(bytes).digest("hex"),
          );
          asset = {
            ...asset,
            uploadStatus: "completed",
            scanStatus: "not_required",
            sizeBytes: bytes.length,
            checksumSha256: request.checksumSha256,
            detectedMimeType: "application/pdf",
            etag: "immutable",
            processingReadiness: { version: 2, state: "ready" },
            safetyEvidence: { kind: "not-scanned" },
          };
          return Response.json(asset);
        }
        if (target.pathname === `/priv/assets/${id}/source-content`)
          return new Response(bytes, {
            headers: { etag: "immutable", "content-type": "application/pdf" },
          });
        if (target.pathname === `/priv/assets/${id}`) {
          if (init?.method === "DELETE") {
            deleted = true;
            return new Response(null, { status: 204 });
          }
          return Response.json(asset);
        }
      }
      assert.fail(
        `unexpected synthetic destination ${target.origin}${target.pathname}`,
      );
    };
    const config = {
      databaseUrl: "unused",
      channelId: "channel",
      lineDownloadToken: "download",
      assetOrigin: "https://asset.invalid",
      assetToken: "workload",
      uploadOrigins: ["https://blob.invalid"],
      queueUrl: "https://fixture.queue.core.windows.net/harness",
      identityClientId: id,
    };
    const worker = createWorkers(pool, config, fetcher);
    await worker.initialize();
    await worker.store.ingest({
      id: "original",
      scope: "group",
      scopeId: group,
      type: "message",
      publishedAt: now,
      message: {
        id: "message",
        type: "file",
        fileName: "document.pdf",
        mentionsBot: false,
      },
    });
    await worker.processOne();
    assert.equal(
      (await pool.query("SELECT state FROM sources")).rows[0].state,
      "ready",
    );
    assert.equal(await createWorkers(pool, config, fetcher).processOne(), true);
    assert.equal(
      (await pool.query("SELECT state FROM jobs WHERE kind='index'")).rows[0]
        .state,
      "completed",
    );
    assert.equal(
      await createWorkers(pool, config, fetcher).processOne(),
      false,
    );
    assert.equal(downloads, 1);
    assert.equal(creates, 1);
    const api = createRuntime(
      pool,
      {
        ...config,
        botId: `U${"b".repeat(32)}`,
        lineProfile: "harness",
        lineAccessToken: "api-token",
        lineLoginChannelId: "123",
        replyEncryptionKey: "a".repeat(64),
        sourceAccessToken: "b".repeat(64),
        gatewayToken: "d".repeat(64),
        accountOrigin: "https://account.invalid",
        accountToken: "c".repeat(64),
        adminOrigin: "https://admin.invalid",
      },
      fetcher,
    );
    await api.initialize();
    const source = (await pool.query("SELECT id FROM sources")).rows[0].id;
    assert.equal(
      await (await api.content.get(source, "signed-token", "GET", {})).text(),
      bytes.toString(),
    );
    await api.store.ingest({
      id: "unsend",
      scope: "group",
      scopeId: group,
      type: "unsend",
      publishedAt: new Date(),
      unsentMessageId: "message",
    });
    await assert.rejects(
      api.content.get(source, "signed-token", "GET", {}),
      /content_gone/,
    );
    await worker.processOne();
    assert.equal(deleted, true);
  },
);
