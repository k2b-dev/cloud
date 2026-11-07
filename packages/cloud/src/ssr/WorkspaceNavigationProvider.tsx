import type { NavigationController } from "@k2b/ui";
import { isServer } from "solid-js/web";
import { markShellContent } from "./shell-content-state";
import { provideWorkspaceNavigation } from "./workspace-navigation";

/** Use within an existing app island when navigation includes local actions. */
export default function WorkspaceNavigationProvider(props: { navigation: NavigationController; label: string }) {
  let owner!: HTMLScriptElement;
  // The phone header shows the navigation's menu instead of the app title.
  if (isServer) markShellContent("workspaceNavigation");
  provideWorkspaceNavigation(props.navigation, { label: () => props.label, owner: () => owner });
  const snapshot = () => {
    const switcher = props.navigation.switcher?.();
    return {
      label: props.label,
      items: props.navigation.items(),
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
      innerHTML={JSON.stringify(snapshot()).replace(/</g, "\\u003c")}
    />
  );
}
