import { WorkspaceNavigationProvider } from "@k2b/cloud/ssr/islands";
import { AppWorkspace, createNavigation } from "@k2b/ui";
import { createSignal, For, onCleanup, Show } from "solid-js";
import type { PulseBase } from "../../contracts";
import type { Dashboard } from "../../dashboard-contracts";
import { usePulseMessages } from "../use-messages";
import { dashboardClient } from "./dashboard-client";
import { buildPulseWorkspaceHref } from "./routes";
import type { WorkspaceView } from "./types";

type Props = {
  dashboards?: Dashboard[];
  dashboardId?: string;
  dashboardsNextOffset?: number | null;
  title: string;
  bases: PulseBase[];
  baseId: string;
  activeView: WorkspaceView;
  sourceCount: number;
  attentionCount?: number;
  openOverview: () => void;
  settingsDisabled: boolean;
  openSettings: () => void | Promise<void>;
  openSql: () => void;
  openSources: () => void;
  openComingBack: () => void;
};

export default function PulseSidebar(props: Props) {
  const t = usePulseMessages();
  const [dashboards, setDashboards] = createSignal(props.dashboards ?? []);
  const [nextOffset, setNextOffset] = createSignal(props.dashboardsNextOffset ?? null);
  const [loadingMore, setLoadingMore] = createSignal(false);
  const [loadFailed, setLoadFailed] = createSignal(false);
  const lifetime = new AbortController();
  onCleanup(() => lifetime.abort());
  const dashboardHref = (id: string) => buildPulseWorkspaceHref({ baseId: props.baseId, state: { view: "dashboards", dashboardId: id } });
  const loadMore = async () => {
    if (loadingMore() || nextOffset() === null) return;
    setLoadingMore(true);
    setLoadFailed(false);
    try {
      const page = await dashboardClient.list(props.baseId, nextOffset()!, lifetime.signal);
      if (!lifetime.signal.aborted) {
        setDashboards((old) => [...old, ...page.items.filter((item) => !old.some((existing) => existing.id === item.id))]);
        setNextOffset(page.nextOffset);
      }
    } catch {
      if (!lifetime.signal.aborted) setLoadFailed(true);
    } finally {
      if (!lifetime.signal.aborted) setLoadingMore(false);
    }
  };
  const switcher = () => ({
    currentId: props.baseId,
    label: props.title,
    icon: "ti ti-activity-heartbeat",
    switchLabel: t().selectBase,
    options: props.bases.map((base) => ({ id: base.id, label: base.name, href: `/app/pulse/${base.id}` })),
    actions: [{ id: "all", label: t().yourBases, icon: "ti ti-layout-grid", href: "/app/pulse" }],
  });
  const navigation = createNavigation({
    switcher,
    items: () => [
      {
        id: "overview",
        label: t().overview,
        icon: "ti ti-home",
        action: "overview",
        badge: props.attentionCount || undefined,
        active: props.activeView === "overview",
      },
      { id: "sql", label: "SQL", icon: "ti ti-code", action: "sql", active: props.activeView === "sql" },
      {
        id: "sources",
        label: t().sources,
        icon: "ti ti-database",
        action: "sources",
        badge: props.sourceCount,
        active: props.activeView === "sources",
      },
      {
        id: "coming-back",
        label: t().dashboards,
        icon: "ti ti-chart-area-line",
        action: "coming-back",
        active: props.activeView === "dashboards" && !props.dashboardId,
      },
      ...dashboards().map((dashboard) => ({
        id: `dashboard-${dashboard.id}`,
        label: dashboard.name,
        icon: "ti ti-layout-dashboard",
        href: dashboardHref(dashboard.id),
        active: props.activeView === "dashboards" && props.dashboardId === dashboard.id,
      })),
      ...(nextOffset() === null
        ? []
        : [
            {
              id: "dashboards-more",
              label: loadFailed() ? t().retry : t().dashboardMore,
              icon: "ti ti-dots",
              action: "dashboards-more",
              disabled: loadingMore(),
            },
          ]),
      { id: "settings", label: t().settings, icon: "ti ti-settings", action: "settings", disabled: props.settingsDisabled },
    ],
    onAction: async (action) => {
      if (action === "overview") props.openOverview();
      else if (action === "sql") props.openSql();
      else if (action === "sources") props.openSources();
      else if (action === "coming-back") props.openComingBack();
      else if (action === "dashboards-more") await loadMore();
      else if (action === "settings") await props.openSettings();
    },
  });
  return (
    <>
      <WorkspaceNavigationProvider navigation={navigation} label={props.title} />
      <AppWorkspace.Sidebar collapsible defaultSize={236}>
        <AppWorkspace.SidebarDesktop>
          <AppWorkspace.SidebarSwitcher {...switcher()} />
          <AppWorkspace.SidebarBody scrollPreserveKey="pulse-sidebar" sidebarMode="expanded">
            <AppWorkspace.SidebarItem
              icon="ti ti-home"
              active={props.activeView === "overview"}
              onClick={props.openOverview}
              meta={props.attentionCount || undefined}
            >
              {t().overview}
            </AppWorkspace.SidebarItem>
            <AppWorkspace.SidebarItem icon="ti ti-code" active={props.activeView === "sql"} onClick={props.openSql}>
              SQL
            </AppWorkspace.SidebarItem>
            <AppWorkspace.SidebarSection title={t().dashboards}>
              <For each={dashboards()}>
                {(dashboard) => (
                  <AppWorkspace.SidebarItem
                    variant="object"
                    icon="ti ti-layout-dashboard"
                    href={dashboardHref(dashboard.id)}
                    active={props.activeView === "dashboards" && props.dashboardId === dashboard.id}
                  >
                    {dashboard.name}
                  </AppWorkspace.SidebarItem>
                )}
              </For>
              <Show when={!dashboards().length}>
                <AppWorkspace.SidebarItem icon="ti ti-plus" active={props.activeView === "dashboards"} onClick={props.openComingBack}>
                  {t().dashboardEmpty}
                </AppWorkspace.SidebarItem>
              </Show>
              <Show when={nextOffset() !== null}>
                <AppWorkspace.SidebarItem icon="ti ti-dots" disabled={loadingMore()} onClick={() => void loadMore()}>
                  {loadFailed() ? t().retry : t().dashboardMore}
                </AppWorkspace.SidebarItem>
              </Show>
              <Show when={loadFailed()}>
                <p role="alert" class="px-3 text-xs text-[var(--k2b-danger-text)]">
                  {t().pulseDataRefreshFailed}
                </p>
              </Show>
            </AppWorkspace.SidebarSection>
            <AppWorkspace.SidebarSection title={t().dashboardBaseSection}>
              <AppWorkspace.SidebarItem
                icon="ti ti-database"
                active={props.activeView === "sources"}
                onClick={props.openSources}
                meta={props.sourceCount}
              >
                {t().sources}
              </AppWorkspace.SidebarItem>
              <AppWorkspace.SidebarItem icon="ti ti-settings" disabled={props.settingsDisabled} onClick={() => void props.openSettings()}>
                {t().settings}
              </AppWorkspace.SidebarItem>
            </AppWorkspace.SidebarSection>
          </AppWorkspace.SidebarBody>
          <AppWorkspace.SidebarIconGrid sidebarMode="collapsed">
            <AppWorkspace.SidebarIconAction
              icon="ti ti-home"
              label={t().overview}
              active={props.activeView === "overview"}
              onClick={props.openOverview}
            />
            <AppWorkspace.SidebarIconAction icon="ti ti-code" label="SQL" active={props.activeView === "sql"} onClick={props.openSql} />
            <AppWorkspace.SidebarIconAction
              icon="ti ti-database"
              label={t().sources}
              active={props.activeView === "sources"}
              onClick={props.openSources}
            />
            <AppWorkspace.SidebarIconAction
              icon="ti ti-chart-area-line"
              label={t().dashboards}
              active={props.activeView === "dashboards"}
              onClick={props.openComingBack}
            />
          </AppWorkspace.SidebarIconGrid>
          <AppWorkspace.SidebarFooter sidebarMode="collapsed">
            <AppWorkspace.SidebarIconGrid>
              <AppWorkspace.SidebarIconAction
                icon="ti ti-settings"
                label={t().settingsFor({ title: props.title })}
                disabled={props.settingsDisabled}
                onClick={() => void props.openSettings()}
              />
            </AppWorkspace.SidebarIconGrid>
          </AppWorkspace.SidebarFooter>
        </AppWorkspace.SidebarDesktop>
      </AppWorkspace.Sidebar>
    </>
  );
}
