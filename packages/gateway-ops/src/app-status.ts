import { listApps, sql } from "@k2b/cloud";
import {
  type AppStatusDetailData,
  AppStatusDetailInputSchema,
  AppStatusForgetInputSchema,
  type AppStatusSummaryData,
  AppStatusSummaryInputSchema,
  type CapabilityExecutionContext,
} from "@k2b/cloud/contracts";
import { err, fail, ok } from "@k2b/cloud/server";
import { latestGatewayRouteSnapshot } from "@k2b/cloud/services";
import { z } from "zod";
import { TELEMETRY_RANGES } from "./observability/telemetry/contracts";
import { getTelemetryAppTotals, getTelemetryPrefixTotals } from "./observability/telemetry/service";
import { listRegisteredApps, removeOfflineRegisteredApp } from "./registered-apps";

const denied = (context: CapabilityExecutionContext, write = false) => {
  const authority = context.authority;
  const user = authority?.actor.kind === "user" ? authority.actor.user : authority?.actor.delegatedUser;
  if (!authority || !user?.roles.includes("admin") || authority.accessSubject.type !== "user" || authority.accessSubject.userId !== user.id)
    return fail(err.forbidden("Administrator access required"));
  const credentialKind = authority.credentialKind === "invocation" ? authority.actor.delegation?.credentialKind : authority.credentialKind;
  if (write && credentialKind === "oauth" && !authority.scopes.some((scope) => scope === "write" || scope === "admin"))
    return fail(err.forbidden("Write scope required"));
  return null;
};

export const readGatewayAppStatusSummary = async (
  input: z.infer<typeof AppStatusSummaryInputSchema>,
  context: CapabilityExecutionContext,
) => {
  const rejection = denied(context);
  if (rejection) return rejection;
  const { appIds, window } = AppStatusSummaryInputSchema.parse(input);
  context.signal.throwIfAborted();
  const [totals, registered] = await Promise.all([getTelemetryAppTotals(window), listRegisteredApps()]);
  const requested = new Set(appIds);
  const otherApps = registered
    .filter((app) => !requested.has(app.id))
    .slice(0, 50)
    .map((app) => app.id);
  const known = new Map(registered.map((app) => [app.id, app]));
  const german = context.locale.toLowerCase().startsWith("de");
  const data: AppStatusSummaryData = {
    apps: [...new Set([...appIds, ...otherApps])].map((appId) => {
      const traffic = totals.get(appId);
      const app = known.get(appId);
      return {
        appId,
        traffic: traffic ? { requests: traffic.requests, errors: traffic.errors, avgMs: traffic.avgDurationMs } : null,
        lastSeenAt: app ? new Date(app.lastSeenAt).toISOString() : null,
        links: [
          { label: german ? "Protokolle" : "Logs", href: "/admin/observability/logs" },
          {
            label: german ? "In Telemetrie öffnen" : "Open telemetry",
            href: `/admin/observability/telemetry?app=${encodeURIComponent(appId)}&range=${window}`,
          },
        ],
      };
    }),
    otherApps,
  };
  return ok({ data });
};

const cursorSchema = z
  .object({ at: z.string().datetime({ offset: true }), id: z.string().regex(/^[0-9]+$/), appId: z.string(), window: z.string() })
  .strict();

export const readGatewayAppStatusDetail = async (
  input: z.infer<typeof AppStatusDetailInputSchema>,
  context: CapabilityExecutionContext,
) => {
  const rejection = denied(context);
  if (rejection) return rejection;
  const { appId, window, cursor } = AppStatusDetailInputSchema.parse(input);
  let before: z.infer<typeof cursorSchema> | undefined;
  if (cursor) {
    try {
      before = cursorSchema.parse(JSON.parse(Buffer.from(cursor, "base64url").toString()));
      if (before.appId !== appId || before.window !== window) return fail(err.badInput("Invalid app-status cursor"));
    } catch {
      return fail(err.badInput("Invalid app-status cursor"));
    }
  }
  context.signal.throwIfAborted();
  const [snapshot, registered, prefixes] = await Promise.all([
    latestGatewayRouteSnapshot(),
    listRegisteredApps(),
    getTelemetryPrefixTotals(window),
  ]);
  const routes = [
    ...new Set([
      ...(snapshot?.routes.filter((route) => route.appId === appId).map((route) => route.prefix) ?? []),
      ...(registered.find((app) => app.id === appId)?.routes ?? []),
    ]),
  ];
  if (routes.length > 200) return fail(err.badInput("App-status supports at most 200 route prefixes"));
  const hours = TELEMETRY_RANGES[window].hours;
  const [events, counts] = await Promise.all([
    sql<{ id: string; at: string; method: string; path: string; status: number }[]>`
      SELECT id::text, to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at, method,
        COALESCE(NULLIF(path_template, ''), route_prefix) AS path, status_code AS status
      FROM gateway.telemetry_events
      WHERE app_id = ${appId} AND occurred_at >= now() - (${hours}::int * interval '1 hour')
        AND (status_code >= 500 OR error_kind IS NOT NULL)
        AND (${before?.at ?? null}::timestamptz IS NULL OR (occurred_at, id) < (${before?.at ?? null}::timestamptz, ${before?.id ?? null}::bigint))
      ORDER BY occurred_at DESC, id DESC LIMIT 51`,
    sql<{ total: number }[]>`SELECT count(*)::int AS total FROM gateway.telemetry_events
      WHERE app_id = ${appId} AND occurred_at >= now() - (${hours}::int * interval '1 hour')
        AND (status_code >= 500 OR error_kind IS NOT NULL)`,
  ]);
  const page = events.slice(0, 50);
  const last = page.at(-1);
  const data: AppStatusDetailData = {
    routes: routes.map((prefix) => ({ prefix, requests: prefixes.get(prefix)?.requests ?? 0, errors: prefixes.get(prefix)?.errors ?? 0 })),
    failedRequests: page.map((event) => ({
      at: new Date(event.at).toISOString(),
      method: event.method,
      path: event.path,
      status: event.status,
    })),
    totalFailedRequests: counts[0]?.total ?? 0,
    // Keep the original timestamp's microseconds in the continuation boundary.
    nextCursor:
      events.length > 50 && last ? Buffer.from(JSON.stringify({ at: last.at, id: last.id, appId, window })).toString("base64url") : null,
  };
  return ok({ data });
};

export const forgetGatewayAppStatus = async (input: z.infer<typeof AppStatusForgetInputSchema>, context: CapabilityExecutionContext) => {
  const rejection = denied(context, true);
  if (rejection) return rejection;
  const { appId } = AppStatusForgetInputSchema.parse(input);
  context.signal.throwIfAborted();
  const live = await listApps();
  const result = await removeOfflineRegisteredApp(appId, live);
  if (!result.ok && result.error.code !== "NOT_FOUND") return result;
  return ok({ data: { forgotten: true } });
};
