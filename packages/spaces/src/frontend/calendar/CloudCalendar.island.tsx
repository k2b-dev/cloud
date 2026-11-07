import { registerContextAwareCommand } from "@k2b/cloud/browser/commands";
import { openGlobalSearch } from "@k2b/cloud/browser/search";
import { WorkspaceNavigationProvider } from "@k2b/cloud/ssr/islands";
import { navigate } from "@k2b/ssr/nav";
import { type DateContext, dates } from "@k2b/stdlib";
import {
  AppWorkspace,
  BottomSheet,
  Button,
  bottomSheetOptions,
  Calendar,
  type CalendarCommand,
  type CalendarEvent,
  createNavigation,
  dialogCore,
  FilterChip,
  type FilterChipSection,
  IconButton,
  LocaleProvider,
  Placeholder,
  useLocale,
  ViewTabs,
} from "@k2b/ui";
import { createEffect, createMemo, createSignal, onCleanup, onMount, Show } from "solid-js";
import { CalendarItemContent } from "../[id]/_components/calendar/ItemContent";
import { CALENDAR_DAY_HOURS } from "../[id]/_components/calendar/range";
import SpacesSidebarList from "../[id]/_components/sidebar/SpacesSidebarList";
import {
  createNewSpace,
  createPinnedSpaces,
  createSpacesNavigationItems,
  type SpacesSidebarData,
} from "../[id]/_components/sidebar/spaces-navigation";
import { overviewMessages } from "../overview-messages";
import AgendaList from "./AgendaList";
import { fetchCalendarEvents, fetchCalendarSources } from "./calendar-client";
import {
  CALENDAR_LIST_DAYS,
  CALENDAR_REFRESH_MS,
  type CalendarRange,
  type CalendarSourceRead,
  type CalendarSourceView,
  type CloudCalendarRoute,
  type CloudCalendarView,
  calendarKey,
  calendarLookup,
  calendarStatus,
  cloudCalendarHref,
  defaultSelection,
  extendRange,
  itemInRange,
  itemKey,
  mergeItems,
  nextBlock,
  normalizeSelection,
  requestBatches,
  requestRanges,
  SEVERITY,
  type SourcedCalendarItem,
  shiftDateKey,
  splitCalendarKey,
  toCalendarEvent,
} from "./calendar-model";
import EventDetail from "./EventDetail";
import { useCalendarViewMessages } from "./messages";

export type CloudCalendarProps = {
  sidebar: SpacesSidebarData;
  route: CloudCalendarRoute;
  /** `null` when Cloud could not ask the apps which calendars they offer. */
  sources: CalendarSourceView[] | null;
  range: CalendarRange;
  items: SourcedCalendarItem[];
  reads: CalendarSourceRead[];
  /** Today in the person's date settings, as the server saw it. */
  today: string;
  canCreateSpace: boolean;
  dateConfig?: DateContext;
};

const PHONE_QUERY = "(max-width: 47.999rem)";

