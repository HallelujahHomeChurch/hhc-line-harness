// Asset owns these opaque path identifiers; never normalize them as UUIDs.
export const isAssetId = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,255}$/.test(value);
