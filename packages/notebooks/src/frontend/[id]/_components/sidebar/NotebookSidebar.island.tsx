import { WorkspaceNavigationProvider } from "@k2b/cloud/ssr/islands";
import { AppWorkspace } from "@k2b/ui";
import NavigationVisibilityControls from "./NavigationVisibilityControls";
import NotebookSidebarBody from "./NotebookSidebarBody";
import { NOTEBOOK_NAVIGATION_ID, setNavigationHidden } from "./navigation-visibility";
import { type NotebookSidebarProps, useNotebookSidebar } from "./notebook-sidebar-state";

/**
 * The notebook's one sidebar: the notebook name, search, quick filters for favorites, recent notes and tags, and the
 * note tree. A filter turns the tree into a list with dates and tags, newest first. On phones the same content is
 * Cloud's navigation menu.
 */
export default function NotebookSidebar(props: NotebookSidebarProps) {
  const sidebar = useNotebookSidebar(props);
  const { t, notebook, navigationHidden, mobileNavigation } = sidebar;
  return (
    <>
      <WorkspaceNavigationProvider navigation={mobileNavigation} label={notebook().name} />
      <AppWorkspace.Sidebar
        id={NOTEBOOK_NAVIGATION_ID}
        class="notebook-sidebar"
        label={t().navigation}
        resizable
        defaultSize={256}
        hidden={navigationHidden()}
        onHiddenChange={setNavigationHidden}
      >
        <AppWorkspace.SidebarDesktop>
          <NotebookSidebarBody sidebar={sidebar} current={props.current} />
        </AppWorkspace.SidebarDesktop>
      </AppWorkspace.Sidebar>
      {/* Views without the editor toolbar, such as an empty notebook, Read-only or
          the attachments, still need a visible way back. The graph's own toolbar holds the toggle. */}
      <NavigationVisibilityControls hidden={navigationHidden()} showControl={!props.editorToolbar && props.current !== "graph"} />
    </>
  );
}
