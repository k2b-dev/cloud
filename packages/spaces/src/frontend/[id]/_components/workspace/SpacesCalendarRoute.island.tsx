import type { DateContext } from "@k2b/stdlib";
import { Button, InlineGuidance } from "@k2b/ui";
import { createSignal, onCleanup, onMount, Show } from "solid-js";
import type { CalendarItem, SpaceColumn, SpaceTag } from "@/contracts";
import { subscribeToDetailSelection } from "../../../lib/detail";
import Calendar from "../calendar";
import type { CalendarFilter } from "../calendar/filter";
import type { CalendarView, DayWeather } from "../calendar/types";
import { useSpacesCalendarQuery } from "./calendar-query";

type CalendarState = {
  view: CalendarView;
  date: string;
  filter: CalendarFilter;
  items: CalendarItem[];
  weather: Record<string, DayWeather>;
};

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
  const [selectedItemId, setSelectedItemId] = createSignal(props.selectedItemId);
  const navigation = useSpacesCalendarQuery({
    spaceId: props.spaceId,
    initialSource: props.baseUrl,
    initialSnapshot: { kind: "calendar", ...props.initialState },
    dateConfig: props.dateConfig,
  });
  const state = navigation.current;
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
      />
    </div>
  );
}
