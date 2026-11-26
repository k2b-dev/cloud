import { cloudIdMessages, useCloudIdCopy } from "@k2b/cloud/browser/cloud-id";
import { registerContextAwareCommand } from "@k2b/cloud/browser/commands";
import { listenPopState } from "@k2b/ssr/nav";
import type { DateContext } from "@k2b/stdlib";
import { useLocale } from "@k2b/ui";
import { Avatar, Bar, Input, Menu, type MenuEntry, Pane, Tabs, useToast, Workspace } from "@k2b/ui/v2";
import { createEffect, createMemo, createSignal, onCleanup, onMount, Show } from "solid-js";
import type { SpaceAssignableUser } from "@/contracts";
import type { SpacePulse } from "@/overview-contracts";
import { spaceCommandMessages } from "../../../../commands";
import SpacesNav, { useSpacesNav } from "../../../_components/spaces-nav";
import { createSpaceCommands } from "../../../space-commands";
import { useSpaceMessages } from "../../messages";
import ItemDetailPane from "../detail/ItemDetailPane";
import { useItemDetailRoute } from "../detail/item-detail-route";
import { boardFilter, defaultFilter, parseFilterFromUrl } from "../filter/types";
import { createSpaceSearch } from "../search/SearchButton";
import { type CreateMenuChoice, createMenuEntries } from "../shared/create-menu";
import { createIcalCopy } from "../sidebar/CopyICalButton";
import { createItemController } from "../sidebar/create-item";
import { spacePrimaryHref } from "../sidebar/space-primary";
import type { SpacesSidebarData } from "../sidebar/spaces-navigation";
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
  /** The Space's first band: tasks done per day over 14 days, overdue and unassigned, read on the server. */
  pulse: SpacePulse;
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
  // On the calendar the head creates through the calendar, which knows the selected days and the day it shows.
  const [calendarChoose, setCalendarChoose] = createSignal<(choice: CreateMenuChoice) => void>();
  const createEntries = createMemo(() =>
    createMenuEntries({
      kind: view === "calendar" ? "calendar" : "task",
      templates: state.space.templates,
      shortcuts: true,
      t,
      locale: locale(),
      choose: (choice) => (calendarChoose() ?? create.choose)(choice),
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

  const ical = createIcalCopy({ icalToken: state.space.icalToken });
  const shortcuts = createKanbanShortcuts({ canWrite: state.canWrite });
  const cloudId = useCloudIdCopy();
  const spaceMenu = (): MenuEntry[] => [
    { label: t.spaceSettings, icon: "settings", href: `${spaceHref}/settings` },
    // One search place: where the head holds the search, the menu does not offer another; ⌘ ⇧ K stays a command.
    ...(view === "calendar"
      ? [{ label: t.searchInSpace({ space: state.space.name }), icon: "search", meta: "⌘ ⇧ K", onClick: () => void searchSpace() }]
      : []),
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
      sidebar={<SpacesNav nav={nav} label={state.space.name} />}
      // Design pass (25.11.): a detail is useful or absent; nothing stands in its place while no item is open.
      head={
        <Bar
          // The Space is named once: by its current entry in the sidebar, and by the shell's bar on the phone (review
          // 26.11., "say it once"); the head holds its views.
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
                {/* The first people and "+n" for the rest; the Space menu names all of them. */}
                {/* k2b-ui gap: initials take the first two words ("CA" for "Christopher Alexander Montgomery III") and split an emoji. */}
                <Avatar.Stack people={props.people.map((person) => ({ name: person.displayName }))} max={4} label={t.headPeople} />
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
        // An open item on the phone is the page with back and its own deeds; the floating main action stays with the list.
        state.canWrite && !detail.open()
          ? {
              label: primaryLabel,
              icon: "plus",
              // A command link (the view's address with `?command=`), so the phone's main action also works before the
              // page is live and opens in a new tab; a plain click opens the form in place.
              href: spacePrimaryHref({ space: state.space, query: committedQuery(), currentView: view }),
              onNavigate: () => {
                const viaCalendar = calendarChoose();
                if (viaCalendar) viaCalendar({ type: "blank", kind: "event" });
                else void create.createItem({ type: view === "calendar" ? "event" : "task" });
              },
            }
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
            pulse={props.pulse}
          />
        </Show>
        <Show when={view === "kanban"}>
          <BoardPane
            pulse={props.pulse}
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
          <SpacesCalendarRoute
            onCreateReady={(choose) => setCalendarChoose(() => choose)}
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
            now={state.snapshotAt}
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
