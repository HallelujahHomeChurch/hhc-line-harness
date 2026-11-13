import { Unzip, UnzipInflate } from "fflate";
import { XMLParser, XMLValidator } from "fast-xml-parser";
export interface Extraction {
  version: 1;
  state: "ready" | "incomplete" | "not_applicable" | "failed";
  code:
    | "embedded_text"
    | "cached_values"
    | "no_embedded_text"
    | "unsupported_spreadsheet"
    | "metadata_only"
    | "limit_exceeded"
    | "encrypted_document"
    | "malformed_document";
  text: string;
  units: number;
}
export const TEXT_LIMIT = 250_000;
const XML_LIMIT = 8 * 1024 * 1024;
function result(
  state: Extraction["state"],
  code: Extraction["code"],
  text = "",
  units = 0,
): Extraction {
  return { version: 1, state, code, text, units };
}
function bounded(value: string): string {
  if (value.length > TEXT_LIMIT) throw new Error("limit_exceeded");
  return value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, " ");
}
function array(value: unknown): unknown[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function string(value: unknown): string {
  return typeof value === "string"
    ? value
    : typeof value === "number"
      ? String(value)
      : typeof object(value)["#text"] === "string"
        ? (object(value)["#text"] as string)
        : "";
}
function cellText(value: unknown): string {
  const v = object(value);
  return v.t === undefined
    ? array(v.r)
        .map((r) => string(object(r).t))
        .join("")
    : string(v.t);
}
function readXML(bytes: Uint8Array): Record<string, unknown> {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error("malformed_document");
  if (XMLValidator.validate(text) !== true)
    throw new Error("malformed_document");
  // OOXML cell data never requires entity declarations or executable formulas.
  return object(
    new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "@",
      parseTagValue: false,
      parseAttributeValue: false,
      processEntities: true,
      htmlEntities: false,
      maxNestedTags: 64,
      removeNSPrefix: true,
    }).parse(text),
  );
}
function spreadsheet(bytes: Uint8Array): Extraction {
  const files = new Map<string, Uint8Array>();
  const names = new Set<string>();
  let total = 0;
  const unzip = new Unzip((file) => {
    if (
      names.has(file.name) ||
      file.name.includes("..") ||
      file.name.startsWith("/")
    )
      throw new Error("malformed_document");
    names.add(file.name);
    if (names.size > 256 || (file.originalSize ?? 0) > XML_LIMIT)
      throw new Error("limit_exceeded");
    if (
      !/^xl\/(?:sharedStrings\.xml|worksheets\/sheet[0-9]+\.xml)$/.test(
        file.name,
      )
    )
      return;
    const chunks: Uint8Array[] = [];
    let size = 0;
    file.ondata = (error, chunk, final) => {
      if (error) throw error;
      size += chunk.length;
      total += chunk.length;
      if (total > XML_LIMIT) {
        file.terminate();
        throw new Error("limit_exceeded");
      }
      chunks.push(chunk);
      if (final) {
        const out = new Uint8Array(size);
        let offset = 0;
        for (const c of chunks) {
          out.set(c, offset);
          offset += c.length;
        }
        files.set(file.name, out);
      }
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  for (let offset = 0; offset < bytes.length; offset += 1024)
    unzip.push(
      bytes.subarray(offset, offset + 1024),
      offset + 1024 >= bytes.length,
    );
  if (names.has("xl/vbaProject.bin")) throw new Error("malformed_document");
  const sheets = [...files.keys()].filter((x) =>
    x.startsWith("xl/worksheets/"),
  );
  if (!sheets.length) throw new Error("malformed_document");
  if (sheets.length > 32) throw new Error("limit_exceeded");
  const shared = files.get("xl/sharedStrings.xml");
  const strings = shared
    ? array(object(readXML(shared).sst).si).map(cellText)
    : [];
  if (strings.length > 50_000) throw new Error("limit_exceeded");
  let count = 0;
  const rows: string[] = [];
  let length = 0;
  let incomplete = false;
  for (const name of sheets.sort()) {
    const sheet = object(readXML(files.get(name)!).worksheet);
    for (const row of array(object(sheet.sheetData).row)) {
      const values: string[] = [];
      for (const value of array(object(row).c)) {
        if (++count > 100_000) throw new Error("limit_exceeded");
        const cell = object(value);
        let text = "";
        if (cell["@t"] === "s") {
          const index = Number(string(cell.v));
          if (
            !Number.isSafeInteger(index) ||
            index < 0 ||
            strings[index] === undefined
          )
            throw new Error("malformed_document");
          text = strings[index]!;
        } else if (cell["@t"] === "inlineStr") text = cellText(cell.is);
        else text = string(cell.v);
        if (cell.f !== undefined && cell.v === undefined) incomplete = true;
        length += text.length + 1;
        if (length > TEXT_LIMIT) throw new Error("limit_exceeded");
        if (text) values.push(text);
      }
      if (values.length) rows.push(values.join("\t"));
    }
  }
  const text = bounded(rows.join("\n"));
  return result(
    incomplete || !text ? "incomplete" : "ready",
    "cached_values",
    text,
    sheets.length,
  );
}
export async function parseDocument(
  bytes: Uint8Array,
  mime: string,
): Promise<Extraction> {
  try {
    if (bytes.length > 25 * 1024 * 1024) throw new Error("limit_exceeded");
    if (mime === "application/vnd.ms-excel")
      return result("incomplete", "unsupported_spreadsheet");
    if (
      mime ===
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    )
      return spreadsheet(bytes);
    if (mime !== "application/pdf")
      return result("not_applicable", "metadata_only");
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const task = getDocument({
      data: bytes,
      disableFontFace: true,
      useSystemFonts: false,
      disableAutoFetch: true,
      disableStream: true,
      disableRange: true,
      verbosity: 0,
      stopAtErrors: true,
    });
    const document = await task.promise;
    try {
      if (document.numPages > 100) throw new Error("limit_exceeded");
      const pages: string[] = [];
      let size = 0;
      for (let page = 1; page <= document.numPages; page++) {
        const current = await document.getPage(page);
        const content = await current.getTextContent();
        const text = content.items
          .map((item) => ("str" in item ? item.str : ""))
          .join(" ");
        size += text.length + 1;
        if (size > TEXT_LIMIT) throw new Error("limit_exceeded");
        pages.push(text);
        current.cleanup();
      }
      const text = bounded(pages.join("\n").trim());
      return result(
        text ? "ready" : "incomplete",
        text ? "embedded_text" : "no_embedded_text",
        text,
        document.numPages,
      );
    } finally {
      await task.destroy();
    }
  } catch (error) {
    const code =
      error instanceof Error && error.message === "limit_exceeded"
        ? "limit_exceeded"
        : error instanceof Error && error.name === "PasswordException"
          ? "encrypted_document"
          : "malformed_document";
    return result("failed", code);
  }
}
