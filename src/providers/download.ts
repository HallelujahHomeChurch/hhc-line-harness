import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join, extname } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Source, DownloadedFile } from "../worker/original.ts";
import { PermanentSourceError } from "../worker/original.ts";
export const mediaExtensions: Record<string, string> = {
  "application/pdf": "pdf",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
  "video/ogg": "ogv",
  "video/x-msvideo": "avi",
  "video/x-matroska": "mkv",
  "video/x-ms-wmv": "wmv",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/mp4": "m4a",
  "audio/aac": "aac",
  "audio/ogg": "ogg",
};
export class DownloadClient {
  readonly token: string;
  readonly fetcher: typeof fetch;
  constructor(token: string, fetcher: typeof fetch = fetch) {
    if (!token || /[\s\x00-\x1f]/.test(token))
      throw new Error("invalid_line_credential");
    this.token = token;
    this.fetcher = fetcher;
  }
  async download(source: Source): Promise<DownloadedFile> {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(source.message_id))
      throw new PermanentSourceError();
    const signal = AbortSignal.timeout(20_000);
    const response = await this.fetcher(
      `https://api-data.line.me/v2/bot/message/${source.message_id}/content`,
      {
        redirect: "error",
        signal,
        headers: { Authorization: `Bearer ${this.token}` },
      },
    );
    if (response.status === 404 || response.status === 410) {
      await response.body?.cancel();
      throw new PermanentSourceError();
    }
    if (response.status !== 200 || !response.body) {
      await response.body?.cancel();
      throw new Error("download_unavailable");
    }
    let mime =
      response.headers
        .get("content-type")
        ?.split(";")[0]
        ?.trim()
        .toLowerCase() ?? "";
    if (mime === "application/octet-stream")
      mime =
        Object.entries(mediaExtensions).find(
          ([, ext]) =>
            "." + ext === extname(source.file_name ?? "").toLowerCase(),
        )?.[0] ?? "";
    const extension = mediaExtensions[mime];
    const limit =
      (mime.startsWith("image/")
        ? 10
        : mime.startsWith("application/")
          ? 25
          : 200) *
      1024 *
      1024;
    const length = response.headers.get("content-length");
    if (
      !extension ||
      (length !== null && (!/^\d+$/.test(length) || Number(length) > limit))
    ) {
      await response.body.cancel();
      throw new PermanentSourceError();
    }
    const directory = await mkdtemp(join(tmpdir(), "hhc-line-original-"));
    const path = join(directory, "original");
    const dispose = () => rm(directory, { recursive: true, force: true });
    let size = 0;
    const hash = createHash("sha256");
    try {
      await pipeline(
        Readable.from(response.body),
        new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            size += chunk.byteLength;
            if (size > limit) {
              callback(new PermanentSourceError());
              return;
            }
            hash.update(chunk);
            callback(null, chunk);
          },
        }),
        createWriteStream(path, { flags: "wx", mode: 0o600 }),
        { signal },
      );
      if (
        size === 0 ||
        (length !== null && size !== Number(length)) ||
        (source.upload_state === "none" &&
          source.byte_size !== null &&
          Number(source.byte_size) !== size)
      )
        throw new PermanentSourceError();
      return {
        path,
        size,
        checksum: hash.digest("hex"),
        mime,
        fileName: `${source.id}.${extension}`,
        dispose,
      };
    } catch (error) {
      await dispose();
      throw error;
    }
  }
}
