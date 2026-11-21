import { WorkspaceNavigationProvider } from "@k2b/cloud/ssr/islands";
import { AppWorkspace, createNavigation, type NavigationItem } from "@k2b/ui";
import { For } from "solid-js";
import type { PulseBase } from "../../contracts";
import { usePulseMessages } from "../use-messages";

export type BaseDot = "ok" | "danger" | "neutral";

type Props = {
  title: string;
  bases: PulseBase[];
  baseId: string;
  /** The dot of a base, when the page knows its state; bases without one show none. */
  dot: (base: PulseBase) => BaseDot | undefined;
  /** A switch to another base starts; the page shows its loading state until the new base arrives. */
  switching: (baseId: string) => void;
  /** The phone menu's entries: what waits in the head's "…". */
  menu: NavigationItem[];
  onMenu: (action: string) => void | Promise<void>;
};

const baseHref = (base: PulseBase) => `/app/pulse/${base.id}`;

/** Objects on the left (R1): the bases, each with its state dot; views and actions live in the head. */
export default function PulseSidebar(props: Props) {
  const t = usePulseMessages();
  const switcher = () => {
    const base = props.bases.find((base) => base.id === props.baseId);
    return { ...baseSwitcher(props, t), description: base ? t().baseMembers({ count: base.memberCount }) : t().base };
  };
  const navigation = createNavigation({ switcher, items: () => props.menu, onAction: props.onMenu });
  const dotLabel = (dot: BaseDot) => (dot === "ok" ? t().baseStateHealthy : dot === "danger" ? t().baseStateTrouble : t().baseStateEmpty);
  return (
    <>
      <WorkspaceNavigationProvider navigation={navigation} label={props.title} />
      <AppWorkspace.Sidebar label={t().appName} collapsible defaultSize={236}>
        <AppWorkspace.SidebarDesktop>
          <AppWorkspace.SidebarSection class="pulse-sidebar__identity" sidebarMode="expanded">
            <p>{t().appName}</p>
          </AppWorkspace.SidebarSection>
          <AppWorkspace.SidebarBody scrollPreserveKey="pulse-sidebar" sidebarMode="expanded">
            <AppWorkspace.SidebarSection title={t().basesTitle}>
              <For each={props.bases}>
                {(base) => (
                  <AppWorkspace.SidebarItem
                    icon={base.icon || "ti ti-activity-heartbeat"}
                    href={baseHref(base)}
                    navigation="enhanced"
                    onNavigate={() => {
                      if (base.id !== props.baseId) props.switching(base.id);
                    }}
                    active={base.id === props.baseId}
                    meta={(() => {
                      const dot = props.dot(base);
                      return dot ? <span class="pulse-dot" data-tone={dot} role="img" aria-label={dotLabel(dot)} /> : undefined;
                    })()}
                  >
                    {base.name}
                  </AppWorkspace.SidebarItem>
                )}
              </For>
              <AppWorkspace.SidebarItem class="pulse-sidebar__all" icon="ti ti-layout-grid" href="/app/pulse">
                {t().allBases}
              </AppWorkspace.SidebarItem>
            </AppWorkspace.SidebarSection>
          </AppWorkspace.SidebarBody>
          <AppWorkspace.SidebarIconGrid sidebarMode="collapsed">
            <For each={props.bases}>
              {(base) => (
                <AppWorkspace.SidebarIconAction
                  icon={base.icon || "ti ti-activity-heartbeat"}
                  label={base.name}
                  href={baseHref(base)}
                  active={base.id === props.baseId}
                />
              )}
            </For>
          </AppWorkspace.SidebarIconGrid>
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
  options: props.bases.map((base) => ({ id: base.id, label: base.name, href: baseHref(base) })),
  actions: [{ id: "all", label: t().yourBases, icon: "ti ti-layout-grid", href: "/app/pulse" }],
});
