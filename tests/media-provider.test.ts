import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, access } from "node:fs/promises";
import { DownloadClient } from "../src/providers/download.ts";
import type { Source } from "../src/worker/original.ts";
const source = {
  id: "11111111-1111-4111-8111-111111111111",
  message_id: "12345",
  kind: "file",
  file_name: "../../private.pdf",
  byte_size: null,
} as Source;
test("LINE content is streamed to a private random path, bounded and disposed", async () => {
  const client = new DownloadClient("synthetic", async (url, init) => {
    assert.equal(
      String(url),
      "https://api-data.line.me/v2/bot/message/12345/content",
    );
    assert.equal(init?.redirect, "error");
    return new Response("%PDF-fixture", {
      headers: { "content-type": "application/pdf" },
    });
  });
  const file = await client.download(source);
  assert.equal((await readFile(file.path)).toString(), "%PDF-fixture");
  assert.match(file.fileName, /^11111111.*\.pdf$/);
  assert.doesNotMatch(file.path, /private\.pdf/);
  await file.dispose();
  await assert.rejects(access(file.path));
});
test("oversized metadata and unsupported content never create usable files", async () => {
  const cases: Record<string, string>[] = [
    {
      "content-type": "application/pdf",
      "content-length": String(26 * 1024 * 1024),
    },
    { "content-type": "text/html" },
  ];
  for (const headers of cases) {
    const client = new DownloadClient(
      "synthetic",
      async () => new Response("body", { headers }),
    );
    await assert.rejects(client.download(source));
  }
});
