import type { WidgetBlock, WidgetResponse } from "@valentinkolb/cloud/contracts";
import { hasRole } from "@valentinkolb/cloud/contracts";
import { type AuthContext, auth, getLocale } from "@valentinkolb/cloud/server";
import { latestGatewayRouteSnapshot } from "@valentinkolb/cloud/services";
import { formatDurationMs, formatNumber } from "@valentinkolb/cloud/shared";
import { type Context, Hono } from "hono";
import { buildGatewayHealth } from "./health";
import { gatewayOpsMessages } from "./messages";

/**
 * Platform health widget — admin only. Status includes app liveness and the
 * operational signals evaluated by the central health service.
 */
export const gatewayHealthWidgetHandler = async (c: Context<AuthContext>) => {
  const actor = c.get("actor") as AuthContext["Variables"]["actor"] | undefined;
  const user = actor?.kind === "user" ? actor.user : actor?.delegatedUser;
  // 403 = admin-only widget; non-admins see it as locked in the dashboard modal.
  if (!user || !hasRole(user, "admin")) return c.body(null, 403);
  const locale = getLocale(c);
  const { t } = gatewayOpsMessages.resolve([locale]);

  const [health, snapshot] = await Promise.all([buildGatewayHealth(), latestGatewayRouteSnapshot()]);
  const { apps: total, healthy, degraded, offline } = health.summary;
  const unhealthy = degraded + offline;

  const blocks: WidgetBlock[] = [
    {
      kind: "status",
      grow: true,
      tone: health.status,
      title:
        unhealthy === 0
          ? t.allSystemsOperational
          : t.appsNeedAttention({ unhealthy: formatNumber(unhealthy, { locale }), total: formatNumber(total, { locale }) }),
      message: snapshot
        ? t.gatewayUptime({ uptime: formatDurationMs(Date.now() - snapshot.startedAt, { locale }), total: formatNumber(total, { locale }) })
        : t.widgetNoRouterSnapshot({ total: formatNumber(total, { locale }) }),
    },
    {
      kind: "pills",
      pills: [
        {
          label: t.apps,
          value: `${formatNumber(healthy, { locale })}/${formatNumber(total, { locale })}`,
          tone: unhealthy === 0 ? "emerald" : health.status === "error" ? "red" : "amber",
        },
        { label: t.routes, value: formatNumber(snapshot?.routeCount ?? 0, { locale }) },
        { label: t.requestsShort, value: formatNumber(snapshot?.stats.totalRequests ?? 0, { locale }) },
        ...(snapshot && snapshot.stats.noRouteCount > 0
          ? [{ label: t.unmatched, value: formatNumber(snapshot.stats.noRouteCount, { locale }), tone: "amber" as const }]
          : []),
      ],
    },
  ];

  const body: WidgetResponse = {
    title: t.platformHealth,
    icon: "ti ti-heartbeat",
    href: "/admin/gateway",
    blocks,
  };
  return c.json(body);
};

export const widgetRoutes = new Hono<AuthContext>().use(auth.requireRole("*")).get("/health", gatewayHealthWidgetHandler);
