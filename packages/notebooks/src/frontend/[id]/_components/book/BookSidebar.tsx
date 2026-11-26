import { registerContextAwareCommand } from "@k2b/cloud/browser/commands";
import { WorkspaceNavigationProvider } from "@k2b/cloud/ssr/islands";
import { toggleWorkspaceSidebar } from "@k2b/ui/v2";
import { createEffect, createSignal, mergeProps, onCleanup, onMount } from "solid-js";
import BookNavigatorBody, { type BookNavigatorProps, useBookNavigator } from "./BookNavigatorBody";

/**
 * Book's navigation in the workspace's sidebar, and on the phone in the shell's menu. Book's head offers the views,
 * so the navigation does not offer the way into the workspace a second time. Cloud's search offers to hide or show it,
 * as the workspace's own button and Mod+Alt+S do.
 */
export default function BookSidebar(props: BookNavigatorProps) {
  const navigator = useBookNavigator(mergeProps(props, { workspaceEntry: false }));
  const { workspaceText } = navigator;
  const [hidden, setHidden] = createSignal(false);
  onMount(() => {
    // the workspace says whether its sidebar is hidden; the command's words follow it
    const workspace = document.querySelector<HTMLElement>("[data-k2-workspace]");
    if (!workspace) return;
    const follow = () => setHidden(workspace.hasAttribute("data-collapsed"));
    follow();
    const watch = new MutationObserver(follow);
    watch.observe(workspace, { attributes: true, attributeFilter: ["data-collapsed"] });
    onCleanup(() => watch.disconnect());
  });
  createEffect(() => {
    const now = hidden();
    onCleanup(
      registerContextAwareCommand({
        id: "notebooks.navigation.toggle",
        title: now ? workspaceText().showNavigationCommand : workspaceText().hideNavigationCommand,
        description: workspaceText().navigationCommandDescription,
        icon: now ? "ti ti-layout-sidebar-left-expand" : "ti ti-layout-sidebar-left-collapse",
        action: () => void toggleWorkspaceSidebar(),
      }),
    );
  });
  return (
    <>
      {/* k2b-ui gap: Nav tree – the phone menu keeps the v1 navigation with the whole tree. */}
      <WorkspaceNavigationProvider navigation={navigator.mobileNavigation} label={navigator.state().notebookName} />
      <BookNavigatorBody navigator={navigator} />
    </>
  );
}
