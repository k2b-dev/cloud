type ByteRange = { start: number; endExclusive: number };

/**
 * Resolves one `Range` header against a body of `total` bytes: null without a header, the selected bytes for a
 * satisfiable single range, and "unsatisfiable" otherwise. Browsers play and seek video with these requests, and
 * Safari plays nothing from a server that ignores them.
 */
export const resolveByteRange = (value: string | null | undefined, total: number): ByteRange | null | "unsatisfiable" => {
  if (!value) return null;
  if (!Number.isSafeInteger(total) || total <= 0) return "unsatisfiable";
  const match = /^bytes=(\d*)-(\d*)$/i.exec(value.trim());
  if (!match || (!match[1] && !match[2])) return "unsatisfiable";

  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return "unsatisfiable";
    return { start: Math.max(0, total - suffixLength), endExclusive: total };
  }

  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : total - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) || requestedEnd < start || start >= total) {
    return "unsatisfiable";
  }
  return { start, endExclusive: Math.min(total, requestedEnd + 1) };
};
