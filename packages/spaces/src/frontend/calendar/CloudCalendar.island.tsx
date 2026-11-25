import { registerContextAwareCommand } from "@k2b/cloud/browser/commands";
import { openGlobalSearch } from "@k2b/cloud/browser/search";
import { navigate } from "@k2b/ssr/nav";
import { type DateContext, dates } from "@k2b/stdlib";
import { Calendar, type CalendarCommand, type CalendarEvent, useLocale } from "@k2b/ui";
import { Bar, Button, Canvas, Empty, Failed, Menu, type MenuEntry, Notice, Pane, StatusRow, Tabs, Workspace } from "@k2b/ui/v2";
import { createEffect, createMemo, createSignal, onCleanup, onMount, Show } from "solid-js";
import SpacesNav, { useSpacesNav } from "../_components/spaces-nav";
import { CalendarItemContent } from "../[id]/_components/calendar/ItemContent";
import { CALENDAR_DAY_HOURS } from "../[id]/_components/calendar/range";
import type { SpacesSidebarData } from "../[id]/_components/sidebar/spaces-navigation";
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

/** Every calendar a person can see in Cloud, in one view: all their Spaces and the calendars other apps offer. */
export default function CloudCalendar(props: CloudCalendarProps) {
  const t = useCalendarViewMessages();
  const locale = useLocale();
  const { t: overview } = overviewMessages.resolve([locale()]);
  const context = () => ({ weekStartsOn: 1 as const, ...props.dateConfig });
  const [sources, setSources] = createSignal(props.sources ?? []);
  const [catalogFailed, setCatalogFailed] = createSignal(props.sources === null);
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
    try {
      adoptSources(await fetchCalendarSources(controller.signal));
      setCatalogFailed(false);
      await readAll(() => selection(), true);
    } catch {
      setCatalogFailed(true);
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
  const choose = (next: string[]) => {
    const added = next.filter((key) => !chosen().has(key));
    setExplicit(true);
    setSelection(next);
    replaceUrl();
    if (added.length > 0) void readAll(() => added, true);
  };
  const defaults = createMemo(() => defaultSelection(sources()));
  const changed = () => normalizeSelection(selection(), sources()) !== null;
  /** What a chosen calendar's row says beside its name: busy times only, loading, or not answering. */
  const chooserNote = (key: string, busy: boolean) => {
    const state = chosen().has(key) ? reads().get(key)?.state : undefined;
    return [busy ? t.busyNote : undefined, state === "failed" ? t.unreachable : state === "pending" ? t.loadingState : undefined]
      .filter(Boolean)
      .join(" · ");
  };
  /**
   * The calendars by app as ticked entries, each app with "All" first; "Restore default" returns to the calendars Cloud
   * starts with. k2b-ui gap: a menu entry has no colour swatch and no "only this one".
   */
  const chooserMenu = createMemo((): MenuEntry[] => [
    ...sources()
      .filter((source) => source.calendars.length > 0)
      .map((source) => {
        const keys = source.calendars.map((calendar) => calendarKey(source.appId, calendar.id));
        const all = keys.every((key) => chosen().has(key));
        return {
          title: source.name,
          items: [
            {
              label: t.allOf({ name: source.name }),
              checked: all,
              onClick: () => choose(all ? selection().filter((key) => !keys.includes(key)) : [...new Set([...selection(), ...keys])]),
            },
            ...source.calendars.map((calendar) => {
              const key = calendarKey(source.appId, calendar.id);
              return {
                label: calendar.name,
                checked: chosen().has(key),
                meta: chooserNote(key, calendar.visibility === "busy") || undefined,
                onClick: () => choose(chosen().has(key) ? selection().filter((entry) => entry !== key) : [...selection(), key]),
              };
            }),
          ],
        };
      }),
    ...(changed() && defaults().length > 0 ? [{ label: t.restoreDefault, icon: "restore", onClick: () => choose(defaults()) }] : []),
  ]);

  // ---------------------------------------------------------------- detail
  /** The open entry, in a dialog (a sheet on the phone); closing it hands the focus back to the entry. */
  const [detail, setDetail] = createSignal<string | null>(null);
  const openDetail = (item: SourcedCalendarItem) => setDetail(itemKey(item));
  const detailItem = () => {
    const open = detail();
    return open ? itemsByKey().get(open) : undefined;
  };

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
  const nav = useSpacesNav({ ...props.sidebar, current: { kind: "calendar" }, canCreate: props.canCreateSpace });

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
  /** What the status row says beside the count: what still loads, which calendars show busy times only. */
  const statusFacts = () => {
    const current = status();
    if (current?.kind === "loading") return [{ after: t.loading({ count: current.count, total: current.total }) }];
    if (current?.kind === "busy") return [{ after: t.busyOnly({ names: current.names.join(", ") }) }];
    return [];
  };
  /** Apps that did not answer, or a range cut short: the sentence of the warning above the calendar. */
  const problem = (current: NonNullable<ReturnType<typeof status>>) =>
    current.kind === "failed"
      ? `${t.notResponding({ apps: current.apps.join(", "), count: current.count })} ${t.othersCurrent}`
      : t.truncated;
  const viewIcon = { day: "calendar-event", week: "calendar-week", month: "calendar-month", list: "list" } as const;

  return (
    <Workspace
      sidebar={<SpacesNav nav={nav} />}
      head={
        <Bar
          start={
            <Tabs
              label={t.view}
              items={(["day", "week", "month", "list"] as const).map((id) => ({
                label: { day: t.day, week: t.week, month: t.month, list: t.list }[id],
                icon: viewIcon[id],
                href: viewHref(id),
                current: view() === id,
              }))}
            />
          }
          end={
            <>
              <Button
                variant="ghost"
                icon="search"
                label={overview.search}
                keep
                onClick={() => void openGlobalSearch({ scope: { appId: "spaces", label: "Spaces", icon: "ti ti-layout-kanban" } })}
              />
              <Show when={!catalogFailed() && sources().some((source) => source.calendars.length > 0)}>
                <Menu icon="calendar" items={chooserMenu()}>
                  {t.calendarsChip({ count: selection().length })}
                </Menu>
              </Show>
            </>
          }
        />
      }
    >
      <Pane label={t.calendar} status={<StatusRow lead={t.shown({ count: shownCount() })} loading={loading()} facts={statusFacts()} />}>
        <Show
          when={!catalogFailed()}
          fallback={<Failed text={`${t.catalogFailed} ${t.catalogFailedBody}`} onRetry={() => void retryCatalog()} />}
        >
          <Show when={status()?.kind === "failed" || status()?.kind === "truncated" ? status() : undefined}>
            {(current) => (
              <Notice tone="warn" icon="alert-triangle" actions={[{ label: t.retry, icon: "refresh", onClick: () => void retry() }]}>
                {problem(current())}
              </Notice>
            )}
          </Show>
          <Show when={empty()}>
            {(kind) => (
              <Show when={kind() !== "sources"} fallback={<Empty icon="calendar" text={`${t.noSources} ${t.noSourcesBody}`} />}>
                <Show
                  when={kind() === "events"}
                  fallback={
                    <Empty
                      icon="calendar-off"
                      text={`${t.noCalendarChosen} ${t.noCalendarChosenBody}`}
                      action={
                        defaults().length > 0 ? { label: t.restoreDefault, icon: "restore", onClick: () => choose(defaults()) } : undefined
                      }
                    />
                  }
                >
                  <Empty
                    icon="calendar"
                    text={`${noEventsTitle()} ${t.noEventsBody({ count: selection().length })}`}
                    action={
                      todayKey() < shownDays().first || todayKey() > shownDays().last
                        ? { label: t.goToday, icon: "calendar-due", href: viewHref(view(), todayKey()) }
                        : undefined
                    }
                  />
                </Show>
              </Show>
            )}
          </Show>
          {/* The calendar draws, scrolls and pages its days itself; its list view is the agenda of the next days. */}
          <Canvas label={t.calendar}>
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
              selectedEventId={detail() ?? undefined}
              onEventActivate={(event) => {
                const item = itemsByKey().get(event.id);
                if (item) openDetail(item);
              }}
            >
              <Show when={view() === "list"}>
                <AgendaList
                  date={date()}
                  items={shownItems()}
                  lookup={lookup()}
                  today={todayKey()}
                  selectedKey={detail() ?? undefined}
                  dateConfig={props.dateConfig}
                  onOpen={(item) => openDetail(item)}
                />
              </Show>
            </Calendar>
          </Canvas>
        </Show>
      </Pane>
      <Show when={detailItem()}>
        {(item) => {
          const found = () => lookup().get(calendarKey(item().appId, item().calendarId));
          return (
            <EventDetail
              item={item()}
              source={found()?.source}
              calendar={found()?.calendar}
              dateConfig={props.dateConfig}
              onClose={() => setDetail(null)}
            />
          );
        }}
      </Show>
    </Workspace>
  );
}
