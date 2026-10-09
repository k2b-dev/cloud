import type { DateContext } from "@k2b/stdlib";
import { Button, InlineGuidance, useLocale } from "@k2b/ui";
import { createEffect, createSignal, on, onCleanup, onMount, Show, untrack } from "solid-js";
import type { CalendarItem, SpaceColumn, SpaceTag } from "@/contracts";
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
type TimelineState = TimelineRange & { source: string; anchor: string; items: CalendarItem[] };

type Props = {
  spaceId: string;
  baseUrl: string;
  columns: SpaceColumn[];
  tags: SpaceTag[];
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
    snapshot.view === "timeline" ? { source, anchor: snapshot.date, ...snapshot.range, items: snapshot.items } : null;
  const [timeline, setTimeline] = createSignal(timelineOf(calendarViewSource(props.baseUrl), props.initialState));
  const [loadingBlocks, setLoadingBlocks] = createSignal(0);
  const navigation = useSpacesCalendarQuery({
    spaceId: props.spaceId,
    initialSource: props.baseUrl,
    initialSnapshot: { kind: "calendar", ...props.initialState },
    dateConfig: props.dateConfig,
    // A refresh or another filter covers every day the strip already shows, so nothing it shows goes missing.
    timelineRange: (source) => {
      const current = timeline();
      if (!current) return undefined;
      const route = parseCalendarRoute(new URL(source, "http://spaces.local"), props.dateConfig);
      return route.view === "timeline" && route.date === current.anchor ? { from: current.from, to: current.to } : undefined;
    },
  });
  const state = navigation.current;

  /** Counts snapshots taken over, so a week that loaded while a fresher snapshot came in does not overwrite it. */
  let generation = 0;
  // A refresh of the same days merges into the strip; another filter or anchor day replaces it.
  createEffect(
    on(
      navigation.loaded,
      (loaded) => {
        generation += 1;
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

  const loads = new Set<AbortController>();
  onCleanup(() => {
    for (const load of loads) load.abort();
  });
  const loadBlock = async (edge: "earlier" | "later"): Promise<void> => {
    const current = timeline();
    const block = current && timelineBlock(current, edge, props.dateConfig);
    if (!current || !block) return;
    const started = generation;
    const load = new AbortController();
    loads.add(load);
    setLoadingBlocks((count) => count + 1);
    try {
      const snapshot = await loadSpacesViewSnapshot(current.source, load.signal, locale(), block);
      const latest = timeline();
      // A new filter, anchor day, or refresh in the meantime decides the days on its own.
      if (snapshot.kind !== "calendar" || !latest || latest.source !== current.source || latest.anchor !== current.anchor) return;
      if (edge === "earlier" ? latest.from !== block.to : latest.to !== block.from) return;
      // The snapshot that came in meanwhile is fresher than this week's items at the edge; load the week again.
      if (generation !== started) return loadBlock(edge);
      const merged = mergeTimelineItems(latest, { ...block, items: snapshot.items });
      // Weeks at both ends load at once; together they must stay within the range a refresh may ask for.
      if (Date.parse(merged.to) - Date.parse(merged.from) > TIMELINE_MAX_DAYS * DAY_MS) return;
      setTimeline({ ...latest, ...merged });
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
