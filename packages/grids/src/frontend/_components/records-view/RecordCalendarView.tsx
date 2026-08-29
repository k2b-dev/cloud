import { dates as calendar, type DateContext } from "@k2b/stdlib";
import { Button, Calendar, type CalendarEvent, Placeholder, useLocale } from "@k2b/ui";
import { createMemo, Show } from "solid-js";
import type { PublicField as Field, PublicGridRecord as GridRecord } from "../../../api/public-dto";
import type { RecordDisplayConfig } from "../../../contracts";
import { recordDisplayTitle } from "../records/record-display";
import type { GridsCalendarView } from "./display-mode";
import { recordsViewMessages } from "./messages";

export function RecordCalendarView(props: {
  items: GridRecord[];
  fields: Field[];
  displayConfig: RecordDisplayConfig;
  calendarState: { view: GridsCalendarView; date: string };
  onCalendarChange: (next: { view: GridsCalendarView; date: string }) => void;
  selectedRecordId?: string | null;
  onRecordClick: (record: GridRecord) => void;
  dateConfig?: DateContext;
  fieldsByTable?: Record<string, Field[]>;
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
}) {
  const locale = useLocale();
  const t = () => recordsViewMessages.resolve([locale()]).t;
  const dateField = () => {
    const fieldId = props.displayConfig.calendar?.dateFieldId;
    return fieldId ? props.fields.find((field) => field.id === fieldId && field.type === "date" && !field.deletedAt) : undefined;
  };
  const includeTime = () => Boolean((dateField()?.config as { includeTime?: boolean } | undefined)?.includeTime);
  const events = createMemo<CalendarEvent[]>(() => {
    const field = dateField();
    if (!field) return [];
    return props.items.flatMap((record) => {
      const raw = record.data[field.id];
      if (typeof raw !== "string" || !raw.trim()) return [];
      return [
        {
          id: record.id,
          title: recordDisplayTitle({
            fields: props.fields,
            record,
            fieldsByTable: props.fieldsByTable,
            dateConfig: props.dateConfig,
          }),
          start: raw,
          allDay: !includeTime(),
          color: "blue",
          meta: field.name,
        } satisfies CalendarEvent,
      ];
    });
  });
  const selectedDate = () => calendar.parseCalendarDate(props.calendarState.date, props.dateConfig);
  const commit = (next: { view?: string; date?: Date | string }) => {
    const view = (next.view ?? props.calendarState.view) as GridsCalendarView;
    const date = next.date ? calendar.formatDateKey(next.date, props.dateConfig) : props.calendarState.date;
    props.onCalendarChange({ view, date });
  };

  return (
    <div class="paper relative min-h-0 flex-1 overflow-hidden">
      <Show
        when={dateField()}
        fallback={<Placeholder icon="ti ti-calendar" class="min-h-48 justify-center" description={<>{t().chooseDateField}</>} />}
      >
        <Calendar
          class="h-full"
          date={selectedDate()}
          view={props.calendarState.view}
          views={["day", "week", "month", "year"]}
          events={events()}
          selectedEventId={props.selectedRecordId ?? undefined}
          dateConfig={props.dateConfig}
          onViewChange={(view) => commit({ view })}
          onDateChange={(date, view) => commit({ date, view })}
          onEventActivate={(event) => {
            const record = props.items.find((item) => item.id === event.id);
            if (record) props.onRecordClick(record);
          }}
        />
        <Show when={props.hasMore}>
          <Button
            variant="secondary"
            size="sm"
            type="button"
            class="absolute bottom-3 left-1/2 z-10 -translate-x-1/2 shadow-sm"
            onClick={props.onLoadMore}
            disabled={props.loadingMore}
          >
            {props.loadingMore ? <i class="ti ti-loader-2 animate-spin" /> : <i class="ti ti-chevron-down" />}
            {t().loadMoreEvents}
          </Button>
        </Show>
      </Show>
    </div>
  );
}
