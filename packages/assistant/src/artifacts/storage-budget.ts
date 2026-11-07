/** Existing data remains usable after an operator lowers the budget. */
export function checkStorageBudget(input: {
  area: "files" | "kv";
  bytes: number;
  /** PostgreSQL size of the file key/media-type metadata record; payload is separate. */
  metadataBytes: number;
  /** Current and replaced quota charges, including file metadata. */
  total: number;
  previous: number;
  previousBytes: number;
  items: number;
  exists: boolean;
  limits: { total: number; file: number };
}) {
  const { area, bytes, metadataBytes, total, previous, items, exists, limits, previousBytes } = input;
  if (!Number.isSafeInteger(limits.total) || !Number.isSafeInteger(limits.file) || limits.total < 1 || limits.file < 1) return false;
  if (area === "kv" && !exists && items >= 1000) return false;
  if (area === "files" && (!Number.isSafeInteger(metadataBytes) || metadataBytes < 1)) return false;
  const charge = bytes + (area === "files" ? metadataBytes : 0);
  // Each lowered limit permits replacements only when its own usage does not grow.
  if (bytes > limits.file && (!exists || bytes > previousBytes)) return false;
  return (exists && charge <= previous) || total - previous + charge <= limits.total;
}
