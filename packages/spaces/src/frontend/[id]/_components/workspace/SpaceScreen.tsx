import { cloudIdMessages, useCloudIdCopy } from "@k2b/cloud/browser/cloud-id";
import { registerContextAwareCommand } from "@k2b/cloud/browser/commands";
import { listenPopState } from "@k2b/ssr/nav";
import type { DateContext } from "@k2b/stdlib";
import { useLocale } from "@k2b/ui";
import { Avatar, Bar, Canvas, Input, Menu, type MenuEntry, Pane, Tabs, useToast, Workspace } from "@k2b/ui/v2";
import { createEffect, createMemo, createSignal, onCleanup, onMount, Show } from "solid-js";
import type { SpaceAssignableUser } from "@/contracts";
import { spaceCommandMessages } from "../../../../commands";
import SpacesNav, { useSpacesNav } from "../../../_components/spaces-nav";
import { createSpaceCommands } from "../../../space-commands";
import { useSpaceMessages } from "../../messages";
import ItemDetailPane from "../detail/ItemDetailPane";
import { useItemDetailRoute } from "../detail/item-detail-route";
import { boardFilter, defaultFilter, parseFilterFromUrl } from "../filter/types";
import { createSpaceSearch } from "../search/SearchButton";
import { createMenuEntries } from "../shared/create-menu";
import { createIcalCopy } from "../sidebar/CopyICalButton";
import { createItemController } from "../sidebar/CreateItemButton";
import { createSpaceSettings } from "../sidebar/SpaceSettingsButton";
import type { SpacesSidebarData } from "../sidebar/SpacesSidebarList";
import BoardPane from "./BoardPane";
import ItemsPane from "./ItemsPane";
import { createKanbanShortcuts } from "./kanban-shortcuts";
import RememberSpace from "./RememberSpace";
import SpaceLiveEvents from "./SpaceLiveEvents";
import SpacesCalendarRoute from "./SpacesCalendarRoute";
import { SPACES_DETAIL_NAVIGATION_EVENT } from "./workspace-events";
import { buildSpacesItemLinkBaseUrl, buildSpacesPaginationBaseUrl, type SpacesWorkspaceState } from "./workspace-types";

type OkWorkspaceState = Extract<SpacesWorkspaceState, { kind: "ok" }>;
type View = OkWorkspaceState["currentView"];

export type SpaceScreenProps = {
  sidebar: SpacesSidebarData;
  people: SpaceAssignableUser[];
  state: OkWorkspaceState;
  dateConfig?: DateContext;
  mailIntegrationAvailable: boolean;
  /** Whether the edit form asks the assistant for a task estimate; decided on the server for this person. */
  estimateSuggestions?: boolean;
};

const VIEWS = [
  { id: "list", icon: "layout-list" },
  { id: "table", icon: "table" },
  { id: "kanban", icon: "layout-kanban" },
  { id: "calendar", icon: "calendar" },
] as const;

/** Where a view's links start: the Space with the view's own filters, without the open item. */
const routeOf = (state: OkWorkspaceState, dateConfig?: DateContext) => {
  const baseSpaceUrl = `/app/spaces/${state.space.id}`;
  const url = new URL(`${baseSpaceUrl}${state.query ? `?${state.query}` : ""}`, "http://spaces.local");
  const view = state.currentView;
  const filter =
    view === "list" || view === "table"
      ? parseFilterFromUrl(url)
      : view === "kanban"
        ? boardFilter(parseFilterFromUrl(url))
        : defaultFilter;
  const hasViewOverride = state.hasOverride && url.searchParams.has("view");
  return {
    initialHref: `${url.pathname}${url.search}`,
    filter,
    itemLinkBaseUrl: buildSpacesItemLinkBaseUrl({
      baseSpaceUrl,
      currentView: view,
      filter,
      hasViewOverride,
      calendarView: state.calendarView,
      calendarDate: state.calendarDate,
      calendarFilter: state.calendarFilter,
      dateConfig,
    }),
    paginationBaseUrl: buildSpacesPaginationBaseUrl({ baseSpaceUrl, filter, hasViewOverride, currentView: view }),
  };
};

