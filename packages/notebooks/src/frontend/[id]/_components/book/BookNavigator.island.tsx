import { WorkspaceNavigationProvider } from "@k2b/cloud/ssr/islands";
import { AppWorkspace } from "@k2b/ui";
import NavigationVisibilityControls from "../sidebar/NavigationVisibilityControls";
import { NOTEBOOK_NAVIGATION_ID, setNavigationHidden } from "../sidebar/navigation-visibility";
import BookNavigatorBody, { type BookNavigatorProps, useBookNavigator } from "./BookNavigatorBody";

export type { BookNavigatorProps, BookTreeNode } from "./BookNavigatorBody";

/** Book's navigation in the v1 frame: only test harnesses still use it, until the v1 sidebars' cleanup. */
export default function BookNavigator(props: BookNavigatorProps) {
  const navigator = useBookNavigator(props);
  const { workspaceText, state, navigationHidden, mobileNavigation } = navigator;
  return (
    <>
      <WorkspaceNavigationProvider navigation={mobileNavigation} label={state().notebookName} />
      <AppWorkspace.Sidebar
        id={NOTEBOOK_NAVIGATION_ID}
        label={workspaceText().navigation}
        resizable
        hidden={navigationHidden()}
        onHiddenChange={setNavigationHidden}
      >
        <AppWorkspace.SidebarDesktop>
          <BookNavigatorBody navigator={navigator} current={props.current} />
        </AppWorkspace.SidebarDesktop>
      </AppWorkspace.Sidebar>
      {/* Book view has no editor toolbar, so it offers the visible way back; the graph's own toolbar holds the toggle. */}
      <NavigationVisibilityControls hidden={navigationHidden()} showControl={props.current !== "graph"} />
    </>
  );
}
