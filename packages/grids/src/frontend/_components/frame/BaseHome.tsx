import { useLocale } from "@k2b/ui";
import { Bar, Empty, FilterBar, Input, List, Menu, Notice, Pane, Row, Section, StatusRow, Tabs, Text } from "@k2b/ui/v2";
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { navigationReferenceKey } from "../../../navigation-contracts";
import { workspaceMessages } from "../workspace/messages";
import { type NavigationResource, navigationResources, navigationState } from "../workspace/navigation-catalog";
import type { PublicOkWorkspaceState } from "../workspace/workspace-public-state-model";
import GridsFrame, { LiveNotice, useGridsFrame } from "./GridsFrame";
import { v2Icon } from "./grids-nav";
import { frameMessages } from "./messages";
import { filterResources, RESOURCE_TYPES, type ResourcesState, resourcesQuery } from "./resources-query";

type NavigationResourceType = NavigationResource["type"];

export type BaseHomeProps = {
  state: PublicOkWorkspaceState;
  /** What the address narrows the entries to, parsed on the server with `resourcesQuery`. */
  query: ResourcesState;
  tab: "groups" | "resources";
};

/**
 * A base's home on v2: everything the person can open in it, by the curated groups or by kind, narrowed by kind and
 * a search in the address. On a base without a table to open (`empty` route) it says what is there instead.
 */
export default function BaseHome(props: BaseHomeProps) {
  // The one state of the address: started with what the server parsed, set by the bar, the search and history steps.
  const [state, setState] = createSignal(props.query);
  const own = {
    ...props,
    get query() {
      return state();
    },
    setQuery: setState,
  };
  return (
    <GridsFrame
      state={navigationState(props.state)}
      activeKeys={[`base:${props.state.base.id}`]}
      revision={props.state.workspaceRevision}
      head={<HomeHead {...own} />}
    >
      <HomeList {...own} />
    </GridsFrame>
  );
}

const kindLabels = (t: ReturnType<typeof frameMessages.resolve>["t"]): Record<NavigationResourceType, string> => ({
  table: t.resourceTable,
  view: t.resourceView,
  form: t.resourceForm,
  documentTemplate: t.resourceDocumentTemplate,
  workflow: t.resourceWorkflow,
  customApp: t.resourceCustomApp,
});

type HomeProps = BaseHomeProps & { setQuery: (next: ResourcesState) => void };

function HomeHead(props: HomeProps) {
  const locale = useLocale();
  const t = () => frameMessages.resolve([locale()]).t;
  const frame = useGridsFrame();
  const query = createMemo(() => resourcesQuery(locale()));
  const state = () => props.query;
  const groups = () => (props.state.navigation?.groups.length ?? 0) > 0;
  const base = `/app/grids/${props.state.base.id}`;
  const tabHref = (tab: "groups" | "resources") => {
    const params = query().serialize(state());
    params.set("tab", tab);
    if (props.state.adminModeRequested) params.set("edit", "true");
    return `${base}?${params}`;
  };
  const search = (text: string) => {
    const next = query().set(state(), "q", text.trim());
    if (!next) return;
    const params = query().serialize(next, location.search);
    history.pushState(history.state, "", `${location.pathname}${params.size ? `?${params}` : ""}`);
    props.setQuery(next);
  };
  return (
    <Bar
      start={
        groups() ? (
          <Tabs
            label={t().views}
            items={[
              { label: t().groups, href: tabHref("groups"), current: props.tab === "groups" },
              { label: t().allResources, href: tabHref("resources"), current: props.tab === "resources" },
            ]}
          />
        ) : (
          <Text type="body">{props.state.base.name}</Text>
        )
      }
      end={
        <>
          <Input
            type="search"
            icon="search"
            label={t().searchResources}
            placeholder={t().searchResources}
            value={state().search ?? ""}
            onKeyDown={(event) => {
              if (event.isComposing) return;
              const input = event.currentTarget as HTMLInputElement;
              if (event.key === "Enter") search(input.value);
              if (event.key === "Escape" && input.value) {
                input.value = "";
                search("");
              }
            }}
          />
          <Show when={frame.nav.create().length > 0}>
            <Menu icon="plus" items={frame.nav.create()}>
              {t().newResource}
            </Menu>
          </Show>
        </>
      }
    />
  );
}

