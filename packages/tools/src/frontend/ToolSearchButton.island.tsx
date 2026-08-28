import { navigateTo } from "@k2b/ssr/nav";
import { fuzzy, i18n } from "@k2b/stdlib";
import {
  AppWorkspace,
  isSpotlightShortcut,
  openSpotlightSearch,
  SPOTLIGHT_SHORTCUT_TITLE,
  SpotlightButton,
  type SpotlightButtonVariant,
  useLocale,
} from "@k2b/ui";
import { createMemo, onCleanup, onMount } from "solid-js";
import { categoryOrder, type LocalizedTool, resolveRegistry } from "./tools/registry";

export const toolSearchMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      searchTools: "Search tools",
      searchToolsLabel: "Search Tools",
      searchPlaceholder: "Search tools...",
      noResults: "No tools found.",
      searchToolsWithShortcut: ({ shortcut }: { shortcut: string }) => `Search tools (${shortcut})`,
    },
    de: {
      searchTools: "Werkzeuge suchen",
      searchToolsLabel: "Werkzeuge suchen",
      searchPlaceholder: "Werkzeuge suchen...",
      noResults: "Keine Werkzeuge gefunden.",
      searchToolsWithShortcut: ({ shortcut }) => `Werkzeuge suchen (${shortcut})`,
    },
  },
});

type Props = {
  variant?: SpotlightButtonVariant;
  registerShortcut?: boolean;
};

const categoryRank = new Map(categoryOrder.map((category, index) => [category, index]));

const toolHref = (tool: LocalizedTool) => `/tools/${tool.id}`;

export default function ToolSearchButton(props: Props) {
  const locale = useLocale();
  const t = () => toolSearchMessages.resolve([locale()]).t;
  const registry = createMemo(() => resolveRegistry(locale()));
  const orderedTools = createMemo(() =>
    [...registry().tools].sort((a, b) => {
      if (Boolean(a.featured) !== Boolean(b.featured)) return a.featured ? -1 : 1;
      const categoryDiff = (categoryRank.get(a.category) ?? 0) - (categoryRank.get(b.category) ?? 0);
      return categoryDiff === 0 ? a.name.localeCompare(b.name, registry().locale, { sensitivity: "base" }) : categoryDiff;
    }),
  );

  const openSearch = async () => {
    const selected = await openSpotlightSearch<LocalizedTool>({
      title: t().searchTools,
      icon: "ti ti-tools",
      placeholder: t().searchPlaceholder,
      minQueryLength: 0,
      noResultsText: t().noResults,
      resolve: ({ query }) => {
        const needle = query.trim().toLowerCase();
        const { categories, searchText } = registry();
        const matches = needle ? fuzzy.filter(needle, orderedTools(), { key: searchText }).map((hit) => hit.item) : orderedTools();

        return matches.map((tool) => ({
          value: tool,
          label: tool.name,
          desc: `${categories[tool.category].label} - ${tool.description}`,
          icon: tool.icon,
        }));
      },
    });

    if (selected?.value) navigateTo(toolHref(selected.value));
  };

  onMount(() => {
    if (!props.registerShortcut) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (!isSpotlightShortcut(event)) return;
      event.preventDefault();
      void openSearch();
    };
    window.addEventListener("keydown", onKeyDown);
    onCleanup(() => window.removeEventListener("keydown", onKeyDown));
  });

  if (props.variant === "icon") {
    return <AppWorkspace.SidebarIconAction icon="ti ti-search" label={t().searchTools} onClick={() => void openSearch()} />;
  }

  return (
    <SpotlightButton
      variant={props.variant}
      label={t().searchToolsLabel}
      onClick={openSearch}
      title={t().searchToolsWithShortcut({ shortcut: SPOTLIGHT_SHORTCUT_TITLE })}
      ariaLabel={t().searchTools}
    />
  );
}
