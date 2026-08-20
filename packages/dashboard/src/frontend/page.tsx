import { gradients } from "@k2b/stdlib";
import {
  Placeholder,
  ScrollArea,
  Widget,
  WidgetHero,
  WidgetList,
  WidgetPills,
  WidgetStat,
  WidgetStatus,
  type WidgetStatusTone,
} from "@k2b/ui";
import { type DashboardWidget, listApps, listLegalLinks, listWidgets } from "@valentinkolb/cloud";
import type { WidgetBlock, WidgetResponse } from "@valentinkolb/cloud/contracts";
import { type AppRegistryEntry, hasRole, type Role, type User } from "@valentinkolb/cloud/contracts";
import type { AuthContext } from "@valentinkolb/cloud/server";
import { expectUserBackedActor } from "@valentinkolb/cloud/server";
import { logger } from "@valentinkolb/cloud/services";
import { Layout } from "@valentinkolb/cloud/ssr";
import type { JSX } from "solid-js";
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
import DashboardControls, { DashboardEditButton } from "./EditDashboard.island";

const log = logger("dashboard");
const WIDGET_TIMEOUT_MS = 500;
const SLOW_WIDGET_MS = 250;

const widgetStatusTone = (tone: "ok" | "warn" | "error" | "info"): WidgetStatusTone => {
  switch (tone) {
    case "ok":
      return "success";
    case "warn":
      return "warning";
    case "error":
      return "danger";
    case "info":
      return "info";
  }
};

type WidgetFetchResult =
  | { source: DashboardWidget; status: 200; data: WidgetResponse }
  | { source: DashboardWidget; status: 403 }
  | { source: DashboardWidget; status: "error"; data: WidgetResponse };

/**
 * Status code semantics (kept in sync with every widget endpoint):
 *   - 200 → render the response. The body always carries content — for empty
 *           states the endpoint returns a hero/status block with a hint.
 *   - 403 → user lacks the access level. Listed under "not available at your
 *           access level" in the edit modal.
 *   - 204 → no content; skip silently.
 *   - other / timeout → render a small error placeholder so one bad widget
 *           does not block or disappear from the dashboard.
 */
const widgetErrorResponse = (widget: DashboardWidget, message: string): WidgetResponse => ({
  title: widget.appName,
  icon: widget.appIcon,
  blocks: [
    {
      kind: "status",
      tone: "error",
      title: "Widget unavailable",
      message,
      icon: "ti ti-alert-circle",
      grow: true,
    },
  ],
});

const logSlowWidget = (widget: DashboardWidget, durationMs: number, status: number | "timeout" | "error") => {
  if (durationMs < SLOW_WIDGET_MS) return;
  log.warn("Slow dashboard widget", {
    appId: widget.appId,
    widgetId: widget.widgetId,
    status,
    durationMs,
    thresholdMs: SLOW_WIDGET_MS,
  });
};

const fetchWidget = async (widget: DashboardWidget, cookie: string): Promise<WidgetFetchResult | null> => {
  const controller = new AbortController();
  const startedAt = performance.now();
  const timeout = setTimeout(() => controller.abort(), WIDGET_TIMEOUT_MS);

  try {
    const resp = await fetch(widget.url, {
      headers: cookie ? { Cookie: cookie } : {},
      signal: controller.signal,
    });
    const durationMs = Math.round(performance.now() - startedAt);
    logSlowWidget(widget, durationMs, resp.status);

    if (resp.status === 403) return { source: widget, status: 403 };
    if (resp.status === 204) return null;
    if (!resp.ok) {
      log.warn("Widget fetch failed", {
        appId: widget.appId,
        widgetId: widget.widgetId,
        status: resp.status,
        durationMs,
      });
      return {
        source: widget,
        status: "error",
        data: widgetErrorResponse(widget, "The widget endpoint returned an error."),
      };
    }
    const data = (await resp.json()) as WidgetResponse;
    return { source: widget, status: 200, data };
  } catch (err) {
    const durationMs = Math.round(performance.now() - startedAt);
    const isTimeout = err instanceof Error && err.name === "AbortError";
    logSlowWidget(widget, durationMs, isTimeout ? "timeout" : "error");
    log.warn("Widget fetch threw", {
      appId: widget.appId,
      widgetId: widget.widgetId,
      error: err instanceof Error ? err.message : String(err),
      durationMs,
      timeoutMs: WIDGET_TIMEOUT_MS,
    });
    return {
      source: widget,
      status: "error",
      data: widgetErrorResponse(widget, isTimeout ? "The widget took too long to respond." : "The widget could not be loaded."),
    };
  } finally {
    clearTimeout(timeout);
  }
};

