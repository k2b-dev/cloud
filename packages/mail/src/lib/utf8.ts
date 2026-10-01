/** Shortens `value` to at most `maxBytes` UTF-8 bytes without splitting a character. */
export const truncateUtf8 = (value: string, maxBytes: number): string => {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maxBytes) return value;
  let end = maxBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
};
