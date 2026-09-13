/**
 * Per-request middleware that exposes the live cluster registry on
 * `c.get("runtime")`. The first call to this middleware kicks off the
 * Redis registry watcher (idempotent); subsequent requests read from
 * the in-memory snapshot.
 *
 * Required by anything that renders the framework's `<Layout>`,
 * `<Sidebar>`, dashboard widget aggregator, or `Cmd+K` global search.
 */
import { createMiddleware } from "hono/factory";
import { ensureRuntimeWatcher, getCurrentRuntime } from "../../_internal/runtime-watcher";
import { measureServerPhase } from "../../_internal/server-timing";
import { routeTemplate } from "./route-template";

export const runtime = () =>
  createMiddleware(async (c, next) => {
    await measureServerPhase(c, "runtime", ensureRuntimeWatcher);
    (c as unknown as { set: (k: string, v: unknown) => void }).set("runtime", getCurrentRuntime());
    // Piggybacks on the middleware every proxied app already installs, so
    // gateway telemetry gets per-endpoint route templates without any app
    // having to opt in. See `middleware.observability()` for the rest.
    await routeTemplate(c, next);
  });
