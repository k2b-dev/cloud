import { fuzzy, i18n } from "@k2b/stdlib";
import { Button, LinkCard, Paper, Placeholder, TextInput, useLocale } from "@k2b/ui";
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { categoryOrder, type LocalizedTool, resolveRegistry, type ToolCategory } from "./tools/registry";

export const toolCatalogMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      searchLabel: "Search tools",
      searchPlaceholder: 'What do you want to do? Try "resize image" or "random ID"',
      quickTools: "Used often",
      quickToolsHint: "Common tasks, one click away.",
      searchResults: "Search results",
      browseAll: "Browse all",
      matchingTools: ({ count }: { count: number }) =>
        i18n.plural(count, "en", { one: `${count} matching tool.`, other: `${count} matching tools.` }),
      groupedByTask: "Images, documents, text, security, and network.",
      emptyTitle: "No tools match this task",
      emptyDescription: "Try a tool name, format, or action.",
      clearSearch: "Clear search",
    },
    de: {
      searchLabel: "Werkzeuge suchen",
      searchPlaceholder: "Was möchtest du tun? Probiere „Bild skalieren“ oder „zufällige ID“",
      quickTools: "Oft gebraucht",
      quickToolsHint: "Werkzeuge für häufige Aufgaben.",
      searchResults: "Suchergebnisse",
      browseAll: "Alle Werkzeuge",
      matchingTools: ({ count }) =>
        i18n.plural(count, "de", { one: `${count} passendes Werkzeug.`, other: `${count} passende Werkzeuge.` }),
      groupedByTask: "Bilder, Dokumente, Text, Sicherheit und Netzwerk.",
      emptyTitle: "Kein Werkzeug passt zu dieser Aufgabe",
      emptyDescription: "Suche nach einem Werkzeug, Format oder Arbeitsschritt.",
      clearSearch: "Suche zurücksetzen",
    },
  },
});

const toolHref = (tool: LocalizedTool): string => `/tools/${tool.id}`;

const ToolIcon = (props: { tool: LocalizedTool }) => (
  <span class="tools-tool-icon k2b-icon-tile app-accent-text">
    <i class={`${props.tool.icon} text-base`} />
  </span>
);

const ToolRow = (props: { tool: LocalizedTool }) => (
  <a
    href={toolHref(props.tool)}
    class="focus-ui group/tool flex min-h-14 items-center gap-3 rounded-[var(--ui-radius-control)] px-2 py-2 transition-colors hover:bg-[var(--ui-hover)]"
  >
    <ToolIcon tool={props.tool} />
    <span class="min-w-0 flex-1">
      <span class="block truncate text-sm font-medium text-secondary transition-colors group-hover/tool:app-accent-text">
        {props.tool.name}
      </span>
      <span class="block truncate text-xs text-dimmed">{props.tool.description}</span>
    </span>
  </a>
);

export default function ToolCatalog(props: { initialQuery?: string }) {
  const locale = useLocale();
  const t = () => toolCatalogMessages.resolve([locale()]).t;
  const registry = createMemo(() => resolveRegistry(locale()));
  let searchInput: HTMLInputElement | undefined;
  const [query, setQuery] = createSignal(props.initialQuery ?? "");
  const normalizedQuery = createMemo(() => query().trim().toLowerCase());
  const matches = createMemo(() => {
    const needle = normalizedQuery();
    const { tools, searchText } = registry();
    return needle ? fuzzy.filter(needle, tools, { key: searchText }).map((hit) => hit.item) : tools;
  });
  const featured = createMemo(() => registry().tools.filter((tool) => tool.featured));
  const toolsForGroup = (group: ToolCategory) => matches().filter((tool) => tool.category === group);
  const updateQuery = (value: string) => {
    setQuery(value);
    const url = new URL(window.location.href);
    if (value) url.searchParams.set("q", value);
    else url.searchParams.delete("q");
    window.history.replaceState(window.history.state, "", url);
  };
  onMount(() => {
    const restore = () => setQuery(new URL(window.location.href).searchParams.get("q") ?? "");
    window.addEventListener("popstate", restore);
    onCleanup(() => window.removeEventListener("popstate", restore));
  });

  return (
    <div class="flex flex-col gap-5">
      <TextInput
        ref={(element) => {
          searchInput = element;
        }}
        type="search"
        aria-label={t().searchLabel}
        icon="ti ti-search"
        value={query}
        onValueChange={updateQuery}
        onClear={() => updateQuery("")}
        placeholder={t().searchPlaceholder}
        clearable
        autocomplete="off"
        spellcheck={false}
      />

      <Show when={!normalizedQuery()}>
        <section class="flex flex-col gap-2" aria-labelledby="quick-tools-title">
          <header>
            <h3 id="quick-tools-title" class="text-sm font-semibold text-primary">
              {t().quickTools}
            </h3>
            <p class="text-xs text-dimmed">{t().quickToolsHint}</p>
          </header>
          <div class="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            <For each={featured()}>
              {(tool) => (
                <LinkCard
                  href={toolHref(tool)}
                  title={tool.name}
                  description={registry().categories[tool.category].label}
                  icon={tool.icon}
                />
              )}
            </For>
          </div>
        </section>
      </Show>

      <section class="flex flex-col gap-2" aria-labelledby="all-tools-title">
        <header>
          <h3 id="all-tools-title" class="text-sm font-semibold text-primary">
            {normalizedQuery() ? t().searchResults : t().browseAll}
          </h3>
          <p class="text-xs text-dimmed">{normalizedQuery() ? t().matchingTools({ count: matches().length }) : t().groupedByTask}</p>
        </header>

        <Show
          when={matches().length > 0}
          fallback={
            <Placeholder
              state="no-results"
              title={t().emptyTitle}
              description={t().emptyDescription}
              action={
                <Button
                  variant="secondary"
                  onClick={() => {
                    updateQuery("");
                    searchInput?.focus();
                  }}
                >
                  {t().clearSearch}
                </Button>
              }
            />
          }
        >
          <div class="grid gap-x-5 gap-y-4 lg:grid-cols-2">
            <For each={categoryOrder}>
              {(group) => {
                const groupTools = () => toolsForGroup(group);
                return (
                  <Show when={groupTools().length > 0}>
                    <Paper as="section" class="min-w-0 p-3" aria-labelledby={`tool-group-${group}`}>
                      <header class="flex min-h-9 items-start gap-2 px-2 py-1.5">
                        <i class={`${registry().categories[group].icon} app-accent-text mt-0.5 text-sm`} />
                        <span class="min-w-0 flex-1">
                          <h4 id={`tool-group-${group}`} class="text-sm font-medium text-primary">
                            {registry().categories[group].label}
                          </h4>
                        </span>
                        <span class="text-sm font-semibold tabular-nums text-secondary">{groupTools().length}</span>
                      </header>
                      <div class="flex flex-col">
                        <For each={groupTools()}>{(tool) => <ToolRow tool={tool} />}</For>
                      </div>
                    </Paper>
                  </Show>
                );
              }}
            </For>
          </div>
        </Show>
      </section>
    </div>
  );
}
