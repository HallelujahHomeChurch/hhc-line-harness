import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { Extraction } from "./parse.ts";
export async function extractFile(
  file: string,
  mime: string,
): Promise<Extraction> {
  if (Number(process.versions.node.split(".")[0]) < 26)
    throw new Error("extraction_runtime_unavailable");
  const here = dirname(fileURLToPath(import.meta.url));
  const root = resolve(
    here,
    here.includes("/dist/src/") ? "../../.." : "../..",
  );
  const worker = resolve(
    here,
    import.meta.url.endsWith(".ts") ? "worker.ts" : "worker.js",
  );
  return new Promise((done) => {
    const failure: Extraction = {
      version: 1,
      state: "failed",
      code: "limit_exceeded",
      text: "",
      units: 0,
    };
    const child = spawn(
      process.execPath,
      [
        "--permission",
        "--disallow-code-generation-from-strings",
        "--max-old-space-size=192",
        `--allow-fs-read=${here}`,
        `--allow-fs-read=${root}/node_modules`,
        `--allow-fs-read=${root}/package.json`,
        `--allow-fs-read=${resolve(file)}`,
        worker,
        resolve(file),
        mime,
      ],
      {
        cwd: root,
        env: { TZ: "UTC", LANG: "C.UTF-8" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const output: Buffer[] = [];
    let bytes = 0;
    const timeout = setTimeout(() => child.kill("SIGKILL"), 8000);
    const consume = (data: Buffer, isResult: boolean) => {
      bytes += data.length;
      if (bytes > 2 * 1024 * 1024) {
        child.kill("SIGKILL");
        return;
      }
      if (isResult) output.push(data);
    };
    child.stdout.on("data", (data) => consume(data, true));
    child.stderr.on("data", (data) => consume(data, false));
    child.on("error", () => {
      clearTimeout(timeout);
      done({ ...failure, code: "malformed_document" });
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        done(failure);
        return;
      }
      try {
        const line = Buffer.concat(output)
          .toString("utf8")
          .split("\n")
          .find((x) => x.startsWith("EXTRACTION_RESULT:"));
        const result = JSON.parse(
          line!.slice("EXTRACTION_RESULT:".length),
        ) as Extraction;
        if (
          Object.keys(result).sort().join(",") !==
            "code,state,text,units,version" ||
          ![
            "embedded_text",
            "cached_values",
            "no_embedded_text",
            "unsupported_spreadsheet",
            "metadata_only",
            "limit_exceeded",
            "encrypted_document",
            "malformed_document",
          ].includes(result.code) ||
          result.version !== 1 ||
          !["ready", "incomplete", "failed", "not_applicable"].includes(
            result.state,
          ) ||
          typeof result.text !== "string" ||
          result.text.length > 250_000 ||
          !Number.isSafeInteger(result.units) ||
          result.units < 0 ||
          result.units > 100
        )
          throw new Error();
        done(result);
      } catch {
        done({ ...failure, code: "malformed_document" });
      }
    });
  });
}
