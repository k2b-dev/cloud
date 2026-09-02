import { routes } from "@k2b/ssr/hono";
import { type AuthContext, auth, getLocale, middleware } from "@valentinkolb/cloud/server";
import { type Context, Hono } from "hono";
import { serveStatic } from "hono/bun";
import { apiRoutes } from "./api";
import { app } from "./config";
import gatewayPage from "./frontend/page";
import { gatewayOpsHelp } from "./help";
import { gatewayOpsLifecycle } from "./lifecycle";
import { gatewayOpsApiErrorMessage } from "./messages";
import alertsPage from "./observability/alerts/page";
import { runScheduleNowAction } from "./observability/jobs/actions";
import jobsApiRoutes from "./observability/jobs/api";
import jobsPage from "./observability/jobs/page";
import loggingApiRoutes from "./observability/logs/api";
import logsPage from "./observability/logs/page";
import loggingWidgetRoutes, { loggingErrorsWidgetHandler } from "./observability/logs/widgets";
import { metricsEndpoint } from "./observability/metrics/endpoint";
import metricsPage from "./observability/metrics/page";
import notificationsApiRoutes from "./observability/notifications/api";
import notificationsPage from "./observability/notifications/page";
import observabilityOverviewPage from "./observability/page";
import postgresPage from "./observability/postgres/page";
import redisPage from "./observability/redis/page";
import telemetryApiRoutes from "./observability/telemetry/api";
import telemetryPage from "./observability/telemetry/page";
import workflowsApiRoutes from "./observability/workflows/api";
import workflowsPage from "./observability/workflows/page";
import { gatewayHealthWidgetHandler, widgetRoutes } from "./widgets";

const localizeApiError = async (c: Context, next: () => Promise<void>) => {
  await next();
  if (c.res.status < 400 || !c.res.headers.get("content-type")?.includes("application/json")) return;
  const body: unknown = await c.res
    .clone()
    .json()
    .catch(() => null);
  if (!body || typeof body !== "object" || !("message" in body) || typeof body.message !== "string") return;
  const headers = new Headers(c.res.headers);
  headers.delete("content-length");
  c.res = new Response(JSON.stringify({ ...body, message: gatewayOpsApiErrorMessage(c.res.status, getLocale(c), body.message) }), {
    status: c.res.status,
    statusText: c.res.statusText,
    headers,
  });
};

const router = new Hono<AuthContext>()
  .use("*", middleware.runtime())
  .use("*", middleware.settings())
  .route("/admin/gateway/_ssr", routes(app.config))
  .use(
    "/public/*",
    serveStatic({
      root: "./",
      onFound: (_path, c) => {
        c.header("Cache-Control", "public, max-age=31536000, immutable");
      },
    }),
  )
  .get("/admin/gateway", (c) => c.redirect("/admin/gateway/apps"))
  .get("/admin/gateway/apps", auth.requireRole("admin", auth.redirectToLogin), ...gatewayPage)
  .get("/admin/gateway/routes", auth.requireRole("admin", auth.redirectToLogin), ...gatewayPage)
  .get("/admin/observability", auth.requireRole("admin", auth.redirectToLogin), ...observabilityOverviewPage)
  .get("/admin/observability/logs", auth.requireRole("admin", auth.redirectToLogin), ...logsPage)
  .get("/admin/observability/jobs", auth.requireRole("admin", auth.redirectToLogin), ...jobsPage)
  .post("/admin/observability/jobs/run-now", auth.requireRole("admin", auth.redirectToLogin), runScheduleNowAction)
  .get("/admin/observability/telemetry", auth.requireRole("admin", auth.redirectToLogin), ...telemetryPage)
  .get("/admin/observability/workflows", auth.requireRole("admin", auth.redirectToLogin), ...workflowsPage)
  .get("/admin/observability/metrics", auth.requireRole("admin", auth.redirectToLogin), ...metricsPage)
  .get("/admin/observability/data", auth.requireRole("admin", auth.redirectToLogin), (c) => c.redirect("/admin/observability/postgres"))
  .get("/admin/observability/postgres", auth.requireRole("admin", auth.redirectToLogin), ...postgresPage)
  .get("/admin/observability/redis", auth.requireRole("admin", auth.redirectToLogin), ...redisPage)
  .get("/admin/observability/alerts", auth.requireRole("admin", auth.redirectToLogin), ...alertsPage)
  .get("/admin/observability/notifications", auth.requireRole("admin", auth.redirectToLogin), ...notificationsPage)
  .get("/metrics", auth.requireRole("*"), metricsEndpoint)
  .use("/api/*", localizeApiError)
  .route("/api/gateway/widget", widgetRoutes)
  .route("/api/logging/widget", loggingWidgetRoutes)
  .route("/api/logging", loggingApiRoutes)
  .route("/api/notifications", notificationsApiRoutes)
  // Mounted ahead of the general gateway router, which still owns the older
  // telemetry summary/apps/events routes.
  .route("/api/gateway/telemetry", telemetryApiRoutes)
  .route("/api/gateway/jobs", jobsApiRoutes)
  .route("/api/gateway/workflows", workflowsApiRoutes)
  .route("/api/gateway", apiRoutes);

export default await app.start({
  fetch: router.fetch,
  help: gatewayOpsHelp,
  openapi: apiRoutes,
  widgets: { health: gatewayHealthWidgetHandler, errors: loggingErrorsWidgetHandler },
  lifecycle: gatewayOpsLifecycle,
});

export type { ApiType } from "./api";
