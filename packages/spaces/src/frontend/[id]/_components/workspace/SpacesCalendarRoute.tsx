import type { DateContext } from "@k2b/stdlib";
import { Button, InlineGuidance, useLocale } from "@k2b/ui";
import { createEffect, createSignal, on, onCleanup, onMount, Show, untrack } from "solid-js";
import type { CalendarItem, SpaceColumn, SpaceItemTemplate, SpaceTag } from "@/contracts";
import { subscribeToDetailSelection } from "../../../lib/detail";
import { createRetryToasts } from "../../../lib/feedback";
import { useSpaceMessages } from "../../messages";
import Calendar from "../calendar";
import { type CalendarFilter, parseCalendarRoute } from "../calendar/filter";
import {
  CALENDAR_MAX_DAYS,
  type CalendarRange,
  calendarBlock,
  calendarBlockDays,
  calendarWindow,
  isBlockLoadingCalendarView,
  mergeCalendarItems,
} from "../calendar/range";
import type { CalendarView, DayWeather } from "../calendar/types";
import { calendarViewSource, useSpacesCalendarQuery } from "./calendar-query";
import { loadSpacesViewSnapshot } from "./view-query";
import type { CalendarTray } from "./workspace-types";

const DAY_MS = 24 * 60 * 60 * 1000;

type CalendarState = {
  view: CalendarView;
  date: string;
  filter: CalendarFilter;
  range: CalendarRange;
  items: CalendarItem[];
  weather: Record<string, DayWeather>;
  tray: CalendarTray | null;
};

/**
 * The days a day, week, or month view holds: the first window of its snapshot plus every block loaded since while the reader
 * scrolled. The tray and the weather come with each snapshot, so a refresh or another filter renews them; the weeks
 * loaded while scrolling leave them as they are.
 */
type StreamState = CalendarRange & {
  source: string;
  view: "day" | "week" | "month";
  anchor: string;
  filter: CalendarFilter;
  items: CalendarItem[];
};

type Props = {
  spaceId: string;
  baseUrl: string;
  columns: SpaceColumn[];
  tags: SpaceTag[];
  templates?: SpaceItemTemplate[];
  initialState: CalendarState;
  selectedItemId: string;
  dateConfig?: DateContext;
  canWrite: boolean;
  currentUserId: string;
};

