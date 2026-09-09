/**
 * Telemetry read API — the analysis surface behind the admin page, exposed so
 * the CLI (and agents driving it) can reach the same answers.
 *
 * Mounted at `/api/gateway/telemetry`, in front of the general `/api/gateway`
 * router which still owns the older `summary`, `apps` and `events` routes.
 *
 * The endpoints here are deliberately aggregate-first: `routes` answers "what
 * is broken / what is busy" in one call, which is the question worth asking
 * before paging through individual requests.
 */
import { type AuthContext, auth, rateLimit, respond, v } from "@k2b/cloud/server";
import { ok } from "@k2b/stdlib";
import { Hono } from "hono";
import { z } from "zod";
import { TELEMETRY_RANGES, TELEMETRY_ROUTE_SORTS } from "./contracts";
import { getTelemetryOverview, getTelemetryTimeseries, listTelemetryEvents, listTelemetryRoutes } from "./service";

const QueryBooleanSchema = z
  .union([z.literal("1"), z.literal("true"), z.literal("0"), z.literal("false")])
  .optional()
  .transform((value) => value === "1" || value === "true");

const RangeSchema = z.enum(Object.keys(TELEMETRY_RANGES) as [string, ...string[]]).default("24h");

const ScopeQuerySchema = z.object({
  range: RangeSchema,
  app: z.string().optional(),
  route: z.string().optional(),
});

const RoutesQuerySchema = z.object({
  range: RangeSchema,
  app: z.string().optional(),
  sort: z.enum(TELEMETRY_ROUTE_SORTS as [string, ...string[]]).default("errorRate"),
  errors: QueryBooleanSchema,
  slow: QueryBooleanSchema,
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

const RouteEventsQuerySchema = z.object({
  range: RangeSchema,
  app: z.string().optional(),
  route: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const scopeOf = (query: { range: string; app?: string; route?: string }) => ({
  range: query.range as keyof typeof TELEMETRY_RANGES,
  appId: query.app,
  route: query.route,
});

const app = new Hono<AuthContext>()
  .use(rateLimit())
  .use(auth.requireRole("admin"))

  /** Request counts split by error class — 429 counted separately from other 4xx. */
  .get("/overview", v("query", ScopeQuerySchema), async (c) => respond(c, ok(await getTelemetryOverview(scopeOf(c.req.valid("query"))))))

  /** Bucketed request/error series for the selected range. */
  .get("/timeseries", v("query", ScopeQuerySchema), async (c) =>
    respond(c, ok({ items: await getTelemetryTimeseries(scopeOf(c.req.valid("query"))) })),
  )

  /** Ranked routes — the "which endpoint is the problem" query. */
  .get("/routes", v("query", RoutesQuerySchema), async (c) => {
    const query = c.req.valid("query");
    const rows = await listTelemetryRoutes({ range: query.range as keyof typeof TELEMETRY_RANGES, appId: query.app }, query.sort as never, {
      errorsOnly: query.errors,
      slowOnly: query.slow,
    });
    return respond(c, ok({ items: rows.slice(0, query.limit) }));
  })

  /** Individual requests for one route template — the drilldown. */
  .get("/route-events", v("query", RouteEventsQuerySchema), async (c) => {
    const query = c.req.valid("query");
    return respond(c, ok({ items: await listTelemetryEvents(scopeOf(query), query.limit) }));
  });

export default app;
