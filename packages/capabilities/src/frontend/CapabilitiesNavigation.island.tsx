import { createNavigation, type NavigationItem, useLocale } from "@k2b/ui";
import { WorkspaceNavigationProvider } from "@k2b/cloud/ssr/islands";
import { createCapabilitySearch, type CapabilitySearchEntry } from "./capability-search";
import { capabilityUiMessages } from "./messages";

export default function CapabilitiesNavigation(props: { items: readonly NavigationItem[]; entries: CapabilitySearchEntry[] }) {
  const locale = useLocale();
  const t = () => capabilityUiMessages.resolve([locale()]).t;
  const search = createCapabilitySearch(props);
  const navigation = createNavigation({
    items: () => [{ id: "search", label: t().search, icon: "ti ti-search", action: "search" }, ...props.items],
    onAction: (action) => {
      if (action === "search") return search();
    },
  });
  return <WorkspaceNavigationProvider navigation={navigation} label={t().capabilities} />;
}
