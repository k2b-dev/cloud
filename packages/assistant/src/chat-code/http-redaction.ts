import { LIMITS } from "./contracts";
import { HTTP_BYTES } from "./http-contracts";
import { CloudError } from "./runtime/errors";

type InsertedSecret = { value: string; sent: string };
/** Byte replacement preserves non-text response data. Longest matches win, including prefixes. */
export function redactSecrets<T extends { headers: Record<string, string>; body: Uint8Array }>(
  response: T,
  secrets: InsertedSecret[],
  maxBytes = HTTP_BYTES,
): Omit<T, "headers" | "body"> & { headers: Record<string, string>; body: Uint8Array } {
  const variants = [
    ...new Set(
      secrets.flatMap((secret) =>
        [secret.value, secret.sent].flatMap((value) =>
          value
            ? [
                value,
                Buffer.from(value).toString("base64"),
                Buffer.from(value).toString("base64url"),
                JSON.stringify(value).slice(1, -1),
                JSON.stringify(value).slice(1, -1).replaceAll("/", "\\/"),
                JSON.stringify(value)
                  .slice(1, -1)
                  .replace(/[\u0080-\uffff]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`),
                encodeURIComponent(value),
              ]
            : [],
        ),
      ),
    ),
  ].sort((a, b) => Buffer.byteLength(b) - Buffer.byteLength(a));
  const cleanHeaders = Object.fromEntries(Object.entries(response.headers).filter(([name]) => name.toLowerCase() !== "x-cloud-redacted"));
  if (!variants.length) return { ...response, headers: cleanHeaders };
  const patterns = variants.map((value) => Buffer.from(value));
  const replacement = Buffer.from("[REDACTED]");
  let redacted = false;
  const replace = (input: Uint8Array, budget: number) => {
    const source = Buffer.from(input);
    const match = (offset: number) =>
      patterns.find((pattern) => source[offset] === pattern[0] && source.subarray(offset, offset + pattern.length).equals(pattern));
    // Count first: no array proportional to matches, and no allocation beyond the response budget.
    let length = source.length;
    for (let i = 0; i < source.length; ) {
      const found = match(i);
      if (!found) {
        i++;
        continue;
      }
      redacted = true;
      length += replacement.length - found.length;
      if (length > budget) throw new CloudError("limit", "The redacted response exceeds the HTTP size budget; request a smaller response.");
      i += found.length;
    }
    if (length > budget) throw new CloudError("limit", "The response exceeds the HTTP size budget; request a smaller response.");
    const output = Buffer.alloc(length);
    let offset = 0;
    for (let i = 0; i < source.length; ) {
      const found = match(i);
      if (!found) {
        output[offset++] = source[i++]!;
        continue;
      }
      output.set(replacement, offset);
      offset += replacement.length;
      i += found.length;
    }
    return output;
  };
  const headers = Object.fromEntries(
    Object.entries(cleanHeaders).map(([name, value]) => [name, replace(Buffer.from(value), LIMITS.text).toString("utf8")]),
  );
  const body = replace(response.body, maxBytes);
  if (redacted) {
    headers["x-cloud-redacted"] = "secret";
    for (const name of Object.keys(headers)) if (name.toLowerCase() === "content-length") delete headers[name];
  }
  if (Buffer.byteLength(JSON.stringify(headers)) > LIMITS.text)
    throw new CloudError("limit", "The redacted headers exceed the HTTP size budget.");
  return { ...response, headers, body };
}