/**
 * A Space on v2: the Spaces sidebar, the views as tabs with the search, the Space's menu and "New task" in the head,
 * the view below, and the open item beside it. The address holds the view, its filters and the open item.
 */
export default function SpaceScreen(props: SpaceScreenProps) {
  const t = useSpaceMessages();
  const locale = useLocale();
  const toast = useToast();
  const state = props.state;
  const view = state.currentView;
  const route = routeOf(state, props.dateConfig);
  const spaceHref = `/app/spaces/${state.space.id}`;
  const nav = useSpacesNav({ ...props.sidebar, current: { kind: "space", id: state.space.id }, canCreate: true });
  const detail = useItemDetailRoute(
    {
      spaceId: state.space.id,
      initialSource: route.initialHref,
      wormholes: state.wormholes,
      initialDetail: state.selectedItemDetail,
      canWrite: state.canWrite,
      accessVisible: state.accessVisible,
    },
    (message) => toast(message, { status: "bad" }),
  );

  createSpaceCommands({ current: () => (state.canWrite ? state.space : undefined), dateConfig: props.dateConfig });
  const create = createItemController({
    spaceId: state.space.id,
    columns: state.space.columns,
    tags: state.space.tags,
    templates: state.space.templates,
    dateConfig: props.dateConfig,
    defaultType: view === "calendar" ? "event" : "task",
  });
  const createEntries = createMemo(() =>
    createMenuEntries({
      kind: view === "calendar" ? "calendar" : "task",
      templates: state.space.templates,
      shortcuts: true,
      t,
      locale: locale(),
      choose: create.choose,
    }),
  );
  const primaryLabel = view === "calendar" ? t.newEvent : t.newTask;
  /** The search of the head runs through the view below, which owns its address and its loading. */
  const [search, setSearch] = createSignal<(text: string) => void>();
  createEffect(() => {
    if (!state.canWrite) return;
    const commands = spaceCommandMessages.resolve([locale()]).t;
    // n makes a blank task where the view shows tasks; the calendar registers its own n and Shift+N.
    if (view !== "calendar")
      onCleanup(
        registerContextAwareCommand({
          id: "spaces.task.blank",
          title: t.createMenuBlankTask,
          description: commands.createDescription({ name: state.space.name }),
          icon: "ti ti-plus",
          shortcut: "n",
          action: () => create.createItem({ type: "task" }),
        }),
      );
    // The compose commands open the same form as the head, also from the command palette and `?command=` links.
    for (const type of ["task", "event"] as const)
      onCleanup(
        registerContextAwareCommand({
          id: `spaces.${type}.compose`,
          title: type === "task" ? t.newTask : t.newEvent,
          description: commands.createDescription({ name: state.space.name }),
          icon: type === "task" ? "ti ti-checkbox" : "ti ti-calendar-event",
          ...(type === (view === "calendar" ? "event" : "task") ? { shortcut: "mod+alt+n" } : {}),
          action: { command: `spaces.${type}.compose`, input: { spaceId: state.space.id } },
        }),
      );
  });

  const searchSpace = createSpaceSearch({ spaceId: state.space.id, spaceName: state.space.name });
  createEffect(() =>
    onCleanup(
      registerContextAwareCommand({
        id: "spaces.search",
        title: t.searchItemsCommand,
        description: spaceCommandMessages.resolve([locale()]).t.searchDescription({ name: state.space.name }),
        icon: "ti ti-search",
        shortcut: "mod+shift+k",
        action: () => void searchSpace(),
      }),
    ),
  );

  const settings = createSpaceSettings({ spaceId: state.space.id, baseUrl: route.itemLinkBaseUrl, dateConfig: props.dateConfig });
  const ical = createIcalCopy({ icalToken: state.space.icalToken });
  const shortcuts = createKanbanShortcuts({ canWrite: state.canWrite });
  const cloudId = useCloudIdCopy();
  const spaceMenu = (): MenuEntry[] => [
    { label: t.spaceSettings, icon: "settings", onClick: () => void settings.openDialog() },
    { label: t.searchInSpace({ space: state.space.name }), icon: "search", meta: "⌘ ⇧ K", onClick: () => void searchSpace() },
    ...(state.space.icalToken
      ? [
          {
            label: ical.copied() ? t.copiedIcalUrl : t.copyIcalUrl,
            icon: ical.copied() ? "check" : "calendar-share",
            onClick: () => ical.handleCopy().catch(() => toast(t.headCopyFailed, { status: "bad" })),
          },
        ]
      : []),
    ...(view === "kanban" ? [{ label: t.keyboardShortcuts, icon: "keyboard", onClick: () => void shortcuts() }] : []),
    ...(cloudId.available()
      ? [
          {
            label: cloudIdMessages.resolve([locale()]).t.copy,
            icon: "id",
            onClick: () => cloudId.copy({ type: "spaces.space", id: state.space.id }),
          },
        ]
      : []),
    ...(props.people.length
      ? [
          {
            title: t.headPeople,
            items: props.people.map((person) => ({
              label: person.displayName,
              icon: person.kind === "service_account" ? "robot" : "user",
              disabled: true,
            })),
          },
        ]
      : []),
  ];

  /** The address the view committed last: the tabs keep its filters when they switch the view. */
  const [committedQuery, setCommittedQuery] = createSignal(state.query);
  onMount(() => {
    if (window.location.pathname === spaceHref) setCommittedQuery(window.location.search.slice(1));
    const follow = (href: string) => {
      const url = new URL(href, window.location.origin);
      if (url.pathname === spaceHref) setCommittedQuery(url.search.slice(1));
    };
    const onCommitted = (event: Event) => {
      if (event instanceof CustomEvent && event.detail?.history === "none") follow(event.detail.href);
    };
    window.addEventListener(SPACES_DETAIL_NAVIGATION_EVENT, onCommitted);
    onCleanup(() => window.removeEventListener(SPACES_DETAIL_NAVIGATION_EVENT, onCommitted));
    onCleanup(listenPopState(({ url }) => follow(url.href)));
  });
  const viewHref = (id: View) => {
    const params = new URLSearchParams(committedQuery());
    params.set("view", id);
    params.delete("item");
    params.delete("occurrence");
    return `${spaceHref}?${params}`;
  };
  const viewLabel = (id: View) => ({ list: t.list, table: t.table, kanban: t.kanban, calendar: t.calendar })[id];

  return (
    <Workspace
      sidebar={<SpacesNav nav={nav} />}
      detail
      detailEmpty={{ icon: "click", text: t.selectItemForDetails }}
      head={
        <Bar
          start={
            <Tabs
              label={t.headViews}
              items={VIEWS.map((entry) => ({
                label: viewLabel(entry.id),
                icon: entry.icon,
                href: viewHref(entry.id),
                current: entry.id === view,
              }))}
            />
          }
          end={
            <>
              <Show when={view !== "calendar"}>
                <Input
                  type="search"
                  icon="search"
                  label={t.searchItems}
                  placeholder={t.searchItems}
                  value={route.filter.search}
                  onKeyDown={(event) => {
                    if (event.isComposing) return;
                    const input = event.currentTarget as HTMLInputElement;
                    if (event.key === "Enter") search()?.(input.value.trim());
                    if (event.key === "Escape" && input.value) {
                      input.value = "";
                      search()?.("");
                    }
                  }}
                />
              </Show>
              <Show when={props.people.length > 0}>
                {/* k2b-ui gap: no avatar stack; the first four people stand side by side, all of them in the menu. */}
                {props.people.slice(0, 4).map((person) => (
                  <Avatar name={person.displayName} />
                ))}
              </Show>
              <Menu label={t.headSpaceMenu} items={spaceMenu()} />
              <Show when={state.canWrite}>
                <Menu variant="primary" icon="plus" disabled={create.pending()} items={createEntries()}>
                  {primaryLabel}
                </Menu>
              </Show>
            </>
          }
        />
      }
      primary={
        state.canWrite
          ? { label: primaryLabel, icon: "plus", onClick: () => void create.createItem({ type: view === "calendar" ? "event" : "task" }) }
          : undefined
      }
    >
      <RememberSpace spaceId={state.space.id} />
      <SpaceLiveEvents
        spaceId={state.space.id}
        initialCursor={state.eventCursor}
        snapshotDay={state.snapshotDay}
        dateConfig={props.dateConfig}
      />
      <Pane.Split>
        <Show when={view === "list" || view === "table"}>
          <ItemsPane
            space={state.space}
            onSearchReady={(run) => setSearch(() => run)}
            currentView={view === "table" ? "table" : "list"}
            filter={route.filter}
            initialItemsResult={state.itemsResult}
            itemLinkBaseUrl={route.itemLinkBaseUrl}
            selectedItemId={state.selectedItemDetail?.item.id ?? ""}
            dateConfig={props.dateConfig}
            canWrite={state.canWrite}
            currentUserId={state.currentUserId}
            onCreate={() => void create.createItem({ type: "task" })}
          />
        </Show>
        <Show when={view === "kanban"}>
          <BoardPane
            space={state.space}
            onSearchReady={(run) => setSearch(() => run)}
            filter={route.filter}
            baseUrl={route.itemLinkBaseUrl}
            wormholes={state.wormholes}
            initialBuckets={state.kanbanBuckets}
            foldedColumns={state.settings.foldedColumns ?? []}
            selectedItemId={state.selectedItemDetail?.item.id ?? ""}
            dateConfig={props.dateConfig}
            canWrite={state.canWrite}
            currentUserId={state.currentUserId}
          />
        </Show>
        <Show when={view === "calendar"}>
          <Pane label={t.calendar}>
            <Canvas label={t.calendar}>
              <SpacesCalendarRoute
                spaceId={state.space.id}
                baseUrl={route.itemLinkBaseUrl}
                columns={state.space.columns}
                tags={state.space.tags}
                templates={state.space.templates}
                initialState={{
                  view: state.calendarView,
                  date: state.calendarDate,
                  filter: state.calendarFilter,
                  range: state.calendarRange,
                  items: state.calendarItems,
                  weather: state.calendarWeather,
                  tray: state.calendarTray,
                }}
                selectedItemId={selectedCalendarEventId(state)}
                dateConfig={props.dateConfig}
                canWrite={state.canWrite}
                currentUserId={state.currentUserId}
              />
            </Canvas>
          </Pane>
        </Show>
        {detail.open() ? (
          <ItemDetailPane
            route={detail}
            space={state.space}
            spaceName={state.space.name}
            steppable={view !== "calendar"}
            currentUserId={state.currentUserId}
            dateConfig={props.dateConfig}
            canWrite={state.canWrite}
            mailIntegrationAvailable={props.mailIntegrationAvailable}
            estimateSuggestions={props.estimateSuggestions}
          />
        ) : undefined}
      </Pane.Split>
    </Workspace>
  );
}

/** The calendar names a generated occurrence by its series and start. */
const selectedCalendarEventId = (state: OkWorkspaceState) => {
  const detail = state.selectedItemDetail;
  if (!detail) return "";
  const recurring = detail.recurringContext;
  return recurring ? (recurring.isOverride ? detail.item.id : `${recurring.seriesItemId}:${recurring.recurrenceId}`) : detail.item.id;
};
