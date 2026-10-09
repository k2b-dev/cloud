import type { DateContext } from "@k2b/stdlib";
import { Button, InlineGuidance, useLocale } from "@k2b/ui";
import { createEffect, createSignal, on, onCleanup, onMount, Show, untrack } from "solid-js";
import type { CalendarItem, SpaceColumn, SpaceItemTemplate, SpaceTag } from "@/contracts";
import { subscribeToDetailSelection } from "../../../lib/detail";
import { createRetryToasts } from "../../../lib/feedback";
import { useSpaceMessages } from "../../messages";
import Calendar from "../calendar";
import { type CalendarFilter, parseCalendarRoute } from "../calendar/filter";
import { mergeTimelineItems, TIMELINE_MAX_DAYS, type TimelineRange, timelineBlock } from "../calendar/timeline";
import type { CalendarView, DayWeather } from "../calendar/types";
import { calendarViewSource, useSpacesCalendarQuery } from "./calendar-query";
import { loadSpacesViewSnapshot } from "./view-query";

const DAY_MS = 24 * 60 * 60 * 1000;

type CalendarState = {
  view: CalendarView;
  date: string;
  filter: CalendarFilter;
  range: TimelineRange;
  items: CalendarItem[];
  weather: Record<string, DayWeather>;
};

/** The days the timeline holds: the first window of its snapshot plus every week loaded since. */
type TimelineState = TimelineRange & { source: string; anchor: string; filter: CalendarFilter; items: CalendarItem[] };

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
};

export default function SpacesCalendarRoute(props: Props) {
  const t = useSpaceMessages();
  const locale = useLocale();
  const retryToast = createRetryToasts();
  const [selectedItemId, setSelectedItemId] = createSignal(props.selectedItemId);
  const timelineOf = (source: string, snapshot: CalendarState): TimelineState | null =>
    snapshot.view === "timeline"
      ? { source, anchor: snapshot.date, filter: snapshot.filter, ...snapshot.range, items: snapshot.items }
      : null;
  const [timeline, setTimeline] = createSignal(timelineOf(calendarViewSource(props.baseUrl), props.initialState));
  const [loadingBlocks, setLoadingBlocks] = createSignal(0);
  /** Counts the snapshots that started to load: a week loaded meanwhile may predate a change they bring. */
  let snapshotsStarted = 0;
  const navigation = useSpacesCalendarQuery({
    spaceId: props.spaceId,
    initialSource: props.baseUrl,
    initialSnapshot: { kind: "calendar", ...props.initialState },
    dateConfig: props.dateConfig,
    // A refresh or another filter covers every day the strip already shows, so nothing it shows goes missing.
    timelineRange: (source) => {
      snapshotsStarted += 1;
      const current = timeline();
      if (!current) return undefined;
      const route = parseCalendarRoute(new URL(source, "http://spaces.local"), props.dateConfig);
      return route.view === "timeline" && route.date === current.anchor ? { from: current.from, to: current.to } : undefined;
    },
  });
  const state = navigation.current;

  // A refresh of the same days merges into the strip; another filter or anchor day replaces it.
  createEffect(
    on(
      navigation.loaded,
      (loaded) => {
        const incoming = loaded ? timelineOf(loaded.source, loaded.snapshot) : null;
        const current = untrack(timeline);
        setTimeline(
          incoming && current && current.source === incoming.source && current.anchor === incoming.anchor
            ? { ...current, ...mergeTimelineItems(current, incoming) }
            : incoming,
        );
      },
      { defer: true },
    ),
  );

  /** Weeks that wait for the snapshot that is loading: it decides the days it covers, and the weeks add to them. */
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
   * Loads the week before or after the strip. A snapshot that started meanwhile, such as a refresh after a change or
   * another filter, may bring something the week predates; such a week never joins the strip. It loads again once that
   * snapshot is in, against the strip it brings, so the reader still gets the week they asked for.
   */
  const loadBlock = async (edge: "earlier" | "later"): Promise<void> => {
    const anchor = timeline()?.anchor;
    const load = new AbortController();
    loads.add(load);
    setLoadingBlocks((count) => count + 1);
    try {
      for (;;) {
        await settled();
        const current = timeline();
        // Another anchor day opens a new strip, which asks for its own weeks.
        if (load.signal.aborted || !current || current.anchor !== anchor) return;
        const block = timelineBlock(current, edge, props.dateConfig);
        if (!block) return;
        const started = snapshotsStarted;
        const snapshot = await loadSpacesViewSnapshot(current.source, load.signal, locale(), block);
        const latest = timeline();
        if (snapshot.kind !== "calendar" || !latest || latest.anchor !== anchor) return;
        const moved = edge === "earlier" ? latest.from !== block.to : latest.to !== block.from;
        if (snapshotsStarted !== started || latest.source !== current.source || moved) continue;
        const merged = mergeTimelineItems(latest, { ...block, items: snapshot.items });
        // Weeks at both ends load at once; together they must stay within the range a refresh may ask for.
        if (Date.parse(merged.to) - Date.parse(merged.from) > TIMELINE_MAX_DAYS * DAY_MS) return;
        setTimeline({ ...latest, ...merged });
        return;
      }
    } catch {
      if (!load.signal.aborted) retryToast(t.timelineLoadFailed, t.retry, () => loadBlock(edge));
    } finally {
      loads.delete(load);
      setLoadingBlocks((count) => count - 1);
    }
  };

  const timelineProps = () => {
    const current = timeline();
    return current
      ? { ...current, busy: loadingBlocks() > 0, onLoadEarlier: () => loadBlock("earlier"), onLoadLater: () => loadBlock("later") }
      : undefined;
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
              Retry
            </Button>
          </div>
        )}
      </Show>
      <Calendar
        spaceId={props.spaceId}
        items={state().items}
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
        onNavigateHref={navigation.navigateHref}
        onRouteChange={navigation.open}
        navigationPending={navigation.pending()}
        timeline={timelineProps()}
      />
    </div>
  );
}
