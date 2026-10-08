/**
 * Keys whose values are scrubbed from log and trace metadata before storage.
 * Match is case-insensitive and substring-based on the key (e.g. `apiKey`,
 * `accessToken`, `clientSecret` all trip).
 */
const SENSITIVE_KEY_PATTERN = /(password|secret|token|cookie|authorization|api[_-]?key|private[_-]?key|session)/i;

export const REDACTED = "[REDACTED]";

export const isSensitiveMetadataKey = (key: string): boolean => SENSITIVE_KEY_PATTERN.test(key);

export const redactMetadata = (input: unknown): unknown => {
  if (input === null || typeof input !== "object") return input;
  if (Array.isArray(input)) return input.map(redactMetadata);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    out[key] = isSensitiveMetadataKey(key) ? REDACTED : redactMetadata(value);
  }
  return out;
};

/**
 * Safe pathname for request logs and fallback route templates. Share URLs
 * carry bearer credentials, so collapse their entire suffix into one marker.
 * Match raw, case-sensitive segments and ignore empty segments, like the
 * gateway trie; percent-encoded token segments need no decoding.
 */
export const redactSensitivePath = (pathname: string): string => {
  const path = pathname.split(/[?#]/, 1)[0] ?? "";
  const segments = path.split("/").filter(Boolean);
  if (segments[0] === "share" && segments.length > 2) {
    return `/${segments.slice(0, 2).join("/")}/:token`;
  }
  if (
    segments.length > 3 &&
    segments[1] === "mail" &&
    ((segments[0] === "api" && segments[2] === "public-attachments") || (segments[0] === "app" && segments[2] === "a"))
  ) {
    return `/${segments.slice(0, 3).join("/")}/:token`;
  }
  return path;
};
