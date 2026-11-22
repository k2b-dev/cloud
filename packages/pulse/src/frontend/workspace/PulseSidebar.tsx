import { WorkspaceNavigationProvider } from "@k2b/cloud/ssr/islands";
import { AppWorkspace, createNavigation } from "@k2b/ui";
import type { JSX } from "solid-js";
import type { PulseBase } from "../../contracts";
import { usePulseMessages } from "../use-messages";
import type { WorkspaceView } from "./types";

type Props = {
  title: string;
  bases: PulseBase[];
  baseId: string;
  activeView: WorkspaceView;
  sourceCount: number;
  /** Fired alerts and alerts that cannot be checked, shown on Sources. */
  attentionCount?: number;
  settingsDisabled: boolean;
  openSettings: () => void | Promise<void>;
  openSql: () => void;
  openSources: () => void;
};

export default function PulseSidebar(props: Props) {
  const t = usePulseMessages();
  const switcher = () => {
    const base = props.bases.find((base) => base.id === props.baseId);
    return { ...baseSwitcher(props, t), description: base ? t().baseMembers({ count: base.memberCount }) : t().base };
  };
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
      { id: "sql", label: "SQL", icon: "ti ti-code", action: "sql", active: props.activeView === "sql" },
      { id: "settings", label: t().settings, icon: "ti ti-settings", action: "settings", disabled: props.settingsDisabled },
    ],
    onAction: async (action) => {
      if (action === "sql") props.openSql();
      else if (action === "sources") props.openSources();
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
              icon="ti ti-database"
              active={props.activeView === "sources"}
              onClick={props.openSources}
              meta={props.sourceCount}
            >
              {t().sources}
            </AppWorkspace.SidebarItem>
            <AppWorkspace.SidebarItem
              class="pulse-sidebar__chip"
              icon="ti ti-code"
              active={props.activeView === "sql"}
              onClick={props.openSql}
            >
              SQL
            </AppWorkspace.SidebarItem>
            <AppWorkspace.SidebarItem
              class="pulse-sidebar__secondary"
              icon="ti ti-settings"
              disabled={props.settingsDisabled}
              onClick={() => void props.openSettings()}
            >
              {t().settings}
            </AppWorkspace.SidebarItem>
          </AppWorkspace.SidebarBody>
          <AppWorkspace.SidebarIconGrid sidebarMode="collapsed">
            <AppWorkspace.SidebarIconAction
              icon="ti ti-database"
              label={t().sources}
              active={props.activeView === "sources"}
              onClick={props.openSources}
            />
            <AppWorkspace.SidebarIconAction icon="ti ti-code" label="SQL" active={props.activeView === "sql"} onClick={props.openSql} />
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