export default function SpacesCalendarRoute(props: Props) {
  const t = useSpaceMessages();
  const locale = useLocale();
  const retryToast = createRetryToasts();
  const [selectedItemId, setSelectedItemId] = createSignal(props.selectedItemId);
  const streamOf = (source: string, snapshot: CalendarState): StreamState | null =>
    isBlockLoadingCalendarView(snapshot.view)
      ? { source, view: snapshot.view, anchor: snapshot.date, filter: snapshot.filter, ...snapshot.range, items: snapshot.items }
      : null;
  const [stream, setStream] = createSignal(streamOf(calendarViewSource(props.baseUrl), props.initialState));
  const [loadingBlocks, setLoadingBlocks] = createSignal(0);
  /** Counts the snapshots that started to load: a week loaded meanwhile may predate a change they bring. */
  let snapshotsStarted = 0;
  const navigation = useSpacesCalendarQuery({
    spaceId: props.spaceId,
    initialSource: props.baseUrl,
    initialSnapshot: { kind: "calendar", ...props.initialState },
    dateConfig: props.dateConfig,
    // A refresh or another filter from any loaded day covers every day the view already shows.
    rangeFor: (source) => {
      snapshotsStarted += 1;
      const current = stream();
      if (!current) return undefined;
      const route = parseCalendarRoute(new URL(source, "http://spaces.local"), props.dateConfig);
      const date = Date.parse(route.date);
      return route.view === current.view && Date.parse(current.from) <= date && date < Date.parse(current.to)
        ? { from: current.from, to: current.to }
        : undefined;
    },
  });
  const state = navigation.current;

  // A refresh of the same days merges into the loaded ones; another view, filter, or date replaces them.
  createEffect(
    on(
      navigation.loaded,
      (loaded) => {
        const incoming = loaded ? streamOf(loaded.source, loaded.snapshot) : null;
        const current = untrack(stream);
        setStream(
          incoming && current && current.source === incoming.source && current.anchor === incoming.anchor
            ? { ...current, ...mergeCalendarItems(current, incoming, props.dateConfig) }
            : incoming,
        );
      },
      { defer: true },
    ),
  );

  /** Weeks wait for a snapshot that is loading: it decides the days it covers, and the weeks add to them. */
  let waiting: Array<() => void> = [];
  createEffect(() => {
    if (navigation.pending()) return;
    const resume = waiting;
    waiting = [];
    for (const next of resume) next();
  });
  const settled = () => (untrack(navigation.pending) ? new Promise<void>((resume) => waiting.push(resume)) : Promise.resolve());

  const loads = new Set<AbortController>();
  onCleanup(() => {
    for (const load of loads) load.abort();
  });
  /**
   * The stream still shows the same days: the same view, and its date lies in the days loaded before, which `rangeFor`
   * keeps for it.
   */
  const sameDays = (previous: StreamState, next: StreamState) => {
    const anchor = Date.parse(next.anchor);
    return (
      next.view === previous.view &&
      (next.anchor === previous.anchor || (Date.parse(previous.from) <= anchor && anchor < Date.parse(previous.to)))
    );
  };
  /**
   * The source a block loads from names the view it fills: a link without a view or an old timeline link opens the
   * month, and the server loads the days a block asks for only for a view that scrolls.
   */
  const blockSource = (current: StreamState) => {
    const url = new URL(current.source, "http://spaces.local");
    url.searchParams.set("cv", current.view);
    return `${url.pathname}${url.search}`;
  };
  /**
   * Loads the week before or after the loaded days. A snapshot that started meanwhile, such as a refresh after a change
   * or another filter, may bring something the week predates; such a week never joins. It loads again once that
   * snapshot is in, against the days it brings, so the reader still gets the week they scrolled to. Another anchor
   * inside the same view's loaded days keeps the load; an anchor outside them or another view ends it.
   */
  const loadBlock = async (edge: "earlier" | "later"): Promise<void> => {
    let previous = stream();
    const load = new AbortController();
    loads.add(load);
    setLoadingBlocks((count) => count + 1);
    try {
      for (;;) {
        await settled();
        const current = stream();
        // Another view or a date outside the loaded days asks for its own weeks.
        if (load.signal.aborted || !previous || !current || !sameDays(previous, current)) return;
        previous = current;
        const block = calendarBlock(current, edge, calendarBlockDays(current.view), props.dateConfig);
        if (!block) return;
        const started = snapshotsStarted;
        // The tray stays with the snapshot of the days, so a week loads without it.
        const snapshot = await loadSpacesViewSnapshot(blockSource(current), load.signal, locale(), { ...block, includeTray: "false" });
        const latest = stream();
        if (snapshot.kind !== "calendar" || !latest || !sameDays(previous, latest)) return;
        previous = latest;
        const moved = edge === "earlier" ? latest.from !== block.to : latest.to !== block.from;
        if (snapshotsStarted !== started || latest.source !== current.source || moved) continue;
        const merged = mergeCalendarItems(latest, { ...block, items: snapshot.items }, props.dateConfig);
        // Weeks at both ends load at once; together they must stay within the range a refresh may ask for.
        if (Date.parse(merged.to) - Date.parse(merged.from) > CALENDAR_MAX_DAYS * DAY_MS) return;
        setStream({ ...latest, ...merged });
        return;
      }
    } catch {
      if (!load.signal.aborted) retryToast(t.calendarDaysLoadFailed, t.retry, () => loadBlock(edge));
    } finally {
      loads.delete(load);
      setLoadingBlocks((count) => count - 1);
    }
  };

  /**
   * A preview inside the loaded days keeps their range and items while its own load; another view or date opens at the
   * days of its own first window.
   */
  const shown = () => {
    const current = stream();
    const snapshot = state();
    if (current && current.view === snapshot.view && current.anchor === snapshot.date) {
      return { range: { from: current.from, to: current.to }, items: current.items };
    }
    const date = Date.parse(snapshot.date);
    if (current && current.view === snapshot.view && Date.parse(current.from) <= date && date < Date.parse(current.to))
      return { range: { from: current.from, to: current.to }, items: current.items };
    // A view that scrolls opens at the days its own snapshot will cover, not at those of the view it replaces, so the
    // month sets its first week on top at once and stays there when the items arrive.
    return {
      range: isBlockLoadingCalendarView(snapshot.view)
        ? calendarWindow(snapshot.view, new Date(snapshot.date), props.dateConfig)
        : snapshot.range,
      items: snapshot.items,
    };
  };

  onMount(() => {
    const unsubscribe = subscribeToDetailSelection(({ selectionId }) => setSelectedItemId(selectionId ?? ""));
    onCleanup(unsubscribe);
  });

  return (
    <div class="flex min-h-0 flex-1 flex-col overflow-hidden" data-scroll-preserve={`spaces-main-${props.spaceId}`}>
      <Show when={navigation.error()}>
        {(error) => (
          <div class="flex items-center justify-between gap-2 pb-1">
            <InlineGuidance tone="danger" icon="ti ti-alert-circle" role="alert">
              {error().message}
            </InlineGuidance>
            <Button type="button" variant="ghost" size="xs" onClick={() => void navigation.refresh()}>
              {t.retry}
            </Button>
          </div>
        )}
      </Show>
      <Calendar
        spaceId={props.spaceId}
        items={shown().items}
        range={shown().range}
        columns={props.columns}
        tags={props.tags}
        templates={props.templates}
        filter={state().filter}
        selectedItemId={selectedItemId()}
        view={state().view}
        date={new Date(state().date)}
        baseUrl={props.baseUrl}
        weather={state().weather}
        dateConfig={props.dateConfig}
        canWrite={props.canWrite}
        currentUserId={props.currentUserId}
        onNavigateHref={navigation.navigateHref}
        onRouteChange={navigation.open}
        onFollowHref={navigation.follow}
        navigationPending={navigation.pending() || loadingBlocks() > 0}
        onLoadEarlier={stream() ? () => loadBlock("earlier") : undefined}
        onLoadLater={stream() ? () => loadBlock("later") : undefined}
        tray={state().tray}
      />
    </div>
  );
}
