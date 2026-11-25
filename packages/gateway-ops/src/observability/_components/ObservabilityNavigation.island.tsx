import type { AdminAreaGroup } from "@k2b/cloud/ssr";
import { WorkspaceNavigationProvider } from "@k2b/cloud/ssr/islands";
import { createNavigation, type NavigationItem } from "@k2b/ui";

/** The area's sections for the shell's navigation on a v2 page, where the v2 sidebar leaves on the phone. */
export default function ObservabilityNavigation(props: { label: string; current: string; groups: AdminAreaGroup[] }) {
  const navigation = createNavigation({
    items: () =>
      props.groups.flatMap((group): NavigationItem[] => {
        const items = group.items.map((item) => ({
          id: item.id,
          label: item.label,
          href: item.href,
          icon: item.icon,
          active: item.id === props.current,
        }));
        return group.title ? [{ id: group.title, label: group.title, children: items }] : items;
      }),
  });
  return <WorkspaceNavigationProvider navigation={navigation} label={props.label} />;
}
