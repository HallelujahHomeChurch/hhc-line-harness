import { readFile, stat } from "node:fs/promises";
import { parseDocument } from "./parse.ts";
const [file, mime] = process.argv.slice(2);
if (
  !file ||
  !mime ||
  !process.permission ||
  process.permission.has("net") ||
  process.permission.has("child") ||
  process.permission.has("fs.write") ||
  process.permission.has("addons") ||
  process.permission.has("worker")
)
  process.exit(2);
try {
  const info = await stat(file);
  if (!info.isFile() || info.size > 25 * 1024 * 1024) process.exit(2);
  const result = await parseDocument(
    new Uint8Array(await readFile(file)),
    mime,
  );
  process.stdout.write(`\nEXTRACTION_RESULT:${JSON.stringify(result)}\n`);
} catch {
  process.exitCode = 2;
}
