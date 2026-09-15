/** Existing data remains usable after an operator lowers the budget. */
export function checkStorageBudget(input: {
  area: "files" | "kv"; bytes: number; total: number; previous: number;
  items: number; exists: boolean; limits: { total: number; file: number };
}) {
  const { area, bytes, total, previous, items, exists, limits } = input;
  if (!Number.isSafeInteger(limits.total) || !Number.isSafeInteger(limits.file) || limits.total < 1 || limits.file < 1) return false;
  if (area === "kv" && !exists && items >= 1000) return false;
  // Only replacements that do not increase usage may exceed a lowered limit.
  if (exists && bytes <= previous) return true;
  return bytes <= limits.file && total - previous + bytes <= limits.total;
}
