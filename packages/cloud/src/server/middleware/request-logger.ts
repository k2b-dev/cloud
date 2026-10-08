import { createMiddleware } from "hono/factory";
import { logger } from "../../services/logging";
import { redactSensitivePath } from "../../services/logging/redaction";
import type { AuthContext } from "./auth";

const log = logger("http");

const SKIP_PREFIXES = ["/public/", "/_ssr/", "/favicon", "/branding/"];

/**
 * HTTP request logging middleware.
 * Logs to DB based on response status:
 * - 5xx → error (server errors)
 * - 429 → warn (rate limiting)
 * - 401/403 → info (auth flows)
 * - Everything else (2xx, 3xx, 400, 404) → not logged (too noisy)
 */
export const requestLogger = createMiddleware<AuthContext>(async (c, next) => {
  const requestPath = c.req.path;
  if (SKIP_PREFIXES.some((p) => requestPath.startsWith(p))) return next();

  const path = redactSensitivePath(requestPath);
  const start = Date.now();
  await next();
  const status = c.res.status;
  const duration = Date.now() - start;

  const meta = {
    method: c.req.method,
    path,
    status,
    duration,
    userId: c.get("user")?.id ?? null,
  };

  if (status >= 500) {
    log.error(`${c.req.method} ${path} ${status}`, meta);
  } else if (status === 429) {
    log.warn(`${c.req.method} ${path} 429 rate-limited`, meta);
  } else if (status === 401 || status === 403) {
    log.info(`${c.req.method} ${path} ${status}`, meta);
  }
});
