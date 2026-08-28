import { fuzzy, i18n } from "@k2b/stdlib";
import { Placeholder, TextInput, useLocale } from "@k2b/ui";
import { createMemo, createSignal, For, Show } from "solid-js";
import { type LocalizedTool, resolveRegistry, type ToolTaskGroup, taskGroupOrder } from "./tools/registry";

export const toolCatalogMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      searchLabel: "Search tools",
      searchPlaceholder: 'What do you want to do? Try "resize image" or "random ID"',
      quickTools: "Quick tools",
      quickToolsHint: "Common tasks, one click away.",
      searchResults: "Search results",
      browseAll: "Browse all",
      matchingTools: ({ count }: { count: number }) =>
        i18n.plural(count, "en", { one: `${count} matching tool.`, other: `${count} matching tools.` }),
      groupedByTask: "Grouped by the task you want to complete.",
      emptyTitle: "No tools match this task",
      emptyDescription: "Try a tool name, format, or action.",
    },
    de: {
      searchLabel: "Werkzeuge suchen",
      searchPlaceholder: "Was möchtest du tun? Probiere „Bild skalieren“ oder „zufällige ID“",
      quickTools: "Schnellzugriff",
      quickToolsHint: "Werkzeuge für häufige Aufgaben.",
      searchResults: "Suchergebnisse",
      browseAll: "Alle Werkzeuge",
      matchingTools: ({ count }) =>
        i18n.plural(count, "de", { one: `${count} passendes Werkzeug.`, other: `${count} passende Werkzeuge.` }),
      groupedByTask: "Nach Aufgaben gruppiert.",
      emptyTitle: "Kein Werkzeug passt zu dieser Aufgabe",
      emptyDescription: "Suche nach einem Werkzeug, Format oder Arbeitsschritt.",
    },
  },
});

const toolHref = (tool: LocalizedTool): string => `/tools/${tool.id}`;

const ToolIcon = (props: { tool: LocalizedTool }) => (
  <span class="tools-tool-icon">
    <i class={`${props.tool.icon} text-base`} />
  </span>
);

const QuickTool = (props: { tool: LocalizedTool }) => (
  <a
    href={toolHref(props.tool)}
    class="paper focus-ui group/quick flex min-h-24 items-start gap-3 p-3 transition-colors hover:paper-highlighted"
  >
    <ToolIcon tool={props.tool} />
    <span class="min-w-0 flex-1">
      <span class="block text-sm font-semibold text-primary transition-colors group-hover/quick:app-accent-text">{props.tool.name}</span>
      <span class="mt-0.5 block text-xs leading-5 text-dimmed">{props.tool.description}</span>
    </span>
    <i class="ti ti-chevron-right mt-1 shrink-0 text-xs text-dimmed transition-transform group-hover/quick:translate-x-0.5 group-hover/quick:app-accent-text" />
  </a>
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
    <i class="ti ti-chevron-right shrink-0 text-xs text-dimmed transition-transform group-hover/tool:translate-x-0.5 group-hover/tool:app-accent-text" />
  </a>
);

export default function ToolCatalog() {
  const locale = useLocale();
  const t = () => toolCatalogMessages.resolve([locale()]).t;
  const registry = createMemo(() => resolveRegistry(locale()));
  const [query, setQuery] = createSignal("");
  const normalizedQuery = createMemo(() => query().trim().toLowerCase());
  const matches = createMemo(() => {
    const needle = normalizedQuery();
    const { tools, searchText } = registry();
    return needle ? fuzzy.filter(needle, tools, { key: searchText }).map((hit) => hit.item) : tools;
  });
  const featured = createMemo(() => registry().tools.filter((tool) => tool.featured));
  const toolsForGroup = (group: ToolTaskGroup) => matches().filter((tool) => tool.taskGroup === group);

  return (
    <div class="flex flex-col gap-5">
      <TextInput
        type="search"
        aria-label={t().searchLabel}
        icon="ti ti-search"
        value={query}
        onValueChange={setQuery}
        onClear={() => setQuery("")}
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
            <For each={featured()}>{(tool) => <QuickTool tool={tool} />}</For>
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
          fallback={<Placeholder icon="ti ti-search-off" title={t().emptyTitle} description={t().emptyDescription} />}
        >
          <div class="grid gap-x-5 gap-y-4 lg:grid-cols-2">
            <For each={taskGroupOrder}>
              {(group) => {
                const groupTools = () => toolsForGroup(group);
                return (
                  <Show when={groupTools().length > 0}>
                    <section class="min-w-0" aria-labelledby={`tool-group-${group}`}>
                      <header class="flex min-h-9 items-start gap-2 px-2 py-1.5">
                        <i class={`${registry().taskGroups[group].icon} app-accent-text mt-0.5 text-sm`} />
                        <span class="min-w-0 flex-1">
                          <h4 id={`tool-group-${group}`} class="text-sm font-medium text-primary">
                            {registry().taskGroups[group].label}
                          </h4>
                          <p class="truncate text-xs text-dimmed">{registry().taskGroups[group].description}</p>
                        </span>
                        <span class="text-xs tabular-nums text-dimmed">{groupTools().length}</span>
                      </header>
                      <div class="flex flex-col">
                        <For each={groupTools()}>{(tool) => <ToolRow tool={tool} />}</For>
                      </div>
                    </section>
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
