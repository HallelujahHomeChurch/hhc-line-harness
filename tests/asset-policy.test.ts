import assert from "node:assert/strict";
import { test } from "node:test";
import { inspectLineUploadPolicy } from "../src/providers/asset-policy.ts";

const legacy = {
  version: 1,
  namespace: "line.group.media-sync",
  securityProfile: "line-media-v1",
  processingProfile: "no-processing-v1",
  scanRequired: true,
  readinessVersion: 1,
  maxSizeBytes: 209715200,
  mimeTypes: ["image/jpeg", "application/pdf"],
  visibilities: ["restricted"],
};

test("existing no-processing profile is recognized as scan-required, never as new-source admission", () => {
  assert.deepEqual(inspectLineUploadPolicy(legacy), {
    status: "scan_required",
  });
});

test("unsupported, contradictory or absent contracts never fall back to legacy clean fields", () => {
  for (const input of [
    null,
    {},
    { ...legacy, version: 2 },
    { ...legacy, readinessVersion: 2 },
    { ...legacy, namespace: "cms.weekly.pdf" },
    { ...legacy, scanRequired: false },
    { ...legacy, scanRequired: "true" },
    { ...legacy, securityProfile: "line-source-unscanned-v1" },
    { ...legacy, processingProfile: "" },
    { ...legacy, maxSizeBytes: 0 },
    { ...legacy, mimeTypes: [] },
    { ...legacy, visibilities: ["public"] },
    { scanStatus: "clean", processingStatus: "not_required" },
  ]) {
    assert.deepEqual(inspectLineUploadPolicy(input), {
      status: "unsupported_contract",
    });
  }
});

test("new source policy requires exact no-scan contract and per-MIME ceilings", () => {
  const p = {
    ...legacy,
    version: 2,
    readinessVersion: 2,
    sourceUploadRecoveryVersion: 1,
    securityProfile: "line-source-unscanned-v1",
    scanRequired: false,
    mimeMaxSizeBytes: {
      "image/jpeg": 10 * 1024 * 1024,
      "application/pdf": 25 * 1024 * 1024,
    },
  };
  assert.deepEqual(inspectLineUploadPolicy(p), { status: "source_ready" });
  for (const patch of [
    { sourceUploadRecoveryVersion: undefined },
    { sourceUploadRecoveryVersion: 2 },
    { scanRequired: true },
    { readinessVersion: 1 },
    { mimeMaxSizeBytes: {} },
    {
      mimeMaxSizeBytes: {
        "image/jpeg": 200 * 1024 * 1024,
        "application/pdf": 25 * 1024 * 1024,
      },
    },
  ])
    assert.equal(
      inspectLineUploadPolicy({ ...p, ...patch }).status,
      "unsupported_contract",
    );
});
