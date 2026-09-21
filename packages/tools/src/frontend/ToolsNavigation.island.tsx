import { WorkspaceNavigationProvider } from "@k2b/cloud/ssr/islands";
import { createNavigation, useLocale } from "@k2b/ui";
import { createToolSearch, toolSearchMessages } from "./tool-search";
import { categoryOrder, resolveRegistry } from "./tools/registry";

export default function ToolsNavigation(props: { activeToolId?: string; overviewLabel: string }) {
  const locale = useLocale();
  const registry = () => resolveRegistry(locale());
  const search = createToolSearch();
  const navigation = createNavigation({
    items: () => [
      { id: "overview", label: props.overviewLabel, href: "/tools", icon: "ti ti-layout-grid", active: !props.activeToolId },
      { id: "search", label: toolSearchMessages.resolve([locale()]).t.searchTools, action: "search", icon: "ti ti-search" },
      ...categoryOrder.map((category) => ({
        id: category,
        label: registry().categories[category].label,
        children: registry()
          .tools.filter((tool) => tool.category === category)
          .map((tool) => ({
            id: tool.id,
            label: tool.name,
            icon: tool.icon,
            href: `/tools/${tool.id}`,
            active: props.activeToolId === tool.id,
            description: tool.featured ? "★" : undefined,
          })),
      })),
    ],
    onAction: (action) => {
      if (action === "search") return search();
    },
  });
  return <WorkspaceNavigationProvider navigation={navigation} label="Tools" />;
}
