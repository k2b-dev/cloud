import { redactSensitivePath } from "@k2b/cloud/services";

/**
 * Fallback route templating for requests the app never answered.
 *
 * The accurate source of a route template is the app itself — it reports
 * the pattern Hono matched via `X-Route-Template`. That only exists when
 * there *was* an upstream response, which leaves two cases uncovered:
 * unmatched routes (no app to ask) and upstream failures (the request
 * died in flight). Both are exactly the cases worth investigating, so we
 * derive a template from the path instead of dropping it.
 *
 * A heuristic cannot beat the app's own answer, and it is not meant to:
 * real routes carry params that look nothing like ids (`/help/:topic`,
 * `/hostgroups/:cn`, `/admin/settings/:key`). We therefore collapse only
 * segments that are unmistakably opaque and keep everything else, then
 * bound the result so a path scanner cannot inflate the telemetry table.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DIGITS = /^\d+$/;
const OPAQUE_TOKEN = /^[A-Za-z0-9_-]+$/;

/** Shortest string we treat as an opaque token rather than a readable slug. */
const MIN_TOKEN_LENGTH = 16;

/** Deeper paths add cardinality without adding meaning. */
const MAX_SEGMENTS = 8;

/** Distinct fallback templates retained per app before collapsing to `(other)`. */
const MAX_TEMPLATES_PER_APP = 200;

/** Bucket for anything beyond the per-app cardinality budget. */
export const OVERFLOW_TEMPLATE = "(other)";

/**
 * A segment is opaque when it cannot plausibly be a human-authored slug:
 * a UUID, a bare number, or a long id-ish string containing a digit.
 * The digit requirement keeps `getting-started-with-grids` intact, and
 * rejecting dots keeps filenames like `tabler-icons.woff2` intact.
 */
const isOpaqueSegment = (segment: string): boolean => {
  if (UUID.test(segment)) return true;
  if (DIGITS.test(segment)) return true;
  return segment.length >= MIN_TOKEN_LENGTH && OPAQUE_TOKEN.test(segment) && /\d/.test(segment);
};

const placeholderFor = (segment: string): string => {
  if (UUID.test(segment)) return ":id";
  if (DIGITS.test(segment)) return ":n";
  return ":token";
};

/**
 * Collapses opaque segments in a pathname into placeholders.
 * Expects a pathname — never pass a full URL, the query string must not
 * reach telemetry.
 */
export const derivePathTemplate = (pathname: string): string => {
  const redacted = redactSensitivePath(pathname);
  // The shared rule already produced a bounded template; keep its app prefix.
  if (redacted.endsWith("/:token")) return redacted;
  const segments = redacted.split("/").filter(Boolean);
  if (segments.length === 0) return "/";

  const kept = segments.slice(0, MAX_SEGMENTS).map((segment) => (isOpaqueSegment(segment) ? placeholderFor(segment) : segment));
  if (segments.length > MAX_SEGMENTS) kept.push("...");

  return `/${kept.join("/")}`;
};

/**
 * Per-app cardinality budget for derived templates.
 *
 * App-reported templates are inherently bounded — they come from a fixed
 * route table — so only the derived ones need a ceiling. Instance-local
 * and approximate by design: the goal is to stop a scanner from writing a
 * million distinct rows, not to agree across gateway replicas.
 */
const seenTemplates = new Map<string, Set<string>>();

export const boundTemplateCardinality = (appId: string, template: string): string => {
  let seen = seenTemplates.get(appId);
  if (!seen) {
    seen = new Set();
    seenTemplates.set(appId, seen);
  }
  if (seen.has(template)) return template;
  if (seen.size >= MAX_TEMPLATES_PER_APP) return OVERFLOW_TEMPLATE;
  seen.add(template);
  return template;
};

/** Test seam — the budget is process-lifetime state otherwise. */
export const resetTemplateCardinality = (): void => {
  seenTemplates.clear();
};
