import { mediaExtensions } from "./download.ts";
export function inspectLineUploadPolicy(input: unknown): {
  status: "scan_required" | "unsupported_contract" | "source_ready";
} {
  if (typeof input !== "object" || input === null)
    return { status: "unsupported_contract" };
  const p = input as Record<string, unknown>;
  if (
    p.version === 2 &&
    p.readinessVersion === 2 &&
    p.sourceUploadRecoveryVersion === 1 &&
    ["line.group.file", "line.group.media-sync"].includes(
      String(p.namespace),
    ) &&
    p.securityProfile === "line-source-unscanned-v1" &&
    p.processingProfile === "no-processing-v1" &&
    p.scanRequired === false &&
    p.maxSizeBytes === 200 * 1024 * 1024 &&
    Array.isArray(p.visibilities) &&
    p.visibilities.length === 1 &&
    p.visibilities[0] === "restricted" &&
    Array.isArray(p.mimeTypes) &&
    p.mimeTypes.length > 0 &&
    p.mimeTypes.length <= 32 &&
    typeof p.mimeMaxSizeBytes === "object" &&
    p.mimeMaxSizeBytes !== null
  ) {
    const limits = p.mimeMaxSizeBytes as Record<string, unknown>;
    if (
      p.mimeTypes.every(
        (mime: unknown) =>
          typeof mime === "string" &&
          Object.hasOwn(mediaExtensions, mime) &&
          (!(mime.startsWith("image/") || mime.startsWith("application/")) ||
            limits[mime] ===
              (mime.startsWith("image/") ? 10 : 25) * 1024 * 1024),
      )
    )
      return { status: "source_ready" };
  }
  if (
    p.version !== 1 ||
    p.readinessVersion !== 1 ||
    p.namespace !== "line.group.media-sync" ||
    p.securityProfile !== "line-media-v1" ||
    p.processingProfile !== "no-processing-v1" ||
    p.scanRequired !== true ||
    !Number.isSafeInteger(p.maxSizeBytes) ||
    (p.maxSizeBytes as number) <= 0 ||
    !Array.isArray(p.mimeTypes) ||
    !p.mimeTypes.length ||
    !p.mimeTypes.every(
      (mime: unknown) => typeof mime === "string" && mime.length > 0,
    ) ||
    !Array.isArray(p.visibilities) ||
    p.visibilities.length !== 1 ||
    p.visibilities[0] !== "restricted"
  ) {
    return { status: "unsupported_contract" };
  }
  return { status: "scan_required" };
}
