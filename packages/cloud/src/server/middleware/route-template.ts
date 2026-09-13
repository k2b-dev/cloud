/**
 * Publishes the app's matched Hono route template to the gateway.
 *
 * Gateway telemetry only knows the registry prefix it routed on
 * (`/api/mail`), so every endpoint of an app collapses into one bucket —
 * enough to see that an app is failing, never enough to see which
 * endpoint. The app itself already knows the exact answer: after the
 * handler ran, `routePath(c)` resolves to the registered pattern
 * (`/api/mail/mailboxes/:mailboxId`).
 *
 * We hand it to the gateway in a response header. The gateway reads it
 * off the upstream response next to status and duration — which it
 * already sources the same way — and strips it before the client sees
 * it. No second telemetry pipeline, no path guessing.
 *
 * Templates only: the request path itself never leaves the app, so ids
 * and query strings stay out of telemetry by construction.
 */

import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { routePath } from "hono/route";
import { ROUTE_TEMPLATE_HEADER } from "../../services/gateway";

/** Hono's placeholder when nothing matched (404) — carries no information. */
const UNMATCHED = "/*";

const MAX_TEMPLATE_LENGTH = 200;

/**
 * Hono allows a regex constraint on a param (`:filename{.+\.js$}`). It is part
 * of the pattern but noise in an ops table, and it can carry characters that
 * are awkward in a header value, so only the param name is reported.
 */
const stripParamConstraints = (template: string): string => template.replace(/\{[^}]*\}/g, "");

export const matchedRouteTemplate = (c: Context): string | null => {
  const template = routePath(c);
  return !template || template === UNMATCHED ? null : stripParamConstraints(template).slice(0, MAX_TEMPLATE_LENGTH);
};

export const routeTemplate = createMiddleware(async (c, next) => {
  await next();

  // Best-effort: telemetry enrichment must never break a response.
  try {
    const template = matchedRouteTemplate(c);
    if (template) c.res.headers.set(ROUTE_TEMPLATE_HEADER, template);
  } catch {
    // Immutable response headers or an unrouted context — nothing to report.
  }
});
