import type { WidgetBlock, WidgetResponse } from "@valentinkolb/cloud/contracts";
import { hasRole } from "@valentinkolb/cloud/contracts";
import { type AuthContext, auth, getLocale } from "@valentinkolb/cloud/server";
import { formatNumber } from "@valentinkolb/cloud/shared";
import { Hono } from "hono";
import { loggingService } from "./service";
import { gatewayOpsMessages } from "../../messages";

/**
 * Widget endpoints for the dashboard.
 *
 * Status code semantics (shared across every widget endpoint in the platform):
 *   - 200 → render
 *   - 204 → no content right now (data empty), widget is hidden but listed as
 *           toggleable in the dashboard's edit modal
 *   - 403 → user lacks the access level for this widget; modal lists it under
 *           "not available at your access level"
 *
 * `requireRole("*")` loads the session without enforcing it — we need the user
 * to decide between 403 and 200 ourselves.
 */
const app = new Hono<AuthContext>().use(auth.requireRole("*")).get("/errors", async (c) => {
  const actor = c.get("actor") as AuthContext["Variables"]["actor"] | undefined;
  const user = actor?.kind === "user" ? actor.user : actor?.delegatedUser;
  if (!user || !hasRole(user, "admin")) return c.body(null, 403);
  const locale = getLocale(c);
  const { t } = gatewayOpsMessages.resolve([locale]);

  const summary = await loggingService.stats.summary();
  const blocks: WidgetBlock[] = [
    {
      kind: "stat",
      // Stat grows to fill remaining vertical space; pills sit at the bottom.
      grow: true,
      value: formatNumber(summary.errors24h, { locale }),
      label: t.errorsLast24h,
      sub: summary.errors24h > 0 ? t.needsReview : t.allQuiet,
      valueClass: summary.errors24h > 0 ? "text-red-500" : undefined,
      accent: summary.errors24h > 0 ? { tone: "red", icon: "ti ti-alert-circle" } : { tone: "emerald", icon: "ti ti-check" },
    },
    {
      kind: "pills",
      pills: [
        { label: t.warningsShort, value: formatNumber(summary.warnings24h, { locale }), tone: summary.warnings24h > 0 ? "amber" : "zinc" },
        { label: t.volumeShort, value: formatNumber(summary.total24h, { locale }) },
        { label: t.sourcesShort, value: formatNumber(summary.sources, { locale }), tone: "blue" },
      ],
    },
  ];

  const body: WidgetResponse = {
    title: t.logs,
    icon: "ti ti-list-tree",
    href: "/admin/observability/logs",
    meta: t.last24h,
    blocks,
  };
  return c.json(body);
});

export default app;
