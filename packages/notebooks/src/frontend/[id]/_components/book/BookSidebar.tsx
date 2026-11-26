import { registerContextAwareCommand } from "@k2b/cloud/browser/commands";
import { WorkspaceNavigationProvider } from "@k2b/cloud/ssr/islands";
import { toggleWorkspaceSidebar } from "@k2b/ui/v2";
import { createEffect, createSignal, mergeProps, onCleanup, onMount } from "solid-js";
import BookNavigatorBody, { type BookNavigatorProps, useBookNavigator } from "./BookNavigatorBody";

/** How the workspace shows its sidebar now: a column it can hide, a drawer it can open, or neither (the phone). */
type SidebarState = { place: "column" | "drawer" | "none"; hidden: boolean };

/**
 * Book's navigation in the workspace's sidebar, and on the phone in the shell's menu. Book's head offers the views,
 * so the navigation does not offer the way into the workspace a second time. Where the workspace can hide or open its
 * sidebar, Cloud's search offers that too, as the workspace's own buttons and Mod+Alt+S do.
 */
export default function BookSidebar(props: BookNavigatorProps) {
  const navigator = useBookNavigator(mergeProps(props, { workspaceEntry: false }));
  const { workspaceText } = navigator;
  const [sidebar, setSidebar] = createSignal<SidebarState>(
    { place: "none", hidden: false },
    { equals: (a, b) => a.place === b.place && a.hidden === b.hidden },
  );
  onMount(() => {
    const workspace = document.querySelector<HTMLElement>("[data-k2-workspace]");
    if (!workspace) return;
    // k2b-ui gap: the workspace tells no sidebar state of its own; its two buttons in the head say where the sidebar
    // stands (the collapse while it is a column, the drawer's button while it is a drawer) and whether it shows.
    const read = () => {
      const button = (name: string) => {
        const element = workspace.querySelector<HTMLElement>(`[data-slot="head"] > .k2-ws-${name}`);
        return element && element.getClientRects().length > 0 ? element : null;
      };
      const collapse = button("collapse");
      const drawer = button("toggle");
      setSidebar(
        collapse
          ? { place: "column", hidden: workspace.hasAttribute("data-collapsed") }
          : drawer
            ? { place: "drawer", hidden: drawer.getAttribute("aria-expanded") !== "true" }
            : { place: "none", hidden: false },
      );
    };
    read();
    const watch = new MutationObserver(read);
    watch.observe(workspace, { attributes: true, attributeFilter: ["data-collapsed", "aria-expanded"], subtree: true });
    const sizes = new ResizeObserver(read);
    sizes.observe(workspace);
    onCleanup(() => {
      watch.disconnect();
      sizes.disconnect();
    });
  });
  createEffect(() => {
    const { place, hidden } = sidebar();
    // the phone has no sidebar to hide: its pages are in the shell's menu
    if (place === "none") return;
    onCleanup(
      registerContextAwareCommand({
        id: "notebooks.navigation.toggle",
        title: hidden ? workspaceText().showNavigationCommand : workspaceText().hideNavigationCommand,
        description: workspaceText().navigationCommandDescription,
        icon: hidden ? "ti ti-layout-sidebar-left-expand" : "ti ti-layout-sidebar-left-collapse",
        action: () => void toggleWorkspaceSidebar(),
      }),
    );
  });
  return (
    <>
      {/* k2b-ui gap: Nav tree (#4283) – the phone menu keeps the v1 navigation with the whole tree. */}
      <WorkspaceNavigationProvider navigation={navigator.mobileNavigation} label={navigator.state().notebookName} />
      <BookNavigatorBody navigator={navigator} />
    </>
  );
}
