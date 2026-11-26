import { WorkspaceNavigationProvider } from "@k2b/cloud/ssr/islands";
import { mergeProps } from "solid-js";
import BookNavigatorBody, { type BookNavigatorProps, useBookNavigator } from "./BookNavigatorBody";

/**
 * Book's navigation in the workspace's sidebar, and on the phone in the shell's menu. Book's head offers the views,
 * so the navigation does not offer the way into the workspace a second time.
 */
export default function BookSidebar(props: BookNavigatorProps) {
  const navigator = useBookNavigator(mergeProps(props, { workspaceEntry: false }));
  return (
    <>
      {/* k2b-ui gap: Nav tree – the phone menu keeps the v1 navigation with the whole tree. */}
      <WorkspaceNavigationProvider navigation={navigator.mobileNavigation} label={navigator.state().notebookName} />
      <BookNavigatorBody navigator={navigator} />
    </>
  );
}
