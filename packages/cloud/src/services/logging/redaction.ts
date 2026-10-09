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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CREDENTIAL = /^[A-Za-z0-9_-]{16,}$/;
const WORD_SLUG = /^[a-z]+(?:[-_][a-z]+)*$/;

const decodeSegment = (segment: string): string => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
};

/**
 * Redact a pathname for logs and fallback templates; drop queries and fragments.
 * Compare safely decoded, case-sensitive prefixes, ignoring empty segments.
 * Collapse the suffix below /share/<app>/ (keeping the raw app segment),
 * /api/mail/public-attachments/, and /app/mail/a/ into one :token marker.
 * Elsewhere, use a shape heuristic: decoded UUID segments become :id; a segment
 * becomes :token if its decoded value or any dot-separated part has at least
 * 16 characters, only A-Z, a-z, 0-9, _ or -, and is not a lowercase word slug
 * (words separated by single hyphens or underscores). Preserve other raw segments.
 * This keeps readable params and filenames while covering tokens with file suffixes.
 */
export const redactSensitivePath = (pathname: string): string => {
  const path = pathname.split(/[?#]/, 1)[0] ?? "";
  const segments = path.split("/").filter(Boolean);
  const decoded = segments.map(decodeSegment);
  if (decoded[0] === "share" && segments.length > 2) {
    return `/share/${segments[1]}/:token`;
  }
  if (
    segments.length > 3 &&
    decoded[1] === "mail" &&
    ((decoded[0] === "api" && decoded[2] === "public-attachments") || (decoded[0] === "app" && decoded[2] === "a"))
  ) {
    return `/${decoded.slice(0, 3).join("/")}/:token`;
  }
  return path
    .split("/")
    .map((segment) => {
      const value = decodeSegment(segment);
      if (UUID.test(value)) return ":id";
      // Dot-separated parts cover signed tokens and credential filenames such as .ics.
      // Lowercase word slugs preserve readable routes like getting-started-with-grids.
      if (value.split(".").some((part) => CREDENTIAL.test(part) && !WORD_SLUG.test(part))) return ":token";
      return segment;
    })
    .join("/");
};
