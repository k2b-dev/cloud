import { Nav, type NavItem, type NavProps, Workspace, type WorkspaceProps } from "@k2b/ui/v2";
import V2WorkspaceNavigation from "./V2WorkspaceNavigation";

export type AdminWorkspaceProps = Omit<WorkspaceProps, "sidebar" | "sidebarLabel"> & {
  /** The admin bar as the server built it with `adminNavigation(c)`. */
  nav: NavProps;
};

/** The open entry of the admin bar, also inside a folding entry; the bar's own title when none is open. */
const openLabel = (nav: NavProps): string => {
  const find = (items: readonly NavItem[]): string | undefined => {
    for (const item of items) {
      if (item.current) return item.label;
      const inner = item.items ? find(item.items) : undefined;
      if (inner) return inner;
    }
    return undefined;
  };
  for (const group of nav.groups) {
    const found = find(group.items);
    if (found) return found;
  }
  return nav.title;
};

/**
 * The frame of a v2 admin screen, rendered inside the screen's island on a page with `AdminLayout ui="v2"`: the admin
 * bar as the `Workspace` sidebar (a drawer where it does not fit) and as the shell's menu on the phone, around the
 * screen's head and columns. An admin screen returns one of these instead of its own `Workspace`. The open entry
 * names the page: in the bar, and on the phone in the shell's bar, so the screen's head never repeats it.
 */
export default function AdminWorkspace(props: AdminWorkspaceProps) {
  return (
    <>
      <V2WorkspaceNavigation label={openLabel(props.nav)} groups={props.nav.groups} />
      <Workspace
        sidebar={<Nav title={props.nav.title} icon={props.nav.icon} groups={props.nav.groups} />}
        head={props.head}
        primary={props.primary}
        detail={props.detail}
        detailEmpty={props.detailEmpty}
        sidebarWidth={props.sidebarWidth}
      >
        {props.children}
      </Workspace>
    </>
  );
}
