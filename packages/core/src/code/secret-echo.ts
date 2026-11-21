/** Redact raw, prefixed, JSON-escaped, percent-encoded and base64 echoes before any response or observation is constructed.
 * This is bounded byte replacement, preserving binary responses. Remote services must still be trusted with the credential they receive.
 */
export function secretEchoReplacements(inserted: readonly { name: string; value: string; sent: string }[]) {
  const replacements = new Map<string, string>();
  for (const { name, value, sent } of inserted) {
    for (const text of new Set(
      [value, sent].flatMap((text) => [
        text,
        Buffer.from(text).toString("base64"),
        Buffer.from(text).toString("base64url"),
        encodeURIComponent(text),
        JSON.stringify(text).slice(1, -1),
        JSON.stringify(text).slice(1, -1).replaceAll("/", "\\/"),
      ]),
    ))
      if (text) replacements.set(text, `[secret:${name}]`);
  }
  return replacements;
}
