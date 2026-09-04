import { AppWorkspace } from "@k2b/ui";
import { createSignal, onCleanup, onMount } from "solid-js";
import { useSpaceMessages } from "../../messages";
import type { ViewType } from "../settings/SpaceSettingsStore";
import { SPACES_DETAIL_NAVIGATION_EVENT, type SpacesDetailNavigation } from "../workspace/workspace-events";

type Props = {
  spaceId: string;
  query: string;
  currentView: ViewType;
  variant: "mobile" | "desktop" | "collapsed";
};

export default function ViewLinks(props: Props) {
  const t = useSpaceMessages();
  const [query, setQuery] = createSignal(props.query);
  const path = `/app/spaces/${props.spaceId}`;
  const views: Array<{ id: ViewType; label: string; icon: string }> = [
    { id: "list", label: t.overview, icon: "ti-home" },
    { id: "table", label: t.table, icon: "ti-table" },
    { id: "kanban", label: t.kanban, icon: "ti-layout-kanban" },
    { id: "calendar", label: t.calendar, icon: "ti-calendar" },
  ];
  onMount(() => {
    if (window.location.pathname === path) setQuery(window.location.search);
    const onCommitted = (event: Event) => {
      const detail = (event as CustomEvent<SpacesDetailNavigation>).detail;
      if (detail?.history !== "none") return;
      const url = new URL(detail.href, window.location.origin);
      if (url.pathname === path) setQuery(url.search);
    };
    window.addEventListener(SPACES_DETAIL_NAVIGATION_EVENT, onCommitted);
    onCleanup(() => window.removeEventListener(SPACES_DETAIL_NAVIGATION_EVENT, onCommitted));
  });
  const href = (view: ViewType) => {
    const params = new URLSearchParams(query());
    params.set("view", view);
    return `${path}?${params}`;
  };

  return views.map((view) =>
    props.variant === "collapsed" ? (
      <AppWorkspace.SidebarIconAction
        href={href(view.id)}
        navigation="document"
        icon={view.icon}
        label={view.label}
        active={props.currentView === view.id}
      />
    ) : (
      <AppWorkspace.SidebarItem
        href={href(view.id)}
        data={{ mode: props.variant }}
        navigation="document"
        icon={view.icon}
        active={props.currentView === view.id}
        viewTransitionName={`space-sidebar-${props.spaceId}-view-${view.id}-${props.variant}`}
      >
        {view.label}
      </AppWorkspace.SidebarItem>
    ),
  );
}
