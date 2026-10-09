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
 * The shared path rule redacts sensitive segments. This layer additionally
 * collapses numbers and bounds depth and cardinality so a path scanner cannot
 * inflate the telemetry table.
 */

const DIGITS = /^\d+$/;

/** Deeper paths add cardinality without adding meaning. */
const MAX_SEGMENTS = 8;

/** Distinct fallback templates retained per app before collapsing to `(other)`. */
const MAX_TEMPLATES_PER_APP = 200;

/** Bucket for anything beyond the per-app cardinality budget. */
export const OVERFLOW_TEMPLATE = "(other)";

/**
 * Collapses opaque segments in a pathname into placeholders.
 * Expects a pathname — never pass a full URL, the query string must not
 * reach telemetry.
 */
export const derivePathTemplate = (pathname: string): string => {
  const redacted = redactSensitivePath(pathname);
  const segments = redacted.split("/").filter(Boolean);
  if (segments.length === 0) return "/";

  const kept = segments.slice(0, MAX_SEGMENTS).map((segment) => (DIGITS.test(segment) ? ":n" : segment));
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
