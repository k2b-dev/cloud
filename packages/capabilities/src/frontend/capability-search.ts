import { navigateTo } from "@k2b/ssr/nav";
import { openSpotlightSearch, useLocale } from "@k2b/ui";
import { capabilityUiMessages } from "./messages";

export type CapabilitySearchEntry = {
  href: string;
  label: string;
  description: string;
  icon: string;
};

export function createCapabilitySearch(props: { entries: CapabilitySearchEntry[] }) {
  const locale = useLocale();
  const t = () => capabilityUiMessages.resolve([locale()]).t;
  const openSearch = async () => {
    const selected = await openSpotlightSearch<CapabilitySearchEntry>({
      title: t().search,
      icon: "ti ti-api-app",
      placeholder: t().searchPlaceholder,
      noResultsText: t().noSearchResults,
      resolve: ({ query }) => {
        const needle = query.trim().toLocaleLowerCase();
        return props.entries
          .filter((entry) => !needle || `${entry.label} ${entry.description}`.toLocaleLowerCase().includes(needle))
          .map((entry) => ({
            value: entry,
            label: entry.label,
            desc: entry.description,
            icon: entry.icon,
          }));
      },
    });

    if (selected?.value) navigateTo(selected.value.href);
  };

  return openSearch;
}
