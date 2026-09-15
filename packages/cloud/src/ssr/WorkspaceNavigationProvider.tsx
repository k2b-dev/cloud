import type { NavigationController } from "@k2b/ui";
import { provideWorkspaceNavigation } from "./workspace-navigation";

/** Use within an existing app island when navigation includes local actions. */
export default function WorkspaceNavigationProvider(props: { navigation: NavigationController; label: string }) {
  let owner!: HTMLScriptElement;
  provideWorkspaceNavigation(props.navigation, { label: () => props.label, owner: () => owner });
  return (
    <script
      ref={owner}
      type="application/json"
      data-cloud-workspace-navigation
      innerHTML={JSON.stringify({ label: props.label, items: props.navigation.items() }).replace(/</g, "\\u003c")}
    />
  );
}
