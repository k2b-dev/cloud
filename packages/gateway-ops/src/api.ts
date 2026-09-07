import { err, fail, ok } from "@k2b/stdlib";
import { listApps } from "@valentinkolb/cloud";
import { type AuthContext, auth, getLocale, rateLimit, respond, v } from "@valentinkolb/cloud/server";
import {
  latestGatewayRouteSnapshot,
  settingsDeleteLegacyKeys,
  settingsListLegacyKeys,
  settingsService,
} from "@valentinkolb/cloud/services";
import { Hono } from "hono";
import { z } from "zod";
import { buildGatewayHealth } from "./health";
import {
  createHealthWebhook,
  deleteHealthWebhook,
  getHealthWebhook,
  type HealthWebhookInput,
  HealthWebhookInputError,
  listHealthWebhooks,
  testHealthWebhook,
  updateHealthWebhook,
} from "./health-webhooks";
import { updateHealthSchedule } from "./lifecycle";
import { gatewayOpsMessages } from "./messages";
import {
  getDataDiagnostics,
  getPostgresDiagnostics,
  getRedisDiagnostics,
  listPostgresIndexes,
  listPostgresSessions,
} from "./observability/data/service";
import { metricsApiRoutes } from "./observability/metrics/api";
import { TELEMETRY_RANGES, type TelemetryRange } from "./observability/telemetry/contracts";
import { getTelemetryPrefixTotals } from "./observability/telemetry/service";
import { removeOfflineRegisteredApp } from "./registered-apps";
import { getTelemetrySummary, listTelemetryApps, listTelemetryEvents } from "./telemetry";

const GATEWAY_SETTING_GROUP = "gateway";
const GATEWAY_SETTING_PREFIX = "gateway.";

const UpdateSettingSchema = z.object({ value: z.unknown() });
const HealthWebhookIdParamSchema = z.object({ id: z.uuid() });
const QueryBooleanSchema = z
  .string()
  .optional()
  .transform((value) => value === "1" || value === "true");
const TelemetryEventsQuerySchema = z.object({
  search: z.string().optional(),
  app: z.string().optional(),
  route: z.string().optional(),
  slow: QueryBooleanSchema,
  errors: QueryBooleanSchema,
  hours: z.coerce
    .number()
    .int()
    .min(1)
    .max(24 * 31)
    .optional(),
  page: z.coerce.number().int().min(1).optional(),
  per_page: z.coerce.number().int().min(1).max(200).optional(),
});
const TelemetrySummaryQuerySchema = z.object({
  hours: z.coerce
    .number()
    .int()
    .min(1)
    .max(24 * 31)
    .optional(),
});
const GatewayRoutesQuerySchema = z.object({
  search: z.string().optional(),
  app: z.string().optional(),
  errors: QueryBooleanSchema,
  sort: z.enum(["count", "prefix", "errors"]).optional(),
  range: z.enum(Object.keys(TELEMETRY_RANGES) as [string, ...string[]]).default("24h"),
});
const HealthWebhookInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  url: z.string().trim().min(1).max(2_000),
  method: z.enum(["GET", "POST"]),
  enabled: z.boolean(),
  scopeKind: z.enum(["all", "include", "exclude"]),
  scopeAppIds: z.array(z.string().trim().min(1).max(200)).max(200),
  sendOn: z.array(z.enum(["ok", "warn", "error", "recovery", "every_check"])),
  minStatus: z.enum(["ok", "warn", "error"]),
  repeatIntervalMs: z.number().int().min(60_000).max(2_592_000_000),
  timeoutMs: z.number().int().min(1_000).max(30_000),
}) satisfies z.ZodType<HealthWebhookInput>;

const liveSettingKeys = async () => (await listApps()).flatMap((app) => [...(app.settingKeys ?? [])]);

const healthWebhookInputError = (c: Parameters<typeof getLocale>[0], error: unknown): string => {
  const { t } = gatewayOpsMessages.resolve([getLocale(c)]);
  if (error instanceof HealthWebhookInputError) {
    return error.code === "url_protocol" ? t.webhookUrlProtocol : t.webhookNameRequired;
  }
  return t.apiInvalidRequest;
};