const renderBlock = (block: WidgetBlock): JSX.Element => {
  switch (block.kind) {
    case "stat":
      return (
        <WidgetStat
          value={block.value}
          label={block.label}
          sub={block.sub}
          valueClass={block.valueClass}
          accent={block.accent}
          grow={block.grow}
        />
      );
    case "list":
      return <WidgetList items={block.items} emptyMessage={block.emptyMessage} grow={block.grow} />;
    case "status":
      return (
        <div class="dashboard-widget-status">
          <WidgetStatus
            tone={widgetStatusTone(block.tone)}
            title={block.title}
            message={block.message}
            icon={block.icon}
            grow={block.grow}
          />
        </div>
      );
    case "pills":
      return (
        <div class="dashboard-widget-pills">
          <WidgetPills pills={block.pills} grow={block.grow} />
        </div>
      );
    case "placeholder":
      return (
        <Placeholder
          title={block.title}
          description={block.description}
          icon={block.icon}
          variant="compact"
          class="dashboard-widget-placeholder flex-1 justify-center"
        />
      );
    case "hero":
      return <WidgetHero title={block.title} subtitle={block.subtitle} icon={block.icon} tone={block.tone} />;
    default: {
      const _exhaustive: never = block;
      void _exhaustive;
      return null;
    }
  }
};

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

const widgetKey = (w: DashboardWidget): string => `${w.appId}/${w.widgetId}`;

type RenderedWidgetResult = Extract<WidgetFetchResult, { status: 200 }> | Extract<WidgetFetchResult, { status: "error" }>;

const DashboardWidgetCard = (props: { entry: RenderedWidgetResult }) => (
  <Widget
    title={props.entry.data.title}
    icon={props.entry.data.icon ?? props.entry.source.appIcon}
    href={props.entry.data.href}
    meta={props.entry.data.meta}
    size="content"
  >
    {props.entry.data.blocks.map((block) => renderBlock(block))}
  </Widget>
);

const appIsAvailable = (app: AppRegistryEntry, user: User) => {
  const nav = app.nav;
  if (!nav || nav.section === "hidden") return false;
  if (nav.requiresRoles?.length && !nav.requiresRoles.some((role) => hasRole(user, role as Role))) return false;
  return true;
};

