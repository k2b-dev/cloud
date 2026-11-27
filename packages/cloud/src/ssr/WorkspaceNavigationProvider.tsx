import type { NavigationController, NavigationItem } from "@k2b/ui";
import { isServer } from "solid-js/web";
import { markShellContent } from "./shell-content-state";
import { provideWorkspaceNavigation } from "./workspace-navigation";

const holdsCurrent = (item: NavigationItem): boolean => !!item.active || (item.children ?? []).some(holdsCurrent);

/** The first `limit` rows of the tree in reading order, and beyond them only the way to the open entry. */
const firstRows = (items: readonly NavigationItem[], limit: number): NavigationItem[] => {
  let left = limit;
  const take = (list: readonly NavigationItem[]): NavigationItem[] =>
    list.flatMap((item) => {
      const shown = left > 0;
      if (shown) left--;
      const children = item.children ? take(item.children) : undefined;
      if (!shown && !holdsCurrent(item)) return [];
      return [children ? { ...item, children } : item];
    });
  return take(items);
};

/**
 * Use within an existing app island when navigation includes local actions. The page carries a snapshot of the
 * entries for a menu opened before the island runs; `entries` bounds it to that many rows (and the way to the open
 * one), so a long navigation does not weigh on every page.
 */
export default function WorkspaceNavigationProvider(props: { navigation: NavigationController; label: string; entries?: number }) {
  let owner!: HTMLScriptElement;
  // The phone header shows the navigation's menu instead of the app title.
  if (isServer) markShellContent("workspaceNavigation");
  provideWorkspaceNavigation(props.navigation, { label: () => props.label, owner: () => owner });
  const snapshot = () => {
    const switcher = props.navigation.switcher?.();
    return {
      label: props.label,
      items: props.entries === undefined ? props.navigation.items() : firstRows(props.navigation.items(), props.entries),
      ...(switcher
        ? {
            switcher: {
              currentId: switcher.currentId,
              label: switcher.label,
              description: switcher.description,
              icon: switcher.icon,
              color: switcher.color,
              switchLabel: switcher.switchLabel,
            },
          }
        : {}),
    };
  };
  return (
    <script
      ref={owner}
      type="application/json"
      data-cloud-workspace-navigation
      // a bounded snapshot is the server page's: in the browser the live island answers the menu itself, and making the
      // snapshot there would make every entry at once
      innerHTML={isServer || props.entries === undefined ? JSON.stringify(snapshot()).replace(/</g, "\\u003c") : ""}
    />
  );
}
