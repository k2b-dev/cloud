import { type AuthContext, auth, getLocale, middleware } from "@k2b/cloud/server";
import { withObservabilityRead } from "@k2b/cloud/services";
import { routes } from "@k2b/ssr/hono";
import { type Context, Hono } from "hono";
import { serveStatic } from "hono/bun";
import { apiRoutes } from "./api";
import { app, ssr } from "./config";
import gatewayPage from "./frontend/page";
import { gatewayOpsApiErrorMessage } from "./messages";
import capabilitiesApiRoutes from "./observability/capabilities/api";
import capabilitiesPage from "./observability/capabilities/page";
import infrastructureApiRoutes from "./observability/infrastructure/api";
import infrastructurePage from "./observability/infrastructure/page";
import { runScheduleNowAction } from "./observability/jobs/actions";
import jobsApiRoutes from "./observability/jobs/api";
import loggingApiRoutes from "./observability/logs/api";
import logsPage from "./observability/logs/page";
import loggingWidgetRoutes from "./observability/logs/widgets";
import { metricsEndpoint } from "./observability/metrics/endpoint";
import metricsPage from "./observability/metrics/page";
import natsAccessPage from "./observability/nats/access-page";
import natsApiRoutes from "./observability/nats/api";
import natsPage from "./observability/nats/page";
import notificationsApiRoutes from "./observability/notifications/api";
import notificationsPage from "./observability/notifications/page";
import observabilityOverviewPage from "./observability/page";
import postgresPage from "./observability/postgres/page";
import redisPage from "./observability/redis/page";
import runsApiRoutes from "./observability/runs/api";
import { legacyDeliveriesHref, legacyJobsHref } from "./observability/runs/legacy";
import runsPage from "./observability/runs/page";
import { alertsPage, healthCheckPage, retentionPage } from "./observability/settings/page";
import syncApiRoutes from "./observability/sync/api";
import syncPage from "./observability/sync/page";
import telemetryApiRoutes from "./observability/telemetry/api";
import telemetryPage from "./observability/telemetry/page";
import workflowsApiRoutes from "./observability/workflows/api";
import workflowsPage from "./observability/workflows/page";
import { widgetRoutes } from "./widgets";

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

/** A page that moved: the old address leads to the new one with its whole query. */
const moved = (path: string) => (c: Context) => c.redirect(`${path}${new URL(c.req.url).search}`, 302);

