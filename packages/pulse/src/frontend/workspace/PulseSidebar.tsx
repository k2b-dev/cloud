import { WorkspaceNavigationProvider } from "@k2b/cloud/ssr/islands";
import { AppWorkspace, createNavigation } from "@k2b/ui";
import { createSignal, For, type JSX, onCleanup, Show } from "solid-js";
import type { PulseBase } from "../../contracts";
import type { Dashboard } from "../../dashboard-contracts";
import { usePulseMessages } from "../use-messages";
import type { DashboardActions } from "./dashboard-actions";
import { dashboardClient } from "./dashboard-client";
import { buildPulseWorkspaceHref } from "./routes";
import type { WorkspaceView } from "./types";

type Props = {
  dashboards?: Dashboard[];
  selectedDashboard?: Dashboard;
  dashboardId?: string;
  dashboardsNextOffset?: number | null;
  dashboardsError?: { code: string; message: string } | null;
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
  openDashboards: () => void;
};

export default function PulseSidebar(props: Props) {
  const t = usePulseMessages();
  const [dashboards, setDashboards] = createSignal(props.dashboards ?? []);
  const visibleDashboards = () =>
    props.selectedDashboard && !dashboards().some((item) => item.id === props.selectedDashboard!.id)
      ? [props.selectedDashboard, ...dashboards()]
      : dashboards();
  const [nextOffset, setNextOffset] = createSignal(props.dashboardsError ? 0 : (props.dashboardsNextOffset ?? null));
  const [loadingMore, setLoadingMore] = createSignal(false);
  const [loadFailed, setLoadFailed] = createSignal(!!props.dashboardsError);
  const lifetime = new AbortController();
  onCleanup(() => lifetime.abort());
  const dashboardHref = (id: string) => buildPulseWorkspaceHref({ baseId: props.baseId, state: { view: "dashboards", dashboardId: id } });
  const loadMore = async () => {
    if (loadingMore() || nextOffset() === null) return;
    setLoadingMore(true);
    try {
      const page = await dashboardClient.list(props.baseId, nextOffset()!, lifetime.signal);
      if (!lifetime.signal.aborted) {
        setDashboards((old) => [...old, ...page.items.filter((item) => !old.some((existing) => existing.id === item.id))]);
        setNextOffset(page.nextOffset);
        setLoadFailed(false);
      }
    } catch {
      if (!lifetime.signal.aborted) setLoadFailed(true);
    } finally {
      if (!lifetime.signal.aborted) setLoadingMore(false);
    }
  };
  const switcher = () => {
    const base = props.bases.find((base) => base.id === props.baseId);
    return { ...baseSwitcher(props, t), description: base ? t().baseMembers({ count: base.memberCount }) : t().base };
  };
  const phoneDashboardId = () => props.dashboardId ?? visibleDashboards()[0]?.id;
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
        id: "dashboards",
        label: t().dashboards,
        icon: "ti ti-chart-area-line",
        action: "dashboards",
        active: props.activeView === "dashboards" && !props.dashboardId,
      },
      ...visibleDashboards().map((dashboard) => ({
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
      else if (action === "dashboards") props.openDashboards();
      else if (action === "dashboards-more") await loadMore();
      else if (action === "settings") await props.openSettings();
    },
  });
  return (
    <>
      <WorkspaceNavigationProvider navigation={navigation} label={props.title} />
      <AppWorkspace.Sidebar label={props.title} mobile="stacked" collapsible defaultSize={236}>
        <AppWorkspace.SidebarDesktop>
          <AppWorkspace.SidebarSection class="pulse-sidebar__identity" sidebarMode="expanded">
            <p>{t().appName}</p>
          </AppWorkspace.SidebarSection>
          <AppWorkspace.SidebarSwitcher {...switcher()} />
          <AppWorkspace.SidebarBody scrollPreserveKey="pulse-sidebar" sidebarMode="expanded">
            <AppWorkspace.SidebarItem
              class="pulse-sidebar__chip"
              icon="ti ti-home"
              active={props.activeView === "overview"}
              onClick={props.openOverview}
              meta={props.attentionCount || undefined}
            >
              {t().overview}
            </AppWorkspace.SidebarItem>
            <AppWorkspace.SidebarItem
              class="pulse-sidebar__chip"
              icon="ti ti-code"
              active={props.activeView === "sql"}
              onClick={props.openSql}
            >
              SQL
            </AppWorkspace.SidebarItem>
            <AppWorkspace.SidebarSection title={t().dashboards}>
              <For each={visibleDashboards()}>
                {(dashboard) => (
                  <AppWorkspace.SidebarItem
                    class={phoneDashboardId() === dashboard.id ? "pulse-sidebar__chip" : "pulse-sidebar__secondary"}
                    variant="object"
                    icon="ti ti-layout-dashboard"
                    href={dashboardHref(dashboard.id)}
                    active={props.activeView === "dashboards" && props.dashboardId === dashboard.id}
                  >
                    {dashboard.name}
                  </AppWorkspace.SidebarItem>
                )}
              </For>
              <Show when={!visibleDashboards().length && !loadFailed()}>
                <AppWorkspace.SidebarItem
                  class="pulse-sidebar__secondary"
                  icon="ti ti-plus"
                  active={props.activeView === "dashboards"}
                  onClick={props.openDashboards}
                >
                  {t().dashboardEmpty}
                </AppWorkspace.SidebarItem>
              </Show>
              <Show when={nextOffset() !== null}>
                <AppWorkspace.SidebarItem
                  class="pulse-sidebar__secondary"
                  icon="ti ti-dots"
                  disabled={loadingMore()}
                  onClick={() => void loadMore()}
                >
                  {loadFailed() ? t().retry : t().dashboardMore}
                </AppWorkspace.SidebarItem>
              </Show>
              <Show when={loadFailed()}>
                <p role="alert" class="pulse-sidebar__secondary px-3 text-xs text-[var(--k2b-danger-text)]">
                  {t().pulseDataRefreshFailed}
                </p>
              </Show>
            </AppWorkspace.SidebarSection>
            <AppWorkspace.SidebarSection class="pulse-sidebar__secondary" title={t().dashboardBaseSection}>
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
              onClick={props.openDashboards}
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

const baseSwitcher = (props: Pick<Props, "baseId" | "title" | "bases">, t: ReturnType<typeof usePulseMessages>) => ({
  currentId: props.baseId,
  label: props.title,
  icon: "ti ti-activity-heartbeat",
  switchLabel: t().selectBase,
  options: props.bases.map((base) => ({ id: base.id, label: base.name, href: `/app/pulse/${base.id}` })),
  actions: [{ id: "all", label: t().yourBases, icon: "ti ti-layout-grid", href: "/app/pulse" }],
});

export function PulseMobileFeatureHeader(props: Pick<Props, "baseId" | "title" | "bases"> & { name: string; action?: JSX.Element }) {
  const t = usePulseMessages();
  return (
    <div class="pulse-workspace__mobile-header">
      <AppWorkspace.SidebarSwitcher {...baseSwitcher(props, t)} class="pulse-workspace__base-switcher" />
      <div class="pulse-workspace__mobile-title">
        <p aria-hidden="true">{props.name}</p>
        {props.action}
      </div>
    </div>
  );
}

export function PulseMobileDashboardHeader(
  props: Pick<Props, "baseId" | "title" | "bases"> & { name: string; actions?: DashboardActions },
) {
  return (
    <PulseMobileFeatureHeader
      {...props}
      action={
        <Show when={props.actions}>
          {(actions) => {
            const Buttons = actions().Buttons;
            return <Buttons compact />;
          }}
        </Show>
      }
    />
  );
}
