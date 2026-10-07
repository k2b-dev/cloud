type ByteRange = { start: number; endExclusive: number };

/**
 * Resolves a `Range` header against a body of `total` bytes. A header that is not exactly one well-formed byte range,
 * such as another unit or several ranges, counts as no header (RFC 9110, section 14.2): null, and the whole body
 * answers. One range selects its bytes, clamped to the body, or is "unsatisfiable" when it selects none. Browsers play
 * and seek video with these requests, and Safari plays nothing from a server that ignores them.
 */
export const resolveByteRange = (value: string | null | undefined, total: number): ByteRange | null | "unsatisfiable" => {
  const match = value ? /^bytes=(\d*)-(\d*)$/i.exec(value.trim()) : null;
  if (!match || (!match[1] && !match[2])) return null;
  // Positions beyond the safe integers lie past any body; as numbers they still compare that way.
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (suffixLength === 0 || total <= 0) return "unsatisfiable";
    return { start: Math.max(0, total - suffixLength), endExclusive: total };
  }
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : Number.POSITIVE_INFINITY;
  if (end < start) return null;
  if (start >= total) return "unsatisfiable";
  return { start, endExclusive: Math.min(total, end + 1) };
};
