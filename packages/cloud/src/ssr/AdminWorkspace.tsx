import { Nav, type NavProps, Workspace, type WorkspaceProps } from "@k2b/ui/v2";
import V2WorkspaceNavigation from "./V2WorkspaceNavigation";

export type AdminWorkspaceProps = Omit<WorkspaceProps, "sidebar" | "sidebarLabel"> & {
  /** The admin bar as the server built it with `adminNavigation(c)`. */
  nav: NavProps;
};

/**
 * The frame of a v2 admin screen, rendered inside the screen's island on a page with `AdminLayout ui="v2"`: the admin
 * bar as the `Workspace` sidebar (a drawer where it does not fit) and as the shell's menu on the phone, around the
 * screen's head and columns. An admin screen returns one of these instead of its own `Workspace`.
 */
export default function AdminWorkspace(props: AdminWorkspaceProps) {
  return (
    <>
      <V2WorkspaceNavigation label={props.nav.title} groups={props.nav.groups} />
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
