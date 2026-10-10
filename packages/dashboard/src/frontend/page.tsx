import { listLegalLinks, listWidgets } from "@k2b/cloud";
import { hasRole, type Role, type RuntimeAppMeta, type User, widgetKey } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import { expectUserBackedActor, getDateConfig, getLocale } from "@k2b/cloud/server";
import { getLocalizedRuntimeContext, Layout } from "@k2b/cloud/ssr";
import { ScrollArea } from "@k2b/ui";
import { ssr } from "../config";
import { dashboardSettingsService } from "../service";
import {
  DASHBOARD_COOKIE,
  type DashboardAppSummary,
  type DashboardBoardEntry,
  type DashboardCatalogWidget,
  defaultDashboardBoard,
  migrateLegacyDashboardLayout,
  normalizeDashboardShortcuts,
  normalizeLegacyDashboardLayout,
  splitDashboardBoard,
} from "../shared";
import DashboardHome from "./DashboardHome.island";
import { dashboardMessages } from "./messages";

/** Settings from the cookie that held them before they moved to the account; read once for people who never returned. */
const readLegacyCookie = (cookieHeader: string) => {
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${DASHBOARD_COOKIE}=([^;]+)`));
  if (!match?.[1]) return null;
  try {
    const value: unknown = JSON.parse(decodeURIComponent(match[1]));
    if (!value || typeof value !== "object") return null;
    const raw = value as Record<string, unknown>;
    return { shortcuts: normalizeDashboardShortcuts(raw.shortcuts), legacy: normalizeLegacyDashboardLayout(raw.hiddenWidgets, raw.layout) };
  } catch {
    return null;
  }
};

const mayUse = (requiresRoles: readonly Role[], user: User) =>
  requiresRoles.length === 0 || requiresRoles.some((role) => hasRole(user, role));

const appIsAvailable = (app: RuntimeAppMeta, user: User) => {
  const nav = app.nav;
  if (!nav || nav.section === "hidden") return false;
  return !nav.requiresRoles?.length || mayUse(nav.requiresRoles, user);
};

export default ssr<AuthContext>(async (c) => {
  const user = expectUserBackedActor(c);
  const greeting = user?.displayName || user?.uid || "there";
  const locale = getLocale(c);
  const { t } = dashboardMessages.resolve([locale]);
  const dateConfig = getDateConfig(c);
  const today = new Intl.DateTimeFormat(locale, {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: dateConfig.timeZone,
  }).format(new Date());

  const [stored, widgets, legalLinks] = await Promise.all([
    dashboardSettingsService.get(user.id),
    listWidgets(locale),
    listLegalLinks(locale),
  ]);
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
      ? [{ id: "admin", name: t.adminName, icon: "ti ti-settings", href: "/admin", description: t.adminDescription }]
      : []),
  ];
  const appHrefById = new Map(availableApps.map((entry) => [entry.id, entry.href]));
  const declared = widgets.map((widget) => ({ ...widget, key: widgetKey(widget.appId, widget.widgetId) }));
  // `requiresRoles` only decides what the gallery and the default board offer; each handler still authorizes.
  const catalog: DashboardCatalogWidget[] = declared
    .filter((widget) => mayUse(widget.requiresRoles, user))
    .map((widget) => ({
      key: widget.key,
      appId: widget.appId,
      appName: widget.appName,
      appIcon: widget.appIcon,
      appHref: appHrefById.get(widget.appId),
      title: widget.title,
      description: widget.description,
      sizes: widget.sizes,
      defaultSize: widget.defaultSize,
      suggest: widget.suggest,
    }));
  const visible = new Set(catalog.map((widget) => widget.key));

  let shortcuts = stored.settings.shortcuts;
  let board: DashboardBoardEntry[] | null = stored.settings.board;
  if (stored.legacy) {
    board = await dashboardSettingsService.adoptMigratedBoard(user.id, migrateLegacyDashboardLayout(stored.legacy, declared, visible));
  } else if (!stored.exists) {
    const cookie = readLegacyCookie(c.req.raw.headers.get("Cookie") ?? "");
    if (cookie) {
      shortcuts = cookie.shortcuts;
      board = migrateLegacyDashboardLayout(cookie.legacy, declared, visible);
      await dashboardSettingsService.save(user.id, { shortcuts, board });
    }
  }
  const { shown, kept } = board ? splitDashboardBoard(board, catalog) : { shown: defaultDashboardBoard(catalog), kept: [] };

  return () => (
    <Layout c={c} title={t.title} fullPage>
      <ScrollArea class="flex-1">
        <DashboardHome
          greeting={`${t.greetingPrefix} ${greeting}`}
          today={today}
          apps={availableApps}
          legalLinks={legalLinks}
          shortcuts={shortcuts}
          catalog={catalog}
          board={shown}
          kept={kept}
          followsDefault={board === null}
        />
      </ScrollArea>
    </Layout>
  );
});
