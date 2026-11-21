/** A source's last rejection reason is diagnostic text; it never grows with the refused body. */
export const REJECTION_REASON_MAX_LENGTH = 300;

/** Field names of the public ingest batch. Any other path segment comes from the sender (a record key) and is masked. */
const BATCH_FIELDS = new Set([
  "metrics",
  "events",
  "states",
  "name",
  "value",
  "ts",
  "unit",
  "type",
  "sourceId",
  "resource",
  "id",
  "label",
  "kind",
  "key",
  "actorId",
  "sessionId",
  "correlationId",
  "dimensions",
  "attributes",
  "sensitive",
  "payload",
]);

/** A Standard Schema issue; Zod adds the fields after `path`, which name schema rules and never sender values. */
export type RejectionIssue = {
  readonly message: string;
  readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }>;
  readonly code?: unknown;
  readonly expected?: unknown;
  readonly origin?: unknown;
  readonly maximum?: unknown;
  readonly minimum?: unknown;
  readonly format?: unknown;
};

const bounded = (reason: string): string =>
  reason.length > REJECTION_REASON_MAX_LENGTH ? `${reason.slice(0, REJECTION_REASON_MAX_LENGTH - 1)}…` : reason;

const issuePath = (path: RejectionIssue["path"]): string =>
  (path ?? []).reduce<string>((text, raw) => {
    const segment = typeof raw === "object" && raw !== null && "key" in raw ? raw.key : raw;
    if (typeof segment === "number") return `${text}[${segment}]`;
    const name = typeof segment === "string" && BATCH_FIELDS.has(segment) ? segment : "*";
    return text ? `${text}.${name}` : name;
  }, "");

const word = (value: unknown): string | null => (typeof value === "string" && /^[a-z_]{1,32}$/.test(value) ? value : null);
const limit = (value: unknown): string | null => (typeof value === "number" || typeof value === "bigint" ? String(value) : null);
const unit = (origin: unknown): string => (origin === "array" ? " items" : origin === "string" ? " characters" : "");

/** Phrases come from the issue code and schema limits only; a built-in Zod message can quote sender keys. */
const issuePhrase = (issue: RejectionIssue): string => {
  switch (issue.code) {
    case "invalid_type": {
      const expected = word(issue.expected);
      if (expected === "never") return "field not allowed";
      return expected ? `expected ${expected}` : "invalid type";
    }
    case "too_big": {
      const maximum = limit(issue.maximum);
      return maximum ? `at most ${maximum}${unit(issue.origin)}` : "too big";
    }
    case "too_small": {
      const minimum = limit(issue.minimum);
      if (minimum === "1" && issue.origin === "string") return "must not be empty";
      return minimum ? `at least ${minimum}${unit(issue.origin)}` : "too small";
    }
    case "invalid_format": {
      const format = word(issue.format);
      return format ? `invalid ${format}` : "invalid format";
    }
    case "invalid_value":
      return "not an allowed value";
    case "unrecognized_keys":
      return "unknown field";
    case "invalid_union":
      return "does not match an allowed type";
    case "not_multiple_of":
      return "not an allowed step";
    // Pulse's own refinements describe limits in constant text.
    case "custom":
      return redactRefusalMessage(issue.message);
    default:
      return "invalid value";
  }
};

/** The first failing path of a refused batch in words, for example `events[3].attributes: expected object`. */
export const schemaRejectionReason = (issues: readonly RejectionIssue[]): string => {
  const [issue] = issues;
  if (!issue) return "Invalid ingest batch";
  const path = issuePath(issue.path);
  return bounded(path ? `${path}: ${issuePhrase(issue)}` : issuePhrase(issue));
};

/**
 * Service refusal messages name metric names, kinds, keys, or timestamps from the batch.
 * Quoted text, ISO timestamps, and the unquoted metric of a series-limit refusal are masked.
 */
export const redactRefusalMessage = (message: string): string =>
  message
    .replace(/"[^"]*"|“[^”]*”|„[^“”]*[“”]/g, "“…”")
    .replace(/\d{4}-\d{2}-\d{2}T[0-9:.]+(?:Z|[+-]\d{2}:?\d{2})?/g, "…")
    .replace(/^Metric .+? exceeds the limit/s, "Metric … exceeds the limit");

export const serviceRejectionReason = (message: string): string => bounded(redactRefusalMessage(message));