export const apiRoutes = new Hono<AuthContext>()
  .use(rateLimit())
  .use(auth.requireRole("admin"))
  .route("/metrics", metricsApiRoutes)
  .delete("/apps/:id", async (c) => {
    const id = c.req.param("id");
    return respond(c, removeOfflineRegisteredApp(id, await listApps()));
  })
  .get("/settings", async (c) => {
    const result = await settingsService.entry.list({ filter: { group: GATEWAY_SETTING_GROUP }, locale: getLocale(c) });
    return respond(c, ok(result.items));
  })
  // Compatibility shim for older ops clients. Core owns platform settings now;
  // the old Gateway Ops URL still delegates to the same platform service.
  .get("/settings/legacy", async (c) => respond(c, ok(await settingsListLegacyKeys(await liveSettingKeys()))))
  .delete("/settings/legacy", async (c) => respond(c, ok(await settingsDeleteLegacyKeys(await liveSettingKeys()))))
  .put("/settings/:key{.+}", v("json", UpdateSettingSchema), async (c) => {
    const key = c.req.param("key") ?? "";
    if (!key.startsWith(GATEWAY_SETTING_PREFIX)) return respond(c, fail(err.badInput(`Setting "${key}" is not in the gateway namespace`)));
    const body = c.req.valid("json");
    const result = await settingsService.entry.update({ key, value: body.value });
    if (!result.ok) return respond(c, result);
    if (key === "gateway.health_check_schedule" && typeof body.value === "string") await updateHealthSchedule(body.value);
    return respond(c, ok({ message: gatewayOpsMessages.resolve([getLocale(c)]).t.settingUpdated }));
  })
  .get("/health", async (c) => respond(c, ok(await buildGatewayHealth())))
  .get("/routes", v("query", GatewayRoutesQuerySchema), async (c) => {
    const query = c.req.valid("query");
    const snapshot = await latestGatewayRouteSnapshot();
    if (!snapshot) return respond(c, ok({ generatedAt: null, instanceId: null, total: 0, routeCount: 0, items: [] }));

    // The router's own counters are cumulative since it booted, so they read
    // healthy on a long-lived process that is failing right now. Traffic comes
    // from windowed rollups; the snapshot still owns the route table.
    const totals = await getTelemetryPrefixTotals(query.range as TelemetryRange);
    const search = query.search?.trim().toLowerCase();
    const app = query.app?.trim().toLowerCase();
    const allRows = snapshot.routes.map((route) => {
      const stats = totals.get(route.prefix);
      return {
        prefix: route.prefix,
        appId: route.appId,
        count: stats?.requests ?? 0,
        errors: stats?.errors ?? 0,
        slow: stats?.slowRequests ?? 0,
        avgDurationMs: stats?.avgDurationMs ?? null,
      };
    });
    const items = allRows
      .filter((route) => !app || route.appId.toLowerCase() === app)
      .filter((route) => !query.errors || route.errors > 0)
      .filter((route) => !search || `${route.prefix} ${route.appId}`.toLowerCase().includes(search))
      .sort((a, b) => {
        if (query.sort === "prefix") return a.prefix.localeCompare(b.prefix);
        if (query.sort === "errors") return b.errors - a.errors || b.count - a.count || a.prefix.localeCompare(b.prefix);
        return b.count - a.count || b.errors - a.errors || a.prefix.localeCompare(b.prefix);
      });

    return respond(
      c,
      ok({
        generatedAt: new Date(snapshot.updatedAt).toISOString(),
        range: query.range,
        instanceId: snapshot.instanceId,
        total: allRows.length,
        routeCount: items.length,
        items,
      }),
    );
  })
  .get("/data", async (c) => respond(c, ok(await getDataDiagnostics(getLocale(c)))))
  .get("/data/postgres", async (c) => respond(c, ok(await getPostgresDiagnostics(getLocale(c)))))
  .get("/data/redis", async (c) => respond(c, ok(await getRedisDiagnostics(getLocale(c)))))
  .get("/data/postgres/sessions", async (c) => {
    try {
      return respond(c, ok({ items: await listPostgresSessions() }));
    } catch {
      return respond(c, fail(err.internal(gatewayOpsMessages.resolve([getLocale(c)]).t.postgresSessionsUnavailable)));
    }
  })
  .get("/data/postgres/indexes", async (c) => {
    try {
      return respond(c, ok({ items: await listPostgresIndexes() }));
    } catch {
      return respond(c, fail(err.internal(gatewayOpsMessages.resolve([getLocale(c)]).t.postgresIndexesUnavailable)));
    }
  })
  .get("/telemetry/summary", v("query", TelemetrySummaryQuerySchema), async (c) => {
    const { hours } = c.req.valid("query");
    return respond(c, ok(await getTelemetrySummary(hours)));
  })
  .get("/telemetry/apps", v("query", TelemetrySummaryQuerySchema), async (c) => {
    const { hours } = c.req.valid("query");
    return respond(c, ok({ items: await listTelemetryApps(hours) }));
  })
  .get("/telemetry/events", v("query", TelemetryEventsQuerySchema), async (c) => {
    const query = c.req.valid("query");
    return respond(
      c,
      ok(
        await listTelemetryEvents({
          search: query.search,
          appId: query.app,
          routePrefix: query.route,
          slowOnly: query.slow,
          errorsOnly: query.errors,
          hours: query.hours,
          page: query.page,
          perPage: query.per_page,
        }),
      ),
    );
  })
  .get("/health/webhooks", async (c) => respond(c, ok(await listHealthWebhooks())))
  .post("/health/webhooks", v("json", HealthWebhookInputSchema), async (c) => {
    try {
      return respond(c, ok(await createHealthWebhook(c.req.valid("json"))));
    } catch (error) {
      return respond(c, fail(err.badInput(healthWebhookInputError(c, error))));
    }
  })
  .put("/health/webhooks/:id", v("param", HealthWebhookIdParamSchema), v("json", HealthWebhookInputSchema), async (c) => {
    const { id } = c.req.valid("param");
    try {
      const webhook = await updateHealthWebhook(id, c.req.valid("json"));
      if (!webhook) return respond(c, fail(err.notFound(gatewayOpsMessages.resolve([getLocale(c)]).t.healthWebhookNotFound)));
      return respond(c, ok(webhook));
    } catch (error) {
      return respond(c, fail(err.badInput(healthWebhookInputError(c, error))));
    }
  })
  .delete("/health/webhooks/:id", v("param", HealthWebhookIdParamSchema), async (c) => {
    const { id } = c.req.valid("param");
    const { t } = gatewayOpsMessages.resolve([getLocale(c)]);
    if (!(await deleteHealthWebhook(id))) return respond(c, fail(err.notFound(t.healthWebhookNotFound)));
    return respond(c, ok({ message: t.webhookDeleted }));
  })
  .post("/health/webhooks/:id/test", v("param", HealthWebhookIdParamSchema), async (c) => {
    const { id } = c.req.valid("param");
    const { t } = gatewayOpsMessages.resolve([getLocale(c)]);
    if (!(await getHealthWebhook(id))) return respond(c, fail(err.notFound(t.healthWebhookNotFound)));
    const jobId = await testHealthWebhook(id);
    return respond(c, ok({ message: t.webhookTestSubmitted, jobId }));
  });

export type ApiType = typeof apiRoutes;