export default ssr<AuthContext>(async (c) => {
  const user = expectUserBackedActor(c);
  const greeting = user?.displayName || user?.uid || "there";
  const cookie = c.req.raw.headers.get("Cookie") ?? "";

  const storedSettings = await dashboardSettingsService.get(user.id);
  const legacySettings = !storedSettings.exists ? readLegacyDashboardSettings(cookie) : null;
  if (legacySettings) await dashboardSettingsService.save(user.id, legacySettings);
  const settings = legacySettings ?? storedSettings.settings;
  const gradient = gradients.getGradientById(settings.gradient);

  const [widgets, apps] = await Promise.all([listWidgets(), listApps()]);
  const legalLinks = await listLegalLinks();
  const availableApps: DashboardAppSummary[] = [
    ...apps
      .filter((entry) => appIsAvailable(entry, user))
      .map((entry) => ({
        id: entry.id,
        name: entry.name,
        icon: entry.icon,
        href: entry.nav?.href ?? entry.routes[0] ?? "#",
        description: entry.description,
      })),
    ...(hasRole(user, "admin")
      ? [
          {
            id: "admin",
            name: "Admin",
            icon: "ti ti-settings",
            href: "/admin",
            description: "Platform administration, app settings, logs, and gateway controls.",
          },
        ]
      : []),
  ];
  const hiddenSet = new Set(settings.hiddenWidgets);
  const widgetsToFetch = widgets.filter((w) => !hiddenSet.has(widgetKey(w)));
  const hiddenSummaries: DashboardWidgetSummary[] = widgets
    .filter((w) => hiddenSet.has(widgetKey(w)))
    .map((w) => ({
      key: widgetKey(w),
      title: w.appName,
      icon: w.appIcon,
      presentation: w.presentation,
    }));

  // Pull visible widget endpoints, fetch in parallel, classify by status.
  const results = await Promise.all(widgetsToFetch.map((w) => fetchWidget(w, cookie)));

  const visible = results.filter((r): r is Extract<typeof r, { status: 200 }> => r?.status === 200);
  const inaccessible = results.filter((r): r is Extract<typeof r, { status: 403 }> => r?.status === 403);
  const failed = results.filter((r): r is Extract<typeof r, { status: "error" }> => r?.status === "error");

  const appHrefById = new Map(availableApps.map((app) => [app.id, app.href]));
  const rendered = [
    ...visible,
    ...failed.map((result) => ({
      ...result,
      data: {
        ...result.data,
        href: result.data.href ?? appHrefById.get(result.source.appId),
      },
    })),
  ].filter((r) => !hiddenSet.has(widgetKey(r.source)));

  // Summaries for the EditDashboard island — title/icon match what the user sees.
  const availableSummaries: DashboardWidgetSummary[] = [
    ...[...visible, ...failed].map((r) => ({
      key: widgetKey(r.source),
      title: r.data.title,
      icon: r.data.icon ?? r.source.appIcon,
      presentation: r.source.presentation,
    })),
    ...hiddenSummaries,
  ];
  const inaccessibleSummaries: DashboardWidgetSummary[] = inaccessible.map((r) => ({
    key: widgetKey(r.source),
    title: r.source.appName,
    icon: r.source.appIcon,
    presentation: r.source.presentation,
  }));
  const resolvedLayout = resolveDashboardWidgetLayout(
    rendered.map((entry) => ({
      key: widgetKey(entry.source),
      presentation: entry.source.presentation,
      entry,
    })),
    settings.layout,
  );
  const focusWidgets = resolvedLayout.filter((item) => item.zone === "focus");
  const overviewWidgets = resolvedLayout.filter((item) => item.zone === "overview");
  const contextWidgets = resolvedLayout.filter((item) => item.zone === "context");
  const focusRows = groupDashboardWidgetRows(focusWidgets, 2);
  const overviewRows = groupDashboardWidgetRows(overviewWidgets, 3);

  return () => (
    <Layout c={c} title="Dashboard">
      <ScrollArea class="flex-1">
        <div class="dashboard-page">
          <div class="dashboard-intro">
            <header class="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between" style="view-transition-name: page-title">
              <div class="min-w-0">
                <p class="mb-1 text-xs font-medium text-dimmed">Your workspace</p>
                <h1 class="text-2xl font-semibold text-primary sm:text-3xl">
                  Hi,{" "}
                  <span class={gradient.style ? "" : "app-accent-text"} style={gradient.style}>
                    {greeting}
                  </span>
                </h1>
                <p class="mt-1 text-sm text-dimmed">A quick view across the apps and work that matter to you.</p>
              </div>
              <DashboardEditButton
                apps={availableApps}
                legalLinks={legalLinks}
                settings={settings}
                available={availableSummaries}
                inaccessible={inaccessibleSummaries}
              />
            </header>

            <DashboardControls
              apps={availableApps}
              legalLinks={legalLinks}
              settings={settings}
              available={availableSummaries}
              inaccessible={inaccessibleSummaries}
            />
          </div>

          {rendered.length === 0 ? (
            <Placeholder
              surface="paper"
              variant="panel"
              description={
                <>
                  No widgets to show. Use <em>Edit dashboard</em> to enable any you have access to.
                </>
              }
            />
          ) : (
            <div class={`dashboard-briefing-grid ${contextWidgets.length > 0 ? "has-context" : ""}`}>
              <div class="dashboard-primary-column">
                {focusWidgets.length > 0 ? (
                  <section aria-label="Focus widgets" class="dashboard-widget-zone dashboard-focus-zone">
                    {focusRows.map((row) => (
                      <div class="dashboard-widget-row">
                        {row.map((item) => (
                          <DashboardWidgetCard entry={item.widget.entry} />
                        ))}
                      </div>
                    ))}
                  </section>
                ) : null}

                {overviewWidgets.length > 0 ? (
                  <section aria-label="Overview widgets" class="dashboard-widget-zone">
                    {overviewRows.map((row) => (
                      <div class="dashboard-widget-row">
                        {row.map((item) => (
                          <DashboardWidgetCard entry={item.widget.entry} />
                        ))}
                      </div>
                    ))}
                  </section>
                ) : null}
              </div>

              {contextWidgets.length > 0 ? (
                <aside aria-label="Context widgets" class="dashboard-context-column">
                  {contextWidgets.map((item) => (
                    <DashboardWidgetCard entry={item.widget.entry} />
                  ))}
                </aside>
              ) : null}
            </div>
          )}
        </div>
      </ScrollArea>
    </Layout>
  );
});
