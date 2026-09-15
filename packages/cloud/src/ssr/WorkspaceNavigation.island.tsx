import { createNavigation, type NavigationItem } from "@k2b/ui";
import WorkspaceNavigationProvider from "./WorkspaceNavigationProvider";

/** SSR-first link navigation. Use provideWorkspaceNavigation for island-owned actions. */
export default function WorkspaceNavigation(props: { items: readonly NavigationItem[]; label: string }) {
  return <WorkspaceNavigationProvider navigation={createNavigation({ items: () => props.items })} label={props.label} />;
}
