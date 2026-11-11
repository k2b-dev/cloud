/** Decode a prefix strictly, allowing only an incomplete final UTF-8 sequence at the byte boundary. */
export function textExcerpt(bytes: Uint8Array, truncated: boolean): string | null {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: truncated });
    if (!truncated) return text;
    const end = text.lastIndexOf("\n");
    return end < 0 ? text : text.slice(0, end + 1);
  } catch {
    return null;
  }
}
