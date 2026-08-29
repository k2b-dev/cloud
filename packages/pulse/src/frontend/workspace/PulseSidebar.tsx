import { AppWorkspace, Dropdown } from "@k2b/ui";
import { For, type JSX } from "solid-js";
import type { PulseDashboard } from "../../contracts";
import type { WorkspaceView } from "./types";
import { usePulseMessages } from "../use-messages";

type Props = {
  title: string;
  activeView: WorkspaceView;
  dashboards: PulseDashboard[];
  resourceCount: number;
  sourceCount: number;
  eventCount: number;
  stateCount: number;
  metricCount: number;
  settingsDisabled: boolean;
  openSettings: () => void | Promise<void>;
  createDashboard: () => unknown;
  openDashboard: (dashboardId: string) => void;
  renderDashboardItem: (dashboard: PulseDashboard) => JSX.Element;
  openResources: () => void;
  openSources: () => void;
  openQueryExplorer: () => void;
  openActivityEvents: () => void;
  openActivityStates: () => void;
  openActivityMetrics: () => void;
};

const SidebarSections = (props: Props) => {
  const t = usePulseMessages();
  return (
  <>
    <AppWorkspace.SidebarSection title={t().dashboards}>
      <AppWorkspace.SidebarItem icon="ti ti-plus" active={false} onClick={() => void props.createDashboard()}>
        {t().newDashboard}
      </AppWorkspace.SidebarItem>
      <For each={props.dashboards}>{(dashboard) => props.renderDashboardItem(dashboard)}</For>
    </AppWorkspace.SidebarSection>

    <AppWorkspace.SidebarSection title={t().data}>
      <AppWorkspace.SidebarItem
        icon="ti ti-cube"
        active={props.activeView === "resources" || props.activeView === "resource-detail"}
        onClick={props.openResources}
        meta={props.resourceCount}
      >
        {t().resources}
      </AppWorkspace.SidebarItem>
      <AppWorkspace.SidebarItem
        icon="ti ti-database"
        active={props.activeView === "sources"}
        onClick={props.openSources}
        meta={props.sourceCount}
      >
        {t().sources}
      </AppWorkspace.SidebarItem>
      <AppWorkspace.SidebarItem icon="ti ti-terminal-2" active={props.activeView === "explorer"} onClick={props.openQueryExplorer}>
        {t().queryExplorer}
      </AppWorkspace.SidebarItem>
    </AppWorkspace.SidebarSection>

    <AppWorkspace.SidebarSection title={t().signals}>
      <AppWorkspace.SidebarItem
        icon="ti ti-bolt"
        active={props.activeView === "activity-events" || props.activeView === "event-detail"}
        onClick={props.openActivityEvents}
        meta={props.eventCount}
      >
        {t().events}
      </AppWorkspace.SidebarItem>
      <AppWorkspace.SidebarItem
        icon="ti ti-toggle-right"
        active={props.activeView === "activity-states" || props.activeView === "state-detail"}
        onClick={props.openActivityStates}
        meta={props.stateCount}
      >
        {t().states}
      </AppWorkspace.SidebarItem>
      <AppWorkspace.SidebarItem
        icon="ti ti-chart-dots"
        active={props.activeView === "activity-metrics" || props.activeView === "metric-detail"}
        onClick={props.openActivityMetrics}
        meta={props.metricCount}
      >
        {t().metrics}
      </AppWorkspace.SidebarItem>
    </AppWorkspace.SidebarSection>
  </>
  );
};

export default function PulseSidebar(props: Props) {
  const t = usePulseMessages();
  const collapsedDashboardMenu = () => [
    {
      sectionLabel: t().dashboards,
      items: [
        ...props.dashboards.map((dashboard) => ({
          icon: "ti ti-chart-area-line",
          label: dashboard.name,
          action: () => props.openDashboard(dashboard.id),
        })),
        { icon: "ti ti-plus", label: t().newDashboard, action: () => void props.createDashboard() },
      ],
    },
  ];

  return (
    <AppWorkspace.Sidebar collapsible>
      <AppWorkspace.SidebarMobileTrigger label={props.title} />
      <AppWorkspace.SidebarMobile>
        <AppWorkspace.SidebarMobileItems>
          <AppWorkspace.SidebarItem icon="ti ti-settings" disabled={props.settingsDisabled} onClick={() => void props.openSettings()}>
            {t().settings}
          </AppWorkspace.SidebarItem>
        </AppWorkspace.SidebarMobileItems>
        <AppWorkspace.SidebarMobileBody scrollPreserveKey="pulse-sidebar-mobile">
          <div class="grid gap-3">
            <SidebarSections {...props} />
          </div>
        </AppWorkspace.SidebarMobileBody>
      </AppWorkspace.SidebarMobile>
      <AppWorkspace.SidebarDesktop>
        <AppWorkspace.SidebarBody scrollPreserveKey="pulse-sidebar" sidebarMode="expanded">
          <SidebarSections {...props} />
        </AppWorkspace.SidebarBody>
        <AppWorkspace.SidebarSection sidebarMode="collapsed">
          <Dropdown.Root items={collapsedDashboardMenu()} position="right-start" width="16rem">
            <Dropdown.Trigger
              appearance="plain"
              iconOnly
              label={t().dashboards}
              class={`k2b-app-workspace__sidebar-icon-action ${
                props.activeView === "dashboard" || props.activeView === "dashboard-edit" ? "is-active" : ""
              }`}
            >
              <i class="ti ti-chart-area-line" aria-hidden="true" />
            </Dropdown.Trigger>
          </Dropdown.Root>
        </AppWorkspace.SidebarSection>
        <AppWorkspace.SidebarIconGrid sidebarMode="collapsed">
          <AppWorkspace.SidebarIconAction
            icon="ti ti-cube"
            label={t().resources}
            active={props.activeView === "resources" || props.activeView === "resource-detail"}
            onClick={props.openResources}
          />
          <AppWorkspace.SidebarIconAction
            icon="ti ti-database"
            label={t().sources}
            active={props.activeView === "sources"}
            onClick={props.openSources}
          />
          <AppWorkspace.SidebarIconAction
            icon="ti ti-terminal-2"
            label={t().queryExplorer}
            active={props.activeView === "explorer"}
            onClick={props.openQueryExplorer}
          />
          <AppWorkspace.SidebarIconAction
            icon="ti ti-bolt"
            label={t().events}
            active={props.activeView === "activity-events" || props.activeView === "event-detail"}
            onClick={props.openActivityEvents}
          />
          <AppWorkspace.SidebarIconAction
            icon="ti ti-toggle-right"
            label={t().states}
            active={props.activeView === "activity-states" || props.activeView === "state-detail"}
            onClick={props.openActivityStates}
          />
          <AppWorkspace.SidebarIconAction
            icon="ti ti-chart-dots"
            label={t().metrics}
            active={props.activeView === "activity-metrics" || props.activeView === "metric-detail"}
            onClick={props.openActivityMetrics}
          />
        </AppWorkspace.SidebarIconGrid>
        <AppWorkspace.SidebarFooter sidebarMode="expanded">
          <AppWorkspace.SidebarItem icon="ti ti-settings" disabled={props.settingsDisabled} onClick={() => void props.openSettings()}>
            {t().settings}
          </AppWorkspace.SidebarItem>
        </AppWorkspace.SidebarFooter>
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
  );
}