export const router = new Hono<AuthContext>()
  .use("*", (c, next) => (c.req.method === "GET" || c.req.method === "HEAD" ? withObservabilityRead(c.req.raw.signal, next) : next()))
  .use("/admin/observability/runs", middleware.noTransform())
  .use("/admin/observability/runs/*", middleware.noTransform())
  .use("/admin/observability/jobs", middleware.noTransform())
  .use("/admin/observability/jobs/*", middleware.noTransform())
  .use("/admin/observability/nats/sync", middleware.noTransform())
  .use("/admin/observability/nats/sync/*", middleware.noTransform())
  .use("/admin/observability/logs", middleware.noTransform())
  .use("/admin/observability/logs/*", middleware.noTransform())
  .use("/admin/observability/workflows", middleware.noTransform())
  .use("/admin/observability/workflows/*", middleware.noTransform())
  .use("/admin/observability/capabilities", middleware.noTransform())
  .use("/admin/observability/capabilities/*", middleware.noTransform())
  .use("/admin/observability/deliveries", middleware.noTransform())
  .use("/admin/observability/deliveries/*", middleware.noTransform())
  .use("*", middleware.runtime())
  .use("*", middleware.settings())
  .route("/admin/observability/_ssr", routes(app.config))
  .all("/admin/observability/_ssr/*", (c) => c.notFound())
  .use(
    "/public/*",
    serveStatic({
      root: "./",
      onFound: (_path, c) => {
        c.header("Cache-Control", "public, max-age=31536000, immutable");
      },
    }),
  )
  // The apps table moved to Administration › Apps; the old address lands there with a short hint.
  .get("/admin/observability/gateway", auth.requireRole("admin", ssr.access), (c) => c.redirect("/admin/apps?moved=gateway", 302))
  .get("/admin/observability/gateway/routes", auth.requireRole("admin", ssr.access), ...gatewayPage)
  .get("/admin/observability", auth.requireRole("admin", ssr.access), ...observabilityOverviewPage)
  .get("/admin/observability/logs", auth.requireRole("admin", ssr.access), ...logsPage)
  .get("/admin/observability/runs", auth.requireRole("admin", ssr.access), ...runsPage)
  // Jobs became the runs list; its address keeps its filters there.
  .get("/admin/observability/jobs", auth.requireRole("admin", ssr.access), (c) =>
    c.redirect(legacyJobsHref(new URL(c.req.url).searchParams), 302),
  )
  .post("/admin/observability/jobs/run-now", auth.requireRole("admin", ssr.access), runScheduleNowAction)
  .get("/admin/observability/telemetry", auth.requireRole("admin", ssr.access), ...telemetryPage)
  .get("/admin/observability/workflows", auth.requireRole("admin", ssr.access), ...workflowsPage)
  .get("/admin/observability/capabilities", auth.requireRole("admin", ssr.access), ...capabilitiesPage)
  .get("/admin/observability/metrics", auth.requireRole("admin", ssr.access), ...metricsPage)
  .get("/admin/observability/infrastructure", auth.requireRole("admin", ssr.access), ...infrastructurePage)
  .get("/admin/observability/infrastructure/postgres", auth.requireRole("admin", ssr.access), ...postgresPage)
  .get("/admin/observability/infrastructure/valkey", auth.requireRole("admin", ssr.access), ...redisPage)
  .get("/admin/observability/infrastructure/nats", auth.requireRole("admin", ssr.access), ...natsPage)
  .get("/admin/observability/infrastructure/nats-access", auth.requireRole("admin", ssr.access), ...natsAccessPage)
  // Postgres, Valkey, NATS and its access became areas of the infrastructure record; old addresses keep their query.
  .get("/admin/observability/postgres", auth.requireRole("admin", ssr.access), moved("/admin/observability/infrastructure/postgres"))
  .get("/admin/observability/valkey", auth.requireRole("admin", ssr.access), moved("/admin/observability/infrastructure/valkey"))
  .get("/admin/observability/nats", auth.requireRole("admin", ssr.access), moved("/admin/observability/infrastructure/nats"))
  .get("/admin/observability/nats/access", auth.requireRole("admin", ssr.access), moved("/admin/observability/infrastructure/nats-access"))
  .get("/admin/observability/nats/sync", auth.requireRole("admin", ssr.access), ...syncPage)
  // Deliveries are runs now; the notification definitions and earlier notifications stay on this page.
  .get(
    "/admin/observability/deliveries",
    auth.requireRole("admin", ssr.access),
    async (c, next) => {
      const target = legacyDeliveriesHref(new URL(c.req.url).searchParams);
      if (target) return c.redirect(target, 302);
      await next();
    },
    ...notificationsPage,
  )
  .get("/admin/observability/settings", auth.requireRole("admin", ssr.access), ...alertsPage)
  .get("/admin/observability/settings/health-check", auth.requireRole("admin", ssr.access), ...healthCheckPage)
  .get("/admin/observability/settings/retention", auth.requireRole("admin", ssr.access), ...retentionPage)
  // Alerts, the health check and retention became areas of the settings record; old addresses keep their query.
  .get("/admin/observability/alerts", auth.requireRole("admin", ssr.access), moved("/admin/observability/settings"))
  .get("/admin/observability/health-check", auth.requireRole("admin", ssr.access), moved("/admin/observability/settings/health-check"))
  .get("/admin/observability/retention", auth.requireRole("admin", ssr.access), moved("/admin/observability/settings/retention"))
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
  .route("/api/gateway/sync", syncApiRoutes)
  .route("/api/gateway/nats", natsApiRoutes)
  .route("/api/gateway/infrastructure", infrastructureApiRoutes)
  .route("/api/gateway/workflows", workflowsApiRoutes)
  .route("/api/gateway/runs", runsApiRoutes)
  .route("/api/gateway/capabilities", capabilitiesApiRoutes)
  .route("/api/gateway", apiRoutes);

router.get("/admin/observability/*", auth.requireRole("*"), (c) => ssr.error(c, 404));
