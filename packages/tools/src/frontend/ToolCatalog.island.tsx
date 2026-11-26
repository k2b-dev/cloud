import { listenPopState } from "@k2b/ssr/nav";
import { i18n } from "@k2b/stdlib";
import { useLocale } from "@k2b/ui";
import { Empty, Input, List, Pane, Row, Section, StatusRow, Tiles } from "@k2b/ui/v2";
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { findTools } from "./catalog-search";
import ToolsScreen, { categoryColor, toolIcon } from "./ToolsScreen";
import { categoryOrder, resolveRegistry } from "./tools/registry";
import { toolsQuery } from "./tools-query";

export const toolCatalogMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      searchLabel: "Search tools",
      searchPlaceholder: "Search by task or tool",
      quickTools: "Used often",
      matchingTools: ({ count }: { count: number }) =>
        i18n.plural(count, "en", { one: `${count} matching tool`, other: `${count} matching tools` }),
      emptyTitle: "No tool matches this task. Try a tool name, format, or action.",
      clearSearch: "Clear search",
    },
    de: {
      searchLabel: "Werkzeuge suchen",
      searchPlaceholder: "Aufgabe oder Werkzeug suchen",
      quickTools: "Oft gebraucht",
      matchingTools: ({ count }) => i18n.plural(count, "de", { one: `${count} passendes Werkzeug`, other: `${count} passende Werkzeuge` }),
      emptyTitle: "Kein Werkzeug passt zu dieser Aufgabe. Suche nach einem Werkzeug, Format oder Arbeitsschritt.",
      clearSearch: "Suche zurücksetzen",
    },
  },
});

/**
 * The catalog on v2: the search in the head finds a tool by task (its words stay in the address as `q`), the tools
 * used often stand first, then every tool by category. The server reads the same address, so the first picture shows
 * the search's result.
 */
export default function ToolCatalog(props: { search?: string }) {
  const locale = useLocale();
  const t = () => toolCatalogMessages.resolve([locale()]).t;
  const registry = createMemo(() => resolveRegistry(locale()));
  const query = createMemo(() => toolsQuery(t().searchLabel));
  const [search, setSearch] = createSignal(props.search ?? "");
  let field: HTMLInputElement | HTMLTextAreaElement | undefined;
  const needle = () => search().trim().toLowerCase();
  const matches = createMemo(() => findTools(needle(), registry().tools, registry().searchText));
  const update = (value: string) => {
    setSearch(value);
    const state = query().set(query().parse(location.search).state, "q", value);
    if (!state) return;
    const url = new URL(location.href);
    url.search = query().serialize(state, url.search).toString();
    history.replaceState(history.state, "", url);
  };
  // Back and Forward within the catalog bring its search back; other pages belong to the navigation.
  onMount(() => onCleanup(listenPopState(({ url }) => setSearch(query().parse(url.searchParams).state.search ?? ""))));
  return (
    <ToolsScreen
      end={
        <Input
          type="search"
          icon="search"
          label={t().searchLabel}
          placeholder={t().searchPlaceholder}
          value={search()}
          ref={(element) => {
            field = element;
          }}
          onInput={update}
          onKeyDown={(event) => {
            if (event.key === "Escape" && !event.isComposing) update("");
          }}
        />
      }
    >
      <Pane
        label={t().searchLabel}
        scrollKey="tools-catalog"
        // a count is no statement worth the lead: the row speaks only while a search narrows the catalog
        // without a match the empty state says it once, so the row stays away
        status={needle() && matches().length > 0 ? <StatusRow lead={t().matchingTools({ count: matches().length })} /> : undefined}
      >
        <Show when={!needle()}>
          <Section icon="star" title={t().quickTools}>
            <Tiles
              label={t().quickTools}
              items={registry()
                .tools.filter((tool) => tool.featured)
                .map((tool) => ({
                  icon: toolIcon(tool.icon),
                  title: tool.name,
                  meta: registry().categories[tool.category].label,
                  href: `/tools/${tool.id}`,
                }))}
            />
          </Section>
        </Show>
        <Show
          when={matches().length > 0}
          fallback={
            <Empty
              icon="search-off"
              text={t().emptyTitle}
              action={{
                label: t().clearSearch,
                onClick: () => {
                  update("");
                  field?.focus();
                },
              }}
            />
          }
        >
          <For each={categoryOrder}>
            {(category) => {
              const inCategory = () => matches().filter((tool) => tool.category === category);
              return (
                <Show when={inCategory().length > 0}>
                  <Section
                    icon={toolIcon(registry().categories[category].icon)}
                    color={categoryColor[category]}
                    title={registry().categories[category].label}
                    count={inCategory().length}
                  >
                    <List label={registry().categories[category].label}>
                      <For each={inCategory()}>
                        {(tool) => (
                          // its sign in the category colour, its name, and what it does under it.
                          // k2b-ui gap: a row of one line on the desktop (the note after the name) and two on the phone;
                          // a one-line row with a note stays one tall, cut line on the phone, so the rows keep two lines.
                          <Row
                            icon={toolIcon(tool.icon)}
                            color={categoryColor[category]}
                            lines={[tool.name, tool.description]}
                            href={`/tools/${tool.id}`}
                          />
                        )}
                      </For>
                    </List>
                  </Section>
                </Show>
              );
            }}
          </For>
        </Show>
      </Pane>
    </ToolsScreen>
  );
}
