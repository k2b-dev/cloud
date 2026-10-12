import type { NavigationController } from "@k2b/ui";
import { provideWorkspaceNavigation } from "./workspace-navigation";

/** Use within an existing app island when navigation includes local actions. */
export default function WorkspaceNavigationProvider(props: { navigation: NavigationController; label: string }) {
  let owner!: HTMLScriptElement;
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
