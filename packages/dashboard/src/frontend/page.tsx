import { type DashboardWidget, listLegalLinks, listWidgets } from "@k2b/cloud";
import { hasRole, type Role, type RuntimeAppMeta, type User, widgetKey } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import { expectUserBackedActor, getLocale } from "@k2b/cloud/server";
import { getLocalizedRuntimeContext, Layout } from "@k2b/cloud/ssr";
import { gradients } from "@k2b/stdlib";
import { ScrollArea } from "@k2b/ui";
import { ssr } from "../config";
import { dashboardSettingsService } from "../service";
import {
  DASHBOARD_COOKIE,
  type DashboardAppSummary,
  type DashboardSettings,
  type DashboardWidgetSummary,
  groupDashboardWidgetRows,
  normalizeDashboardSettings,
  resolveDashboardWidgetLayout,
} from "../shared";
import DashboardBoard from "./DashboardBoard.island";
import DashboardEditButton from "./DashboardEditButton.island";
import type { DashboardTile } from "./dashboard-board";
import DashboardControls from "./EditDashboard.island";
import { dashboardMessages } from "./messages";
import { readDashboardWidgetHint } from "./widget-board";

/**
 * Read dashboard settings from the request cookie. Single source of truth for
 * the cookie key + shape lives in `EditDashboard.island.tsx` so client-write
 * and server-read can't drift apart.
 */
const readLegacyDashboardSettings = (cookieHeader: string): DashboardSettings | null => {
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${DASHBOARD_COOKIE}=([^;]+)`));
  if (!match?.[1]) return null;
  try {
    return normalizeDashboardSettings(JSON.parse(decodeURIComponent(match[1])));
  } catch {
    return null;
  }
};

const keyOf = (widget: DashboardWidget): string => widgetKey(widget.appId, widget.widgetId);

const appIsAvailable = (app: RuntimeAppMeta, user: User) => {
  const nav = app.nav;
  if (!nav || nav.section === "hidden") return false;
  if (nav.requiresRoles?.length && !nav.requiresRoles.some((role) => hasRole(user, role as Role))) return false;
  return true;
};

export default ssr<AuthContext>(async (c) => {
  const user = expectUserBackedActor(c);
  const greeting = user?.displayName || user?.uid || "there";
  const cookie = c.req.raw.headers.get("Cookie") ?? "";
  const locale = getLocale(c);
  const { t } = dashboardMessages.resolve([locale]);

  const storedSettings = await dashboardSettingsService.get(user.id);
  const legacySettings = !storedSettings.exists ? readLegacyDashboardSettings(cookie) : null;
  if (legacySettings) await dashboardSettingsService.save(user.id, legacySettings);
  const settings = legacySettings ?? storedSettings.settings;
  const gradient = gradients.getGradientById(settings.gradient);

  const [widgets, legalLinks] = await Promise.all([listWidgets(), listLegalLinks(locale)]);
  const apps = getLocalizedRuntimeContext(c).apps;
  const availableApps: DashboardAppSummary[] = [
    ...apps
      .filter((entry) => appIsAvailable(entry, user))
      .map((entry) => ({
        id: entry.id,
        name: entry.name,
        icon: entry.icon,
        href: entry.nav?.href ?? entry.routes[0] ?? "#",
        description: entry.description,
        badge: entry.nav?.badge,
      })),
    ...(hasRole(user, "admin")
      ? [
          {
            id: "admin",
            name: t.adminName,
            icon: "ti ti-settings",
            href: "/admin",
            description: t.adminDescription,
          },
        ]
      : []),
  ];
  // The page reserves space only for widgets that showed content last time on this device; the browser then asks
  // Core for every widget the user has not hidden, and each fills its own space as soon as its app answers.
  const hint = readDashboardWidgetHint(cookie);
  const hiddenSet = new Set(settings.hiddenWidgets);
  const absent = new Set([...hint.forbidden, ...hint.empty]);
  const requested = widgets.filter((widget) => !hiddenSet.has(keyOf(widget)));
  const appHrefById = new Map(availableApps.map((entry) => [entry.id, entry.href]));
  const summaries: DashboardWidgetSummary[] = widgets.map((widget) => ({
    key: keyOf(widget),
    title: widget.appName,
    icon: widget.appIcon,
    presentation: widget.presentation,
  }));
  const resolvedLayout = resolveDashboardWidgetLayout(
    requested
      .filter((widget) => !absent.has(keyOf(widget)))
      .map((widget) => ({
        key: keyOf(widget),
        presentation: widget.presentation,
        tile: {
          key: keyOf(widget),
          title: widget.appName,
          icon: widget.appIcon,
          href: appHrefById.get(widget.appId),
        } satisfies DashboardTile,
      })),
    settings.layout,
  );
  const tilesIn = (zone: "focus" | "overview" | "context") => resolvedLayout.filter((item) => item.zone === zone);
  const rowsIn = (zone: "focus" | "overview", perRow: number) =>
    groupDashboardWidgetRows(tilesIn(zone), perRow).map((row) => row.map((item) => item.widget.tile));

  return () => (
    <Layout c={c} title={t.title} fullPage>
      <ScrollArea class="flex-1">
        <div class="dashboard-page">
          <div class="dashboard-intro">
            <header class="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between" style="view-transition-name: page-title">
              <div class="min-w-0">
                <p class="mb-1 text-xs font-medium text-dimmed">{t.workspace}</p>
                <h1 class="text-2xl font-semibold text-primary sm:text-3xl">
                  {t.greetingPrefix}{" "}
                  <span class={gradient.style ? "" : "app-accent-text"} style={gradient.style}>
                    {greeting}
                  </span>
                </h1>
                <p class="mt-1 text-sm text-dimmed">{t.intro}</p>
              </div>
              <DashboardEditButton apps={availableApps} legalLinks={legalLinks} settings={settings} widgets={summaries} hint={hint} />
            </header>

            <DashboardControls apps={availableApps} legalLinks={legalLinks} settings={settings} />
          </div>

          <DashboardBoard
            focusRows={rowsIn("focus", 2)}
            overviewRows={rowsIn("overview", 3)}
            context={tilesIn("context").map((item) => item.widget.tile)}
            requestKeys={requested.map(keyOf)}
            registeredKeys={widgets.map(keyOf)}
            hint={hint}
          />
        </div>
      </ScrollArea>
    </Layout>
  );
});
