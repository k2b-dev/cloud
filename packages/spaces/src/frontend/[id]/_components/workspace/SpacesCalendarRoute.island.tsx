import type { DateContext } from "@k2b/stdlib";
import { Button, InlineGuidance, useLocale } from "@k2b/ui";
import { createEffect, createSignal, on, onCleanup, onMount, Show, untrack } from "solid-js";
import type { CalendarItem, SpaceColumn, SpaceItemTemplate, SpaceTag } from "@/contracts";
import { subscribeToDetailSelection } from "../../../lib/detail";
import { createRetryToasts } from "../../../lib/feedback";
import { useSpaceMessages } from "../../messages";
import Calendar from "../calendar";
import { type CalendarFilter, parseCalendarRoute } from "../calendar/filter";
import { CALENDAR_MAX_DAYS, type CalendarRange, calendarBlock, isScrollingCalendarView, mergeCalendarItems } from "../calendar/range";
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
 * The days a day or week view holds: the first window of its snapshot plus every week loaded since while the reader
 * scrolled. The tray and the weather come with each snapshot, so a refresh or another filter renews them; the weeks
 * loaded while scrolling leave them as they are.
 */
type StreamState = CalendarRange & {
  source: string;
  view: "day" | "week";
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
    isScrollingCalendarView(snapshot.view)
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
    // A refresh or another filter covers every day the view already shows, so nothing it shows goes missing.
    rangeFor: (source) => {
      snapshotsStarted += 1;
      const current = stream();
      if (!current) return undefined;
      const route = parseCalendarRoute(new URL(source, "http://spaces.local"), props.dateConfig);
      return route.view === current.view && route.date === current.anchor ? { from: current.from, to: current.to } : undefined;
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
   * Loads the week before or after the loaded days. A snapshot that started meanwhile, such as a refresh after a change
   * or another filter, may bring something the week predates; such a week never joins. It loads again once that
   * snapshot is in, against the days it brings, so the reader still gets the week they scrolled to.
   */
  const loadBlock = async (edge: "earlier" | "later"): Promise<void> => {
    const anchor = stream()?.anchor;
    const load = new AbortController();
    loads.add(load);
    setLoadingBlocks((count) => count + 1);
    try {
      for (;;) {
        await settled();
        const current = stream();
        // Another date opens new days, which ask for their own weeks.
        if (load.signal.aborted || !current || current.anchor !== anchor) return;
        const block = calendarBlock(current, edge, props.dateConfig);
        if (!block) return;
        const started = snapshotsStarted;
        // The tray stays with the snapshot of the days, so a week loads without it.
        const snapshot = await loadSpacesViewSnapshot(current.source, load.signal, locale(), { ...block, includeTray: "false" });
        const latest = stream();
        if (snapshot.kind !== "calendar" || !latest || latest.anchor !== anchor) return;
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

  /** The days the calendar shows: the loaded weeks of a day or week view, else the snapshot. */
  const shown = () => {
    const current = stream();
    const snapshot = state();
    return current && current.view === snapshot.view && current.anchor === snapshot.date
      ? { range: { from: current.from, to: current.to }, items: current.items }
      : { range: snapshot.range, items: snapshot.items };
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
