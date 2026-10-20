import { WorkspaceNavigationProvider } from "@k2b/cloud/ssr/islands";
import { AppWorkspace, createNavigation } from "@k2b/ui";
import type { PulseBase } from "../../contracts";
import { usePulseMessages } from "../use-messages";
import type { WorkspaceView } from "./types";

type Props = {
  title: string;
  bases: PulseBase[];
  baseId: string;
  activeView: WorkspaceView;
  sourceCount: number;
  settingsDisabled: boolean;
  openSettings: () => void | Promise<void>;
  openSources: () => void;
  openComingBack: () => void;
};

export default function PulseSidebar(props: Props) {
  const t = usePulseMessages();
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
        id: "sources",
        label: t().sources,
        icon: "ti ti-database",
        action: "sources",
        badge: props.sourceCount,
        active: props.activeView === "sources",
      },
      {
        id: "coming-back",
        label: t().dashboardsAndQuestions,
        icon: "ti ti-chart-area-line",
        action: "coming-back",
        active: props.activeView === "coming-back",
      },
      { id: "settings", label: t().settings, icon: "ti ti-settings", action: "settings", disabled: props.settingsDisabled },
    ],
    onAction: async (action) => {
      if (action === "sources") props.openSources();
      else if (action === "coming-back") props.openComingBack();
      else if (action === "settings") await props.openSettings();
    },
  });
  return (
    <>
      <WorkspaceNavigationProvider navigation={navigation} label={props.title} />
      <AppWorkspace.Sidebar collapsible>
        <AppWorkspace.SidebarDesktop>
          <AppWorkspace.SidebarSwitcher {...switcher()} />
          <AppWorkspace.SidebarBody scrollPreserveKey="pulse-sidebar" sidebarMode="expanded">
            <AppWorkspace.SidebarItem
              icon="ti ti-database"
              active={props.activeView === "sources"}
              onClick={props.openSources}
              meta={props.sourceCount}
            >
              {t().sources}
            </AppWorkspace.SidebarItem>
            <AppWorkspace.SidebarItem
              icon="ti ti-chart-area-line"
              active={props.activeView === "coming-back"}
              onClick={props.openComingBack}
            >
              {t().dashboardsAndQuestions}
            </AppWorkspace.SidebarItem>
          </AppWorkspace.SidebarBody>
          <AppWorkspace.SidebarIconGrid sidebarMode="collapsed">
            <AppWorkspace.SidebarIconAction
              icon="ti ti-database"
              label={t().sources}
              active={props.activeView === "sources"}
              onClick={props.openSources}
            />
            <AppWorkspace.SidebarIconAction
              icon="ti ti-chart-area-line"
              label={t().dashboardsAndQuestions}
              active={props.activeView === "coming-back"}
              onClick={props.openComingBack}
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
    </>
  );
}