/** Every calendar a person can see in Cloud, in one view: all their Spaces and the calendars other apps offer. */
export default function CloudCalendar(props: CloudCalendarProps) {
  const t = useCalendarViewMessages();
  const locale = useLocale();
  const { t: overview } = overviewMessages.resolve([locale()]);
  const context = () => ({ weekStartsOn: 1 as const, ...props.dateConfig });
  const [sources, setSources] = createSignal(props.sources ?? []);
  const [catalogFailed, setCatalogFailed] = createSignal(props.sources === null);
  const [catalogRetrying, setCatalogRetrying] = createSignal(false);
  const [selection, setSelection] = createSignal<string[]>(props.route.selection ?? defaultSelection(props.sources ?? []));
  const [items, setItems] = createSignal(props.items);
  const [range, setRange] = createSignal(props.range);
  /** The state of each chosen calendar's last read, by calendar key; the server reports it per app. */
  const [reads, setReads] = createSignal(
    new Map(
      selection().flatMap((key) => {
        const read = props.reads.find((entry) => entry.appId === splitCalendarKey(key)?.appId);
        return read ? [[key, read] as const] : [];
      }),
    ),
  );
  /** Whether the person chose calendars; without a choice the page follows what the sources suggest. */
  const [explicit, setExplicit] = createSignal(props.route.selection !== null);
  const [date, setDate] = createSignal(props.route.date);
  const [visible, setVisible] = createSignal<{ first: string; last: string } | null>(null);
  const [detail, setDetail] = createSignal<{ key: string; anchor: DOMRect } | null>(null);
  const view = () => props.route.view;
  const lookup = createMemo(() => calendarLookup(sources()));
  const chosen = createMemo(() => new Set(selection()));
  const shownItems = createMemo(() => items().filter((item) => chosen().has(calendarKey(item.appId, item.calendarId))));
  const events = createMemo(() => shownItems().map((item) => toCalendarEvent(item, lookup(), t)));
  const itemsByKey = createMemo(() => new Map(shownItems().map((item) => [itemKey(item), item])));
  const status = createMemo(() => calendarStatus(selection(), sources(), reads()));
  const route = (patch: Partial<CloudCalendarRoute> = {}): CloudCalendarRoute => ({
    view: view(),
    date: date(),
    selection: normalizeSelection(selection(), sources()),
    ...patch,
  });
  const replaceUrl = () => navigate(cloudCalendarHref(route()), { replace: true, scroll: "manual", viewTransition: false });

  // ---------------------------------------------------------------- reading
  const controller = new AbortController();
  onCleanup(() => controller.abort());
  const setStates = (states: ReadonlyMap<string, CalendarSourceRead>) =>
    setReads((current) => {
      const next = new Map(current);
      for (const [key, read] of states) next.set(key, read);
      return next;
    });
  /**
   * One read at a time, so an older answer never overwrites a newer one; each read decides what it covers when it
   * starts, so a choice made while the view loaded more days still covers those days.
   */
  let queue: Promise<void> = Promise.resolve();
  const enqueue = (job: () => Promise<void>): Promise<void> => {
    const run = queue.then(job, job);
    queue = run.catch(() => undefined);
    return run;
  };
  const known = (keys: readonly string[]) => keys.filter((key) => lookup().has(key));
  const markPending = (keys: readonly string[]) =>
    setStates(new Map(keys.map((key) => [key, { appId: splitCalendarKey(key)?.appId ?? "", state: "pending" as const, error: null }])));
  /**
   * Reads calendars for the given days in requests the route accepts. A source that answers replaces what it showed
   * there; one that fails keeps what it showed, and its calendars are marked.
   */
  const runRead = async (ranges: readonly CalendarRange[], wanted: readonly string[]) => {
    // Only calendars a source still offers; a stale key in the URL asks nobody.
    const keys = known(wanted);
    if (keys.length === 0 || ranges.length === 0) return;
    const outcome = new Map<string, CalendarSourceRead>(
      keys.map((key) => [key, { appId: splitCalendarKey(key)?.appId ?? "", state: "ok", error: null }]),
    );
    const worse = (key: string, read: CalendarSourceRead) => {
      const current = outcome.get(key);
      if (!current || SEVERITY[read.state] > SEVERITY[current.state]) outcome.set(key, read);
    };
    for (const part of ranges.flatMap((range) => requestRanges(range, props.dateConfig)))
      for (const batch of requestBatches(keys)) {
        const appOf = (key: string) => splitCalendarKey(key)?.appId ?? "";
        try {
          const answer = await fetchCalendarEvents(part, batch, controller.signal);
          const byApp = new Map(answer.sources.map((source) => [source.appId, source]));
          for (const key of batch) worse(key, byApp.get(appOf(key)) ?? { appId: appOf(key), state: "failed", error: null });
          const covered = new Set(batch.filter((key) => ["ok", "truncated"].includes(byApp.get(appOf(key))?.state ?? "")));
          setItems((current) => mergeItems(current, answer.items, { range: part, calendars: covered }, props.dateConfig));
        } catch {
          if (controller.signal.aborted) return;
          for (const key of batch) worse(key, { appId: appOf(key), state: "failed", error: { code: "UNAVAILABLE", retryable: true } });
        }
      }
    // A source still pending after the browser's own budget has failed for now; the person can try again.
    for (const [key, value] of outcome)
      if (value.state === "pending") outcome.set(key, { ...value, state: "failed", error: { code: "TIMEOUT", retryable: true } });
    setStates(outcome);
  };
  /** Queues a read; `mark` shows the calendars as loading at once, for a choice or a retry the person waits for. */
  const read = (plan: () => { ranges: CalendarRange[]; keys: string[] }, options: { mark: boolean; keys?: string[] }) => {
    if (options.mark && options.keys) markPending(known(options.keys));
    return enqueue(async () => {
      const { ranges, keys } = plan();
      await runRead(ranges, keys);
    });
  };
  const readAll = (keys: () => string[], mark: boolean) =>
    read(() => ({ ranges: [range()], keys: keys() }), { mark, keys: mark ? keys() : undefined });
  /** Calendars whose last read failed or stopped, and chosen ones never read. */
  const unread = () => selection().filter((key) => !["ok", "pending"].includes(reads().get(key)?.state ?? "none"));
  /** New sources: without a choice of their own the person sees what the sources now suggest. */
  const adoptSources = (next: CalendarSourceView[]) => {
    setSources(next);
    if (!explicit()) setSelection(defaultSelection(next));
  };
  const retry = async () => {
    // A source that could not list its calendars is asked again for them first.
    if (sources().some((source) => source.state === "failed")) {
      try {
        adoptSources(await fetchCalendarSources(controller.signal));
      } catch {
        return;
      }
    }
    // Fixed now: marking them as loading takes them out of what is unread.
    const keys = unread();
    await readAll(() => keys, true);
  };
  const retryCatalog = async () => {
    setCatalogRetrying(true);
    try {
      adoptSources(await fetchCalendarSources(controller.signal));
      setCatalogFailed(false);
      await readAll(() => selection(), true);
    } catch {
      setCatalogFailed(true);
    } finally {
      setCatalogRetrying(false);
    }
  };
  const loadBlock = (edge: "earlier" | "later") =>
    enqueue(async () => {
      const block = nextBlock(range(), edge, view(), props.dateConfig);
      if (!block) return;
      await runRead([block], selection());
      setRange((current) => extendRange(current, block));
    });
  onMount(() => {
    // Sources the server had no time for load once in the browser; what is still open then counts as failed.
    const pending = selection().filter((key) => reads().get(key)?.state === "pending");
    if (pending.length > 0) void readAll(() => pending, true);
    let last = Date.now();
    const refresh = () => {
      if (document.visibilityState !== "visible" || Date.now() - last < CALENDAR_REFRESH_MS) return;
      last = Date.now();
      void readAll(() => selection(), false);
    };
    const timer = window.setInterval(refresh, 30_000);
    document.addEventListener("visibilitychange", refresh);
    onCleanup(() => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    });
  });

  // ---------------------------------------------------------------- choosing calendars
  let chipHost: HTMLSpanElement | undefined;
  const openChooser = () => chipHost?.querySelector<HTMLButtonElement>("button")?.click();
  const choose = (next: string[]) => {
    const added = next.filter((key) => !chosen().has(key));
    setExplicit(true);
    setSelection(next);
    replaceUrl();
    if (added.length > 0) void readAll(() => added, true);
  };
  /**
   * The state at the end of a chooser row. It follows the reads itself, so the open menu keeps its rows, and its icon
   * keeps one place whether it shows or not, so the menu never changes width.
   */
  const ChooserState = (stateProps: { calendarKey: string; busy: boolean }) => {
    const state = () => (chosen().has(stateProps.calendarKey) ? reads().get(stateProps.calendarKey)?.state : undefined);
    return (
      <>
        <Show when={stateProps.busy}>
          <span class="spaces-calendar-chooser__note">{t.busyNote}</span>
        </Show>
        <span class="spaces-calendar-chooser__state" data-tone={state() === "failed" ? "warning" : undefined}>
          <Show when={state() === "pending" || state() === "failed"}>
            <i
              class={state() === "failed" ? "ti ti-alert-triangle" : "ti ti-loader-2 animate-spin"}
              role="img"
              aria-label={state() === "failed" ? t.unreachable : t.loadingState}
            />
          </Show>
        </span>
      </>
    );
  };
  const chooserOptions = createMemo((): FilterChipSection[] =>
    sources().map((source) => ({
      label: source.name,
      multiple: true,
      toggleAll: true,
      options: source.calendars.map((calendar) => {
        const key = calendarKey(source.appId, calendar.id);
        return {
          value: key,
          label: calendar.name,
          color: calendar.color,
          trailing: <ChooserState calendarKey={key} busy={calendar.visibility === "busy"} />,
        };
      }),
    })),
  );
  const defaults = createMemo(() => defaultSelection(sources()));
  const changed = () => normalizeSelection(selection(), sources()) !== null;

  // ---------------------------------------------------------------- detail
  const isPhone = () => typeof matchMedia === "function" && matchMedia(PHONE_QUERY).matches;
  /** The entry a pointer pressed just now; a keyboard activation opens beside the focused entry instead. */
  let lastPointer: { element: HTMLElement | null; at: number } | null = null;
  const onPointerDown = (event: PointerEvent) => {
    if (event.target instanceof Element)
      lastPointer = { element: event.target.closest<HTMLElement>("a,button,[data-calendar-event]"), at: Date.now() };
  };
  const activationAnchor = (): HTMLElement | null => {
    const pressed = lastPointer && Date.now() - lastPointer.at < 1_000 ? lastPointer.element : null;
    lastPointer = null;
    return pressed ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
  };
  const openDetail = (item: SourcedCalendarItem, anchor: HTMLElement | null) => {
    const found = lookup().get(calendarKey(item.appId, item.calendarId));
    const content = (close: () => void) => (
      <EventDetail item={item} source={found?.source} calendar={found?.calendar} dateConfig={props.dateConfig} onClose={close} />
    );
    if (isPhone()) {
      setDetail({ key: itemKey(item), anchor: new DOMRect() });
      void dialogCore
        .open<void>(
          (close, dialog) => (
            <LocaleProvider locale={locale()}>
              <BottomSheet onDismiss={dialog.requestDismiss}>
                <BottomSheet.Body>{content(() => close())}</BottomSheet.Body>
              </BottomSheet>
            </LocaleProvider>
          ),
          { ...bottomSheetOptions, ariaLabel: t.eventDetails, history: true },
        )
        .finally(() => setDetail(null));
      return;
    }
    detailReturn = anchor;
    setDetail({ key: itemKey(item), anchor: (anchor ?? document.body).getBoundingClientRect() });
  };
  let detailReturn: HTMLElement | null = null;
  let popover: HTMLDivElement | undefined;
  const closeDetail = () => {
    setDetail(null);
    detailReturn?.focus({ preventScroll: true });
  };
  const detailItem = () => {
    const open = detail();
    return open ? itemsByKey().get(open.key) : undefined;
  };
  /** Beside the entry, on the side with room, inside the window. */
  const placePopover = (element: HTMLDivElement, anchor: DOMRect) => {
    const width = element.offsetWidth;
    const height = element.offsetHeight;
    let left = anchor.right + 10;
    if (left + width > window.innerWidth - 12) left = anchor.left - width - 10;
    left = Math.max(12, Math.min(left, window.innerWidth - width - 12));
    const top = Math.max(12, Math.min(anchor.top, window.innerHeight - height - 12));
    element.style.left = `${left}px`;
    element.style.top = `${top}px`;
  };
  const showPopover = (element: HTMLDivElement) => {
    popover = element;
    queueMicrotask(() => {
      const open = detail();
      if (!open || !element.isConnected) return;
      if (!element.matches(":popover-open")) element.showPopover();
      placePopover(element, open.anchor);
      element.querySelector<HTMLElement>("a[href], button:not(.spaces-calendar-detail__close)")?.focus({ preventScroll: true });
    });
  };
  onCleanup(() => {
    if (popover?.matches(":popover-open")) popover.hidePopover();
  });

  // ---------------------------------------------------------------- what is in view
  const todayKey = () => props.today;
  const shownDays = (): { first: string; last: string } => {
    const reported = visible();
    if (reported && view() !== "list") return reported;
    const key = date();
    if (view() === "list") return { first: key, last: shiftDateKey(key, CALENDAR_LIST_DAYS - 1) };
    if (view() === "day") return { first: key, last: key };
    if (view() === "month") {
      const first = dates.formatDateKey(dates.startOfMonth(dates.parseCalendarDate(key, context()), context()), context());
      const next = dates.formatDateKey(dates.addMonths(dates.parseCalendarDate(first, context()), 1, context()), context());
      return { first, last: shiftDateKey(next, -1) };
    }
    const start = dates.formatDateKey(dates.startOfWeek(dates.parseCalendarDate(key, context()), context()), context());
    return { first: start, last: shiftDateKey(start, 6) };
  };
  const shownCount = () => {
    const days = shownDays();
    const span = {
      from: dates.parseCalendarDate(days.first, props.dateConfig).toISOString(),
      to: dates.parseCalendarDate(shiftDateKey(days.last, 1), props.dateConfig).toISOString(),
    };
    return shownItems().filter((item) => itemInRange(item, span, props.dateConfig)).length;
  };
  const loading = () => status()?.kind === "loading";
  const empty = (): "sources" | "selection" | "events" | null => {
    // Without any calendar the page says why: none exist yet, or the status line names the apps that failed.
    if (!sources().some((source) => source.calendars.length > 0))
      return sources().some((source) => source.state === "failed") ? null : "sources";
    if (selection().length === 0) return "selection";
    // A source that failed may have events here; the status line says so instead of claiming there are none.
    if (loading() || status()?.kind === "failed" || status()?.kind === "truncated" || shownCount() > 0) return null;
    return "events";
  };
  const noEventsTitle = () => ({ day: t.noEventsDay, week: t.noEventsWeek, month: t.noEventsMonth, list: t.noEventsList })[view()];

  // ---------------------------------------------------------------- navigation
  const viewHref = (next: CloudCalendarView, day = date()) => cloudCalendarHref(route({ view: next, date: day }));
  const asView = (value: string): CloudCalendarView =>
    value === "day" || value === "week" || value === "month" || value === "list" ? value : "week";
  const dateHref = (target: Date, next: string) => viewHref(asView(next), dates.formatDateKey(target, props.dateConfig));
  const viewTabs = () =>
    (
      [
        ["day", t.day, "ti ti-calendar-event"],
        ["week", t.week, "ti ti-calendar-week"],
        ["month", t.month, "ti ti-calendar-month"],
        ["list", t.list, "ti ti-list"],
      ] as const
    ).map(([id, label, icon]) => ({ id, label, icon, href: viewHref(id) }));
  const [pinned] = createPinnedSpaces(props.sidebar.pinnedSpaceIds);
  const createSpace = createNewSpace(overview);
  const navigation = createNavigation({
    items: () =>
      createSpacesNavigationItems({
        ...props.sidebar,
        pinnedSpaceIds: pinned(),
        current: { kind: "calendar" },
        canCreate: props.canCreateSpace,
        myWorkLabel: overview.myWork,
        calendarLabel: overview.calendar,
        newSpaceLabel: overview.newSpace,
      }),
    onAction: async (action) => {
      if (action === "new-space") await createSpace();
    },
  });

  // The calendar's own shortcuts (Today, Next, Previous, the views, Go to) for the keys, the palette, and the help.
  const [commands, setCommands] = createSignal<readonly CalendarCommand[]>([]);
  createEffect(() => {
    for (const command of commands())
      onCleanup(
        registerContextAwareCommand({
          id: command.id,
          title: command.label,
          description: command.description ?? command.label,
          icon: command.icon,
          shortcut: command.shortcut,
          action: () => command.run(),
        }),
      );
  });

  // ---------------------------------------------------------------- rendering
  const renderEvent = (event: CalendarEvent, renderContext: Parameters<typeof CalendarItemContent>[0]["context"]) => {
    const item = itemsByKey().get(event.id);
    if (!item) return undefined;
    return (
      <CalendarItemContent
        event={event}
        context={renderContext}
        task={item.type === "deadline"}
        flag={null}
        extra={[]}
        busy={item.type === "busy"}
      />
    );
  };
  const statusLine = () => {
    const current = status();
    if (!current) return null;
    if (current.kind === "loading")
      return (
        <>
          <i class="ti ti-loader-2 animate-spin" aria-hidden="true" />
          <span>{t.loading({ count: current.count, total: current.total })}</span>
        </>
      );
    if (current.kind === "busy")
      return (
        <>
          <i class="ti ti-lock" aria-hidden="true" />
          <span>{t.busyOnly({ names: current.names.join(", ") })}</span>
        </>
      );
    return (
      <>
        <i class="ti ti-alert-triangle" aria-hidden="true" />
        <span>{current.kind === "failed" ? t.notResponding({ apps: current.apps.join(", "), count: current.count }) : t.truncated}</span>
        <button type="button" class="spaces-calendar-status__retry" onClick={() => void retry()}>
          {t.retry}
        </button>
        <Show when={current.kind === "failed"}>
          <span class="spaces-calendar-status__fade">{t.othersCurrent}</span>
        </Show>
      </>
    );
  };
  const tone = () => (status()?.kind === "failed" || status()?.kind === "truncated" ? "warning" : undefined);
  const chooser = () => (
    <span ref={chipHost} class="spaces-calendar-chooser">
      <FilterChip
        label={t.calendarsChip({ count: selection().length })}
        icon="ti ti-calendar"
        options={chooserOptions()}
        value={selection()}
        defaultValue={defaults()}
        isActive={changed()}
        only
        swatches
        onValueChange={choose}
      />
    </span>
  );
  const emptyState = () => (
    <Show when={empty()}>
      {(kind) => (
        <div class="spaces-calendar-empty">
          <Show when={kind() === "sources"}>
            <Placeholder icon="ti ti-calendar" title={t.noSources} description={t.noSourcesBody} />
          </Show>
          <Show when={kind() === "selection"}>
            <Placeholder
              icon="ti ti-calendar-off"
              title={t.noCalendarChosen}
              description={t.noCalendarChosenBody}
              action={
                <span class="spaces-calendar-empty__actions">
                  <Button variant="secondary" size="sm" onClick={openChooser}>
                    {t.chooseCalendars}
                  </Button>
                  <Show when={defaults().length > 0}>
                    <Button variant="ghost" size="sm" onClick={() => choose(defaults())}>
                      {t.restoreDefault}
                    </Button>
                  </Show>
                </span>
              }
            />
          </Show>
          <Show when={kind() === "events"}>
            <Placeholder
              icon="ti ti-calendar"
              title={noEventsTitle()}
              description={t.noEventsBody({ count: selection().length })}
              action={
                <span class="spaces-calendar-empty__actions">
                  <Show when={todayKey() < shownDays().first || todayKey() > shownDays().last}>
                    <a class="k2b-button" data-variant="secondary" data-size="sm" href={viewHref(view(), todayKey())}>
                      {t.goToday}
                    </a>
                  </Show>
                  <Button variant="ghost" size="sm" onClick={openChooser}>
                    {t.chooseCalendars}
                  </Button>
                </span>
              }
            />
          </Show>
        </div>
      )}
    </Show>
  );

  return (
    <AppWorkspace mobileSurface="flush" flat class="spaces-calendar-workspace">
      <WorkspaceNavigationProvider label={t.calendar} navigation={navigation} />
      <h1 class="sr-only">{t.calendar}</h1>
      <AppWorkspace.Sidebar label="Spaces" collapsible>
        <AppWorkspace.SidebarDesktop>
          <SpacesSidebarList
            spaces={props.sidebar.spaces}
            pinnedSpaceIds={props.sidebar.pinnedSpaceIds}
            myWorkCount={props.sidebar.myWorkCount}
            current={{ kind: "calendar" }}
            canCreate={props.canCreateSpace}
          />
        </AppWorkspace.SidebarDesktop>
      </AppWorkspace.Sidebar>
      <AppWorkspace.Head
        views={<ViewTabs label={t.view} current={view()} items={viewTabs()} />}
        actions={
          <IconButton
            label={overview.search}
            onClick={() => void openGlobalSearch({ scope: { appId: "spaces", label: "Spaces", icon: "ti ti-layout-kanban" } })}
          >
            <i class="ti ti-search" aria-hidden="true" />
          </IconButton>
        }
      />
      <AppWorkspace.Content>
        <AppWorkspace.Main class="spaces-calendar-main p-[var(--ui-space-shell)]" scroll={false} aria-busy={loading()}>
          <Show
            when={!catalogFailed()}
            fallback={
              <div class="spaces-calendar-empty" data-standalone="true">
                <Placeholder
                  state="error"
                  title={t.catalogFailed}
                  description={t.catalogFailedBody}
                  action={
                    <Button variant="secondary" size="sm" disabled={catalogRetrying()} onClick={() => void retryCatalog()}>
                      <i class={`ti ${catalogRetrying() ? "ti-loader-2 animate-spin" : "ti-refresh"}`} aria-hidden="true" />
                      {t.retry}
                    </Button>
                  }
                />
              </div>
            }
          >
            <div class="spaces-calendar-frame" onPointerDown={onPointerDown} data-print-region>
              <Calendar
                class="flex-1"
                view={view() === "list" ? "list" : view()}
                views={["day", "week", "month"]}
                customViews={[{ value: "list", label: t.list, days: CALENDAR_LIST_DAYS }]}
                viewSwitcher={false}
                date={date()}
                events={view() === "list" ? [] : events()}
                startHour={8}
                endHour={20}
                dayHours={CALENDAR_DAY_HOURS}
                range={view() === "list" ? undefined : range()}
                onLoadEarlier={() => loadBlock("earlier")}
                onLoadLater={() => loadBlock("later")}
                onVisibleDateChange={(first, last, focus) => {
                  setVisible({ first: dates.formatDateKey(first, props.dateConfig), last: dates.formatDateKey(last, props.dateConfig) });
                  const key = dates.formatDateKey(focus, props.dateConfig);
                  if (key === date()) return;
                  setDate(key);
                  replaceUrl();
                }}
                withWeekNumbers
                onCommandsChange={setCommands}
                dateConfig={props.dateConfig}
                getViewHref={(next) => viewHref(asView(next))}
                getDateHref={dateHref}
                renderEvent={renderEvent}
                selectedEventId={detail()?.key}
                onEventActivate={(event) => {
                  const item = itemsByKey().get(event.id);
                  if (item) openDetail(item, activationAnchor());
                }}
                toolbarContent={
                  <>
                    {chooser()}
                    <span class="spaces-calendar-status" data-tone={tone()} role="status">
                      {statusLine()}
                    </span>
                  </>
                }
              >
                <Show when={view() === "list"}>
                  <AgendaList
                    date={date()}
                    items={shownItems()}
                    lookup={lookup()}
                    today={todayKey()}
                    selectedKey={detail()?.key}
                    dateConfig={props.dateConfig}
                    onOpen={(item, anchor) => openDetail(item, anchor)}
                  />
                </Show>
              </Calendar>
              {emptyState()}
            </div>
          </Show>
          <Show when={detail() && !isPhone() ? detailItem() : undefined}>
            {(item) => {
              const found = () => lookup().get(calendarKey(item().appId, item().calendarId));
              return (
                <div
                  ref={showPopover}
                  popover="auto"
                  class="spaces-calendar-popover"
                  role="dialog"
                  aria-label={t.eventDetails}
                  onToggle={(event) => {
                    if ((event as ToggleEvent).newState === "closed") setDetail(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== "Escape") return;
                    event.preventDefault();
                    closeDetail();
                  }}
                >
                  <EventDetail
                    item={item()}
                    source={found()?.source}
                    calendar={found()?.calendar}
                    dateConfig={props.dateConfig}
                    onClose={closeDetail}
                  />
                </div>
              );
            }}
          </Show>
        </AppWorkspace.Main>
      </AppWorkspace.Content>
    </AppWorkspace>
  );
}