function HomeList(props: HomeProps) {
  const locale = useLocale();
  const t = () => frameMessages.resolve([locale()]).t;
  const words = () => workspaceMessages.resolve([locale()]).t;
  const frame = useGridsFrame();
  const query = createMemo(() => resourcesQuery(locale()));
  const state = () => props.query;
  onMount(() => {
    const step = () => props.setQuery(query().parse(location.search).state);
    addEventListener("popstate", step);
    onCleanup(() => removeEventListener("popstate", step));
  });
  const number = (value: number) => new Intl.NumberFormat(locale()).format(value);
  const catalog = props.state.catalog;
  const all = navigationResources(props.state.base.id, catalog, props.state.adminModeRequested);
  const kinds = () => kindLabels(t());
  const shown = createMemo(() => filterResources(all, state(), locale(), (type) => kinds()[type]));
  const changed = () => query().serialize(state()).toString() !== "";
  const resetHref = () => {
    const params = new URLSearchParams();
    if (props.tab === "resources" && (props.state.navigation?.groups.length ?? 0) > 0) params.set("tab", "resources");
    if (props.state.adminModeRequested) params.set("edit", "true");
    return `/app/grids/${props.state.base.id}${params.size ? `?${params}` : ""}`;
  };
  const sectionLabel = (type: NavigationResourceType) =>
    ({
      table: t().typeTable,
      view: t().typeView,
      form: t().typeForm,
      documentTemplate: t().typeDocumentTemplate,
      workflow: t().typeWorkflow,
      customApp: t().typeCustomApp,
    })[type];
  const sectionIcon: Record<NavigationResourceType, string> = {
    table: "table",
    view: "table-spark",
    form: "forms",
    documentTemplate: "file-type-pdf",
    workflow: "route",
    customApp: "app-window",
  };

  const row = (resource: NavigationResource) => {
    const status = resource.status === "disabled" ? t().off : resource.status === "draft" ? t().draft : undefined;
    const second = [kinds()[resource.type], resource.context, status].filter(Boolean).join(" · ");
    const edit = resource.type === "form" ? frame.nav.editForm(resource.id) : undefined;
    // k2b-ui gap: a Row's second line does not cut an unbreakable word (a long table name) and runs past the pane
    // edge; a long Section title is cut without "…" on the phone. No app-side fix without CSS; reported to lane MW/Y.
    return (
      <Row
        icon={v2Icon(resource.icon, sectionIcon[resource.type])}
        lines={[resource.name, second]}
        href={resource.href}
        onOpen={resource.href ? undefined : () => frame.nav.fillOut(resource.id)}
        end={edit ? <Menu label={t().editForm} items={[{ label: t().editForm, icon: "pencil", onClick: edit }]} /> : undefined}
      />
    );
  };

  const empty = () =>
    changed() ? (
      <Empty icon="filter-off" text={t().noMatches} action={{ label: t().resetFilters, icon: "filter-off", href: resetHref() }} />
    ) : (
      <Empty icon="layout-dashboard" text={t().noResources} />
    );

  /** On the `empty` route, the server found no table to open: say what the person can open instead. */
  const emptyRouteNote = () => {
    if (props.state.route.kind !== "empty") return null;
    const forms = catalog.sidebarForms.length;
    const documents = catalog.sidebarDocumentTemplates.length;
    if (forms || documents) return documents ? words().limitedAccess({ forms, documents }) : words().formOnlyAccess({ count: forms });
    if (props.state.canCreateTables) return props.state.adminModeRequested ? words().noTablesCreate : words().noTablesEditMode;
    return words().noTablesWriteAccess;
  };

  const byKind = () =>
    RESOURCE_TYPES.map((type) => ({ type, entries: shown().filter((resource) => resource.type === type) })).filter(
      (group) => group.entries.length > 0,
    );
  const byGroup = () => {
    const keep = new Set(shown().map(navigationReferenceKey));
    const known = new Map(all.map((resource) => [navigationReferenceKey(resource), resource]));
    return (props.state.navigation?.groups ?? [])
      .map((group) => ({
        id: group.id,
        name: group.name,
        entries: group.entries.flatMap((entry) => {
          const key = navigationReferenceKey(entry);
          const resource = known.get(key);
          return resource && keep.has(key) ? [resource] : [];
        }),
      }))
      .filter((group) => group.entries.length > 0);
  };

  const lead = () =>
    shown().length < all.length
      ? t().resourcesOf({ count: number(shown().length), total: number(all.length) })
      : t().resourcesCount({ count: number(all.length) });

  return (
    <Pane
      label={props.state.base.name}
      scrollKey={`grids-home-${props.state.base.id}`}
      status={
        <>
          <FilterBar
            query={query()}
            state={state()}
            onChange={props.setQuery}
            icons={{ type: "category" }}
            results={t().resourcesCount({ count: number(shown().length) })}
          />
          <StatusRow lead={lead()} />
        </>
      }
    >
      <LiveNotice />
      <Show when={!frame.revoked()}>
        <Show when={emptyRouteNote()}>{(note) => <Notice tone="note">{note()}</Notice>}</Show>
        <Show when={props.state.base.description}>
          {(description) => (
            <Text type="body" muted>
              {description()}
            </Text>
          )}
        </Show>
        <Show
          when={props.tab === "groups"}
          fallback={
            <Show when={byKind().length > 0} fallback={empty()}>
              <For each={byKind()}>
                {(group) => (
                  <Section icon={sectionIcon[group.type]} title={sectionLabel(group.type)} count={number(group.entries.length)}>
                    <List label={sectionLabel(group.type)}>
                      <For each={group.entries}>{row}</For>
                    </List>
                  </Section>
                )}
              </For>
            </Show>
          }
        >
          <Show when={byGroup().length > 0} fallback={empty()}>
            <For each={byGroup()}>
              {(group) => (
                <Section icon="folder" title={group.name} count={number(group.entries.length)}>
                  <List label={group.name}>
                    <For each={group.entries}>{row}</For>
                  </List>
                </Section>
              )}
            </For>
          </Show>
        </Show>
      </Show>
    </Pane>
  );
}
