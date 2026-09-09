/**
 * The `middleware` namespace bundles the request-lifecycle primitives
 * that every cloud app composes into its own router. Apps register
 * what they need; the framework no longer injects anything implicitly.
 *
 *   import { middleware, auth } from "@k2b/cloud/server"
 *
 *   const router = new Hono<AuthContext>()
 *     .use("*", middleware.logger())
 *     .use("*", middleware.runtime())     // for Layout / Sidebar / dashboard / search
 *     .use("*", middleware.settings())    // for c.get("settings")
 *     .use("*", middleware.ratelimit())
 *     .use(auth.requireRole("user"))
 *     .post(
 *       "/",
 *       middleware.validator("json", Schema),
 *       middleware.openapi({ tags: ["foo"], summary: "Create" }),
 *       handler,
 *     )
 *
 * `auth` lives separately because it has its own surface
 * (requireRole, redirectToLogin, session.*) and is conceptually
 * orthogonal to the request lifecycle.
 */
import { describeRoute } from "hono-openapi";
import { rateLimit } from "./rate-limit";
import { requestLogger } from "./request-logger";
import { routeTemplate } from "./route-template";
import { runtime } from "./runtime";
import { settings } from "./settings";
import { validator } from "./validator";

export const middleware = {
  /**
   * Live cluster registry on `c.get("runtime")`. Required for Layout/Sidebar.
   * Also reports the matched route template to gateway telemetry — you do not
   * need `observability()` on top of this.
   */
  runtime,
  /** Frozen per-request settings snapshot on `c.get("settings")`. */
  settings,
  /**
   * Reports the matched Hono route template to gateway telemetry, so the
   * admin telemetry page can break an app down per endpoint instead of
   * lumping every request under one registry prefix.
   *
   * **Only use this if you do NOT already use `middleware.runtime()`** —
   * `runtime()` does the same thing, and installing both just runs it twice.
   * Practically every app renders `<Layout>` and therefore needs `runtime()`
   * anyway; this exists for the rare app that serves an API surface only.
   *
   * ```ts
   * new Hono().use("*", middleware.observability())   // no runtime() here
   * ```
   */
  observability: () => routeTemplate,
  /** HTTP request logger (logs 5xx as error, 429 as warn, 401/403 as info). */
  logger: () => requestLogger,
  /** Sliding-window rate limiter, keyed by user id (auto fallback to IP). */
  ratelimit: rateLimit,
  /** Zod input validator. `c.req.valid(target)` is fully typed afterward. */
  validator,
  /** OpenAPI route metadata — re-export of hono-openapi's `describeRoute`. */
  openapi: describeRoute,
} as const;
