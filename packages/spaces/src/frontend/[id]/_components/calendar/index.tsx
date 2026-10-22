import { registerContextAwareCommand } from "@k2b/cloud/browser/commands";
import { navigate } from "@k2b/ssr/nav";
import type { DateContext } from "@k2b/stdlib";
import { dates as calendar } from "@k2b/stdlib";
import { mutation as mutations, query } from "@k2b/stdlib/solid";
import {
  Button,
  type CalendarCommand,
  type CalendarController,
  type CalendarEvent,
  type CalendarEventRenderContext,
  type CalendarEventTimeChange,
  type CalendarSelectionControls,
  Calendar as CoreCalendar,
  type CalendarView as CoreCalendarView,
  type DropdownItem,
  dialogCore,
  FilterChip,
  type FilterChipSection,
  PanelDialog,
  panelDialogOptions,
  toast,
} from "@k2b/ui";
import { createEffect, createMemo, createSignal, on, onCleanup, Show, untrack } from "solid-js";
import { apiClient } from "@/api/client";
import {
  AssignedToFilterSchema,
  type CalendarItem,
  ItemTypeSchema,
  PrioritySchema,
  type Recurrence,
  type SpaceColumn,
  type SpaceItem,
} from "@/contracts";
import { isDateOnlyDeadline } from "@/presentation/deadline";
import { createRetryToasts } from "../../../lib/feedback";
import { readResponseError } from "../../../lib/response";
import { spaceMessages, useSpaceMessages } from "../../messages";
import { resolveCompletionClaim } from "../shared/claim/claim";
import { confirmCompletion, setItemCompleted } from "../shared/completion";
import { createSpaceItem } from "../shared/editItem";
import ItemForm, { type ItemFormData } from "../shared/ItemForm";
import { allDayEnd, allDayStart, instantFromLocalDateTime } from "../shared/item-form/date";
import { itemCreateDialogOptions } from "../shared/item-form/dialog";
import { createTimeBlock, deleteTimeBlock, updateTimeBlock } from "../time-blocks/client";
import { useTimeBlockMessages } from "../time-blocks/messages";
import { isAssignedPerson, openOrphanTimeBlock } from "../time-blocks/TimeBlocksSection";
import { invalidateSpacesData, requestSpacesDetailNavigation, requestSpacesRouteNavigation } from "../workspace/workspace-events";
import { CALENDAR_NEUTRAL_COLOR, calendarItemColors, isCalendarFlagged, isCalendarTask } from "./colors";
import { countCalendarEvents, countTimeBlocks } from "./count";
import { type CalendarColorBy, CalendarColorBySchema, type CalendarFilter, defaultCalendarFilter, writeCalendarFilter } from "./filter";
import { CalendarItemContent } from "./ItemContent";
import QuickCreate, {
  type CalendarDays,
  type QuickCreateDefaults,
  type QuickCreateKind,
  quickCreateDefaults,
  quickCreateKind,
} from "./QuickCreate";
import { CALENDAR_DAY_HOURS, countCalendarDays, isScrollingCalendarView } from "./range";
import TaskTray from "./TaskTray";
import { taskTrayFiltered, taskTrayFilters, taskTrayListHref } from "./tray";
import type { CalendarProps, CalendarView } from "./types";

const eventStart = (item: CalendarItem, dateConfig?: DateContext) =>
  item.startsAt ??
  (item.deadline && isDateOnlyDeadline(item.deadline) ? allDayStart(item.deadline, dateConfig) : item.deadline) ??
  calendar.today(dateConfig).toISOString();
const eventEnd = (item: CalendarItem, dateConfig?: DateContext) =>
  item.endsAt ??
  (item.deadline && isDateOnlyDeadline(item.deadline) ? allDayEnd(item.deadline, dateConfig) : item.deadline) ??
  eventStart(item, dateConfig);

const buildCalendarHref = (
  baseUrl: string,
  view: CalendarView,
  date: Date,
  filter: CalendarFilter,
  item?: string,
  occurrence?: string,
  dateConfig?: DateContext,
) => {
  const url = new URL(baseUrl, "http://spaces.local");
  url.searchParams.set("view", "calendar");
  url.searchParams.set("cv", view);
  url.searchParams.set("cd", calendar.formatDateKey(date, dateConfig));
  writeCalendarFilter(url, filter);
  url.searchParams.delete("block");
  if (item) {
    url.searchParams.set("item", item);
    if (occurrence) url.searchParams.set("occurrence", occurrence);
    else url.searchParams.delete("occurrence");
  } else {
    url.searchParams.delete("item");
    url.searchParams.delete("occurrence");
  }
  return `${url.pathname}?${url.searchParams.toString()}`;
};

/** Spaces never shows the compact mobile month, so its links name the month view. */
const asView = (view: CoreCalendarView): CalendarView => (view === "mobile-month" ? "month" : view);

const isAllDayCalendarItem = (item: CalendarItem, view: CalendarView) =>
  item.allDay ||
  (!item.startsAt &&
    (item.deadlineAllDay || (item.deadline !== null && isDateOnlyDeadline(item.deadline)) || !isScrollingCalendarView(view)));

const toCalendarEvent = (
  item: CalendarItem,
  columns: SpaceColumn[],
  baseUrl: string,
  view: CalendarView,
  date: Date,
  filter: CalendarFilter,
  dateConfig?: DateContext,
): CalendarEvent => {
  const { t } = spaceMessages.resolve(dateConfig?.locale ? [dateConfig.locale] : []);
  const isDeadline = isCalendarTask(item);
  // A deadline is a point in time where the day and week views have hours; the month and year list it on its day.
  const detailItemId = item.isRecurringInstance ? (item.recurringEventId ?? item.id) : item.id;
  const occurrenceId = item.recurrenceId ?? undefined;
  return {
    id: item.id,
    title: item.title,
    description: item.descriptionPreview ?? undefined,
    start: eventStart(item, dateConfig),
    end: eventEnd(item, dateConfig),
    allDay: isAllDayCalendarItem(item, view),
    colorHex: calendarItemColors(item, filter.colorBy, columns).color,
    display: isDeadline ? "marker" : undefined,
    checked: calendarCheckable(item) ? false : undefined,
    // The checkbox marker and the flag are visual only, so the accessible name says what they show.
    accessibleDetail:
      [isDeadline ? t.deadline : null, isCalendarFlagged(item) ? `${t.priority}: ${item.priority === "urgent" ? t.urgent : t.high}` : null]
        .filter(Boolean)
        .join(", ") || undefined,
    href: buildCalendarHref(baseUrl, view, date, filter, detailItemId, occurrenceId, dateConfig),
    dataSpaceItemId: detailItemId,
    calendarName: item.spaceName,
    location: item.location ?? undefined,
    meta: isDeadline ? t.deadline : item.spaceName,
    recurrence: item.recurrence
      ? {
          rrule: item.recurrence.rrule,
          exdate: item.recurrence.exdate,
          recurrenceId: item.recurrenceId ?? undefined,
        }
      : item.recurrenceId
        ? { rrule: "", recurrenceId: item.recurrenceId }
        : undefined,
  };
};

/**
 * The calendar lists open items only, so a box is always unchecked: a task with a deadline, or one planned into a time
 * slot that keeps its deadline. A recurring or blocked task has none; it completes in its detail.
 */
const calendarCheckable = (item: CalendarItem) =>
  Boolean(item.deadline) && !item.recurrence && !item.recurringEventId && !item.isRecurringInstance && item.activeBlockerCount === 0;

type RecurringEditScope = "occurrence" | "future" | "series";

const isRecurringCalendarEvent = (event: CalendarEvent) => Boolean(event.recurrence?.recurrenceId);

const recurrenceIdFromEvent = (event: CalendarEvent): string | null => {
  const value = event.recurrence?.recurrenceId;
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

const shiftedIso = (value: string, milliseconds: number): string => new Date(new Date(value).getTime() + milliseconds).toISOString();

const normalizeCreatePayload = <T extends ItemFormData>(data: T) => ({
  ...data,
  location: data.location ?? undefined,
  url: data.url ?? undefined,
  priority: data.priority ?? undefined,
  recurrence: data.recurrence ?? undefined,
  estimatedDurationMinutes: data.estimatedDurationMinutes ?? undefined,
});

const createPayloadFromItem = (item: SpaceItem, overrides: Partial<ItemFormData> = {}): ItemFormData => ({
  columnId: overrides.columnId ?? item.columnId,
  title: overrides.title ?? item.title,
  description: overrides.description ?? item.description ?? undefined,
  location: overrides.location ?? item.location ?? undefined,
  url: overrides.url ?? item.url ?? undefined,
  startsAt: overrides.startsAt ?? item.startsAt ?? undefined,
  endsAt: overrides.endsAt ?? item.endsAt ?? undefined,
  allDay: overrides.allDay ?? item.allDay,
  deadline: overrides.deadline ?? item.deadline ?? undefined,
  priority: overrides.priority ?? item.priority ?? undefined,
  // An explicit null turns one generated occurrence into a non-recurring override.
  recurrence: "recurrence" in overrides ? overrides.recurrence : item.recurrence,
  assigneeIds: overrides.assigneeIds ?? item.assignees?.map((assignee) => assignee.id),
  tagIds: overrides.tagIds ?? item.tags?.map((tag) => tag.id),
});

const chooseRecurringEditScope = async (t: ReturnType<typeof useSpaceMessages>): Promise<RecurringEditScope | null> =>
  (await dialogCore.open<RecurringEditScope | null>(
    (close) => (
      <PanelDialog>
        <PanelDialog.Header title={t.editRecurringEvent} subtitle={t.recurrenceChangeHelp} icon="ti ti-repeat" close={() => close(null)} />
        <PanelDialog.Body>
          <div class="flex flex-col gap-2 py-1">
            {[
              ["occurrence", t.thisOccurrence, t.thisOccurrenceHelp, "ti ti-calendar-event"],
              ["future", t.thisAndFuture, t.thisAndFutureHelp, "ti ti-arrow-forward-up"],
              ["series", t.entireSeries, t.entireSeriesHelp, "ti ti-repeat"],
            ].map(([scope, label, description, icon]) => (
              <button
                type="button"
                class="group flex min-h-16 items-center gap-3 rounded-[var(--ui-radius-control)] px-2 py-2 text-left outline-none transition-colors focus-visible:shadow-[var(--ui-focus)]"
                onClick={() => close(scope as RecurringEditScope)}
              >
                <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--ui-radius-control)] bg-[var(--ui-surface-muted)] text-dimmed transition-colors group-hover:text-blue-500 group-focus-visible:text-blue-500">
                  <i class={`${icon} text-base`} />
                </span>
                <span class="min-w-0 flex-1">
                  <span class="block text-sm font-medium text-primary">{label}</span>
                  <span class="block text-xs text-dimmed">{description}</span>
                </span>
                <i class="ti ti-chevron-right shrink-0 text-sm text-dimmed opacity-50 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
              </button>
            ))}
          </div>
        </PanelDialog.Body>
        <PanelDialog.Footer>
          <span />
          <Button type="button" variant="secondary" size="sm" onClick={() => close(null)}>
            {t.cancel}
          </Button>
        </PanelDialog.Footer>
      </PanelDialog>
    ),
    panelDialogOptions,
  )) ?? null;

export default function Calendar(props: CalendarProps) {
  const t = useSpaceMessages();
  const bt = useTimeBlockMessages();
  const [blockError, setBlockError] = createSignal<string>();
  const [blockRetry, setBlockRetry] = createSignal<() => Promise<void>>();
  const retryToast = createRetryToasts();
  const [optimisticTimes, setOptimisticTimes] = createSignal<Record<string, CalendarEventTimeChange>>({});
  const [createDialogPending, setCreateDialogPending] = createSignal(false);
  const [seriesItemSource, setSeriesItemSource] = createSignal<string | null>(null);
  const [controller, setController] = createSignal<CalendarController | null>(null);
  /** The focus date the scrolling view reports; the URL and other views follow it. */
  const [visibleDate, setVisibleDate] = createSignal<Date | null>(null);
  /** The days the scrolling view shows, for the count of what is in view. */
  const [visibleDays, setVisibleDays] = createSignal<{ first: string; last: string } | null>(null);
  createEffect(
    on(
      [() => props.view, () => props.date.getTime()],
      (current, previous) => {
        // A continuous month keeps counting the last reported rows while a host date waits for its weeks.
        if (
          current[0] === previous?.[0] &&
          ((props.view === "month" && props.range) || props.date.getTime() === untrack(visibleDate)?.getTime())
        )
          return;
        setVisibleDate(null);
        setVisibleDays(null);
      },
      { defer: true },
    ),
  );
  /** The date filters and the view switcher keep: the day the reader scrolled to, else the route's. */
  const shownDate = () => visibleDate() ?? props.date;
  /**
   * The toolbar counts the days in view. Month counts the events painted on its visible week rows, including days
   * outside the focus month; before the first report it counts that month's own days.
   */
  const shownCount = () => {
    if (isScrollingCalendarView(props.view)) {
      const days = visibleDays() ?? routeDays();
      return (
        countCalendarDays(props.items, days.first, days.last, props.dateConfig) +
        countTimeBlocks(props.timeBlocks ?? [], days.first, days.last, props.dateConfig)
      );
    }
    if (props.view !== "month") return events().length;
    const days = visibleDays();
    if (days)
      return countCalendarEvents(
        events(),
        days.first,
        calendar.formatDateKey(
          calendar.addDays(calendar.parseCalendarDate(days.last, props.dateConfig), 1, props.dateConfig),
          props.dateConfig,
        ),
        props.dateConfig,
      );
    const monthStart = calendar.startOfMonth(props.date, props.dateConfig);
    const firstKey = calendar.formatDateKey(monthStart, props.dateConfig);
    const endKey = calendar.formatDateKey(calendar.addMonths(monthStart, 1, props.dateConfig), props.dateConfig);
    return countCalendarEvents(events(), firstKey, endKey, props.dateConfig);
  };
  /** The days the route opens before the view says what it shows: the day, or its week. */
  const routeDays = () => {
    const day = calendar.formatDateKey(props.date, props.dateConfig);
    if (props.view === "day") return { first: day, last: day };
    // The calendar's weeks start on Monday unless the date context says otherwise.
    const context = { weekStartsOn: 1 as const, ...props.dateConfig };
    const start = calendar.startOfWeek(props.date, context);
    return {
      first: calendar.formatDateKey(start, context),
      last: calendar.formatDateKey(calendar.addDays(start, 6, context), context),
    };
  };
  const reconcileAfterWrite = (): void =>
    void invalidateSpacesData().catch(() => retryToast(t.calendarRefreshFailed, t.retry, reconcileAfterWrite));
  const seriesItemQuery = query.create<string | null, { source: string; item: SpaceItem }, { cursor: string | null }>({
    source: seriesItemSource,
    enabled: () => seriesItemSource() !== null,
    load: async (itemId, { abortSignal }) => {
      if (!itemId) throw new Error(t.recurringSeriesMissing);
      const response = await apiClient[":id"].items[":itemId"].$get(
        { param: { id: props.spaceId, itemId } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readResponseError(response, t.eventLoadFailed));
      return { source: itemId, item: await response.json() };
    },
  });
  const events = () => [
    ...props.items.map((item) => {
      const event = {
        ...toCalendarEvent(item, props.columns, props.baseUrl, props.view, props.date, props.filter, props.dateConfig),
        editable: props.canWrite,
      };
      const optimistic = optimisticTimes()[item.id];
      return optimistic ? { ...event, start: optimistic.start, end: optimistic.end, allDay: optimistic.allDay } : event;
    }),
    ...(props.timeBlocks ?? []).map((block): CalendarEvent => {
      const href = block.itemId
        ? new URL(
            buildCalendarHref(props.baseUrl, props.view, shownDate(), props.filter, block.itemId, undefined, props.dateConfig),
            "http://spaces.local",
          )
        : null;
      href?.searchParams.set("block", block.id);
      return {
        id: block.id,
        title: block.title,
        start: optimisticTimes()[block.id]?.start ?? block.startsAt,
        end: optimisticTimes()[block.id]?.end ?? block.endsAt,
        colorHex: block.taskState === "deleted" ? CALENDAR_NEUTRAL_COLOR : (block.spaceColor ?? undefined),
        editable: block.canWrite && block.taskState !== "deleted",
        meta: block.ownerName,
        accessibleDetail: `${bt.blocks}, ${block.ownerName}${block.taskState === "deleted" ? `, ${bt.deleted}` : ""}`,
        href: href ? `${href.pathname}${href.search}` : undefined,
        dataSpaceItemId: block.itemId ?? undefined,
      };
    }),
  ];
  const blocksById = createMemo(() => new Map((props.timeBlocks ?? []).map((block) => [block.id, block])));
  const itemsById = createMemo(() => new Map(props.items.map((item) => [item.id, item])));
  const renderEvent = (event: CalendarEvent, context: CalendarEventRenderContext) => {
    const block = blocksById().get(event.id);
    if (block)
      return (
        <div class="min-w-0 text-xs">
          <div class="truncate font-medium">
            <i class={`ti ${block.taskState === "done" ? "ti-circle-check" : "ti-checkbox"}`} aria-hidden="true" /> {block.title}
          </div>
          <div class="truncate">{block.taskState === "deleted" ? bt.deleted : block.ownerName}</div>
        </div>
      );
    const item = itemsById().get(event.id);
    if (!item) return undefined;
    return (
      <CalendarItemContent
        event={event}
        context={context}
        task={isCalendarTask(item)}
        flag={isCalendarFlagged(item) ? { label: item.priority === "urgent" ? t.urgent : t.high } : null}
        extra={calendarItemColors(item, props.filter.colorBy, props.columns).extra}
      />
    );
  };
  const clearOptimisticTime = (eventId: string) => {
    const current = optimisticTimes();
    if (!(eventId in current)) return;
    const next = { ...current };
    delete next[eventId];
    setOptimisticTimes(next);
  };
  let previousItems = props.items;
  let previousBlocks = props.timeBlocks;
  createEffect(() => {
    const items = props.items;
    const blocks = props.timeBlocks;
    const itemsChanged = items !== previousItems || blocks !== previousBlocks;
    previousItems = items;
    previousBlocks = blocks;
    const current = optimisticTimes();
    if (!itemsChanged) return;
    const settled = Object.entries(current).filter(([eventId, optimistic]) => {
      const item = items.find((candidate) => candidate.id === eventId);
      const block = blocks?.find((candidate) => candidate.id === eventId);
      if (block) return Date.parse(block.startsAt) === optimistic.start.getTime() && Date.parse(block.endsAt) === optimistic.end.getTime();
      return (
        !item ||
        (new Date(eventStart(item, props.dateConfig)).getTime() === optimistic.start.getTime() &&
          new Date(eventEnd(item, props.dateConfig)).getTime() === optimistic.end.getTime() &&
          Boolean(isAllDayCalendarItem(item, props.view)) === Boolean(optimistic.allDay))
      );
    });
    if (settled.length === 0) return;
    const next = { ...current };
    for (const [eventId] of settled) delete next[eventId];
    setOptimisticTimes(next);
  });
  const dayBadges = () =>
    Object.fromEntries(
      Object.entries(props.weather ?? {}).map(([date, weather]) => [
        date,
        {
          icon: weather.icon,
          label: `${Math.round(weather.tempMax)}°`,
        },
      ]),
    );
  const tagOptions = (): FilterChipSection[] => [
    {
      multiple: true,
      options: props.tags.map((tag) => ({ value: tag.id, label: tag.name, color: tag.color })),
    },
  ];
  // The color choice is one row of this menu: it changes no data, and the toolbar has no room for another control.
  const scopeOptions: FilterChipSection[] = [
    {
      label: t.type,
      options: [
        { value: "type:all", label: t.eventsAndDeadlines, icon: "ti ti-calendar" },
        { value: "type:event", label: t.events, icon: "ti ti-calendar-event" },
        { value: "type:task", label: t.deadlines, icon: "ti ti-calendar-due" },
      ],
    },
    {
      label: t.assignment,
      options: [
        { value: "assigned:all", label: t.anyone, icon: "ti ti-users" },
        { value: "assigned:assigned", label: t.assigned, icon: "ti ti-user-check" },
        { value: "assigned:me", label: t.me, icon: "ti ti-user" },
        { value: "assigned:unassigned", label: t.unassigned, icon: "ti ti-user-off" },
      ],
    },
    {
      label: t.colorBy,
      layout: "row",
      options: [
        { value: "color:tag", label: t.tag },
        { value: "color:status", label: t.status },
        { value: "color:priority", label: t.priority },
        { value: "color:person", label: t.person },
      ],
    },
  ];
  const priorityOptions: FilterChipSection[] = [
    {
      multiple: true,
      options: [
        { value: "urgent", label: t.urgent, color: "#ef4444" },
        { value: "high", label: t.high, color: "#f97316" },
        { value: "medium", label: t.medium, color: "#eab308" },
        { value: "low", label: t.low, color: "#3b82f6" },
      ],
    },
  ];
  const columnOptions = (): FilterChipSection[] => [
    {
      multiple: true,
      options: props.columns.map((column) => ({ value: column.id, label: column.name, color: column.color ?? undefined })),
    },
  ];
  const navigateRoute = (href: string, options: { replace?: boolean } = {}) => {
    if (props.onRouteChange) return props.onRouteChange(href, options);
    requestSpacesRouteNavigation(href, { ...options, scroll: "preserve" });
  };
  const setFilter = (patch: Partial<CalendarFilter>) => {
    void navigateRoute(
      buildCalendarHref(props.baseUrl, props.view, shownDate(), { ...props.filter, ...patch }, undefined, undefined, props.dateConfig),
      { replace: true },
    );
  };
  // Another color re-colors the same items, so an open item stays open; a filter change starts without one.
  const setColorBy = (colorBy: CalendarColorBy) => {
    const selection = new URL(window.location.href).searchParams;
    const item = selection.get("item") ?? undefined;
    const occurrence = selection.get("occurrence") ?? undefined;
    const target = new URL(
      buildCalendarHref(props.baseUrl, props.view, shownDate(), { ...props.filter, colorBy }, item, occurrence, props.dateConfig),
      window.location.origin,
    );
    const block = selection.get("block");
    if (block) target.searchParams.set("block", block);
    void navigateRoute(`${target.pathname}${target.search}`, { replace: true });
  };
  // The day and week views keep the URL on the day the reader scrolled to, so an item opens on the URL as it stands.
  const selectEvent = (event: CalendarEvent) => {
    const block = blocksById().get(event.id);
    if (block && !block.itemId) {
      void openOrphanTimeBlock(block);
      return;
    }
    if (event.href) requestSpacesDetailNavigation(event.href, { scroll: "preserve" });
  };
  const loadSeriesItem = async (itemId: string) => {
    setSeriesItemSource(itemId);
    await seriesItemQuery.refresh();
    const snapshot = seriesItemQuery.data();
    if (snapshot?.source === itemId && !seriesItemQuery.stale()) return snapshot.item;
    throw seriesItemQuery.error() ?? new Error(t.eventLoadFailed);
  };
  const createItem = async (data: ItemFormData & { recurringEventId?: string; recurrenceId?: string }) => {
    const res = await apiClient[":id"].items.$post({
      param: { id: props.spaceId },
      json: normalizeCreatePayload(data),
    });
    if (!res.ok) throw new Error(await readResponseError(res, t.eventCreateFailed));
  };
  const patchItemTime = async (
    itemId: string,
    data: { startsAt?: string; endsAt?: string; allDay?: boolean; recurrence?: Recurrence | null },
  ) => {
    const res = await apiClient[":id"].items[":itemId"].$patch({
      param: { id: props.spaceId, itemId },
      json: data,
    });
    if (!res.ok) throw new Error(await readResponseError(res, t.eventUpdateFailed));
  };
  const updateRecurringOccurrence = async (
    event: CalendarEvent,
    parent: SpaceItem,
    recurrenceId: string,
    next: CalendarEventTimeChange,
  ) => {
    const time = {
      startsAt: next.start.toISOString(),
      endsAt: next.end.toISOString(),
      allDay: next.allDay ?? false,
    };
    if (event.id !== `${parent.id}:${recurrenceId}`) {
      await patchItemTime(event.id, time);
      return;
    }
    await createItem({
      ...createPayloadFromItem(parent, { ...time, recurrence: null }),
      recurringEventId: parent.id,
      recurrenceId,
    });
  };
  const splitRecurringSeries = async (parent: SpaceItem, recurrenceId: string, next: CalendarEventTimeChange) => {
    if (!parent.recurrence) throw new Error(t.recurringDataMissing);
    const res = await apiClient[":id"].items[":itemId"].recurrence.split.$post({
      param: { id: props.spaceId, itemId: parent.id },
      json: {
        recurrenceId,
        startsAt: next.start.toISOString(),
        endsAt: next.end.toISOString(),
        allDay: next.allDay ?? false,
      },
    });
    if (!res.ok) throw new Error(await readResponseError(res, t.recurringEventUpdateFailed));
  };
  const updateRecurringSeries = async (event: CalendarEvent, parent: SpaceItem, next: CalendarEventTimeChange) => {
    const sourceStart = new Date(event.start);
    const sourceEnd = new Date(event.end ?? event.start);
    if (Number.isNaN(sourceStart.getTime()) || Number.isNaN(sourceEnd.getTime())) throw new Error(t.invalidRecurringTime);
    const startsAt = shiftedIso(parent.startsAt ?? sourceStart.toISOString(), next.start.getTime() - sourceStart.getTime());
    const endsAt = shiftedIso(parent.endsAt ?? sourceEnd.toISOString(), next.end.getTime() - sourceEnd.getTime());
    await patchItemTime(parent.id, {
      startsAt,
      endsAt,
      allDay: next.allDay ?? false,
    });
  };
  const applyRecurringTimeChange = async (
    event: CalendarEvent,
    parent: SpaceItem,
    next: CalendarEventTimeChange,
    scope: RecurringEditScope,
  ) => {
    const recurrenceId = recurrenceIdFromEvent(event);
    if (!recurrenceId) return false;

    if (scope === "occurrence") {
      await updateRecurringOccurrence(event, parent, recurrenceId, next);
      return true;
    }

    if (scope === "future") {
      await splitRecurringSeries(parent, recurrenceId, next);
      return true;
    }

    await updateRecurringSeries(event, parent, next);
    return true;
  };
  /**
   * Where a moved deadline lands: an hour of the day or week view gives it that time; the all-day row makes it a
   * date. A month day keeps a date a date and a timed deadline its time of day on the new date.
   */
  const movedDeadline = (deadline: string, next: CalendarEventTimeChange): string => {
    if (!next.allDay) return next.start.toISOString();
    const day = calendar.formatDateKey(next.start, props.dateConfig);
    if (isDateOnlyDeadline(deadline) || isScrollingCalendarView(props.view)) return day;
    return instantFromLocalDateTime(day, calendar.formatTime(deadline, props.dateConfig), props.dateConfig);
  };
  const updateEventTime = mutations.create<
    boolean,
    {
      event: CalendarEvent;
      sourceItem: CalendarItem | undefined;
      parent: SpaceItem | undefined;
      next: CalendarEventTimeChange;
      recurringScope?: RecurringEditScope;
    },
    { eventId: string }
  >({
    onBefore: ({ event, sourceItem, next }) => {
      const deadline = sourceItem?.deadline && !sourceItem.startsAt ? movedDeadline(sourceItem.deadline, next) : null;
      const optimistic = deadline
        ? isDateOnlyDeadline(deadline)
          ? { start: new Date(allDayStart(deadline, props.dateConfig)), end: new Date(allDayEnd(deadline, props.dateConfig)), allDay: true }
          : { start: new Date(deadline), end: new Date(deadline), allDay: next.allDay ?? false }
        : next;
      setOptimisticTimes({ ...optimisticTimes(), [event.id]: optimistic });
      return { eventId: event.id };
    },
    mutation: async ({ event, sourceItem, parent, next, recurringScope }) => {
      if (sourceItem?.deadline && !sourceItem.startsAt) {
        const itemId = event.dataSpaceItemId ?? event.id;
        const res = await apiClient[":id"].items[":itemId"].$patch({
          param: { id: props.spaceId, itemId },
          json: { deadline: movedDeadline(sourceItem.deadline, next), startsAt: null, endsAt: null, allDay: false },
        });
        if (!res.ok) throw new Error(await readResponseError(res, t.deadlineUpdateFailed));
        return true;
      }
      if (isRecurringCalendarEvent(event)) {
        if (!recurringScope || !parent) return false;
        return applyRecurringTimeChange(event, parent, next, recurringScope);
      }
      // A task planned into a time slot keeps its deadline when its slot moves.
      const itemId = event.dataSpaceItemId ?? event.id;
      const res = await apiClient[":id"].items[":itemId"].$patch({
        param: { id: props.spaceId, itemId },
        json: {
          startsAt: next.start.toISOString(),
          endsAt: next.end.toISOString(),
          allDay: next.allDay ?? false,
        },
      });
      if (!res.ok) throw new Error(await readResponseError(res, t.eventTimeUpdateFailed));
      return true;
    },
    onSuccess: (changed, context) => {
      if (!changed) {
        if (context) clearOptimisticTime(context.eventId);
        return;
      }
      // The event already sits where it was dropped, so the move needs no confirmation.
      reconcileAfterWrite();
    },
    onError: (error, context) => {
      if (context) clearOptimisticTime(context.eventId);
      toast.error(error.message);
      const confirmState = (): void => void invalidateSpacesData().catch(() => retryToast(t.eventStateUnconfirmed, t.retry, confirmState));
      confirmState();
    },
  });
  let updateSubmitting = false;
  const updateTime = async (event: CalendarEvent, next: CalendarEventTimeChange) => {
    if (updateSubmitting || updateEventTime.loading()) return;
    updateSubmitting = true;
    try {
      const block = blocksById().get(event.id);
      if (block) {
        if (!block.canWrite || block.taskState === "deleted") {
          setBlockRetry(undefined);
          setBlockError(bt.ownOnly);
          return;
        }
        const save = async () => {
          setOptimisticTimes({ ...optimisticTimes(), [block.id]: next });
          setBlockError(undefined);
          try {
            await updateTimeBlock(block.id, { startsAt: next.start.toISOString(), endsAt: next.end.toISOString() }, bt.updateFailed);
            setBlockError(undefined);
            reconcileAfterWrite();
          } catch (cause) {
            clearOptimisticTime(block.id);
            setBlockError(cause instanceof Error ? cause.message : String(cause));
            setBlockRetry(() => save);
          }
        };
        await save();
        return;
      }
      if (!props.canWrite) return;
      let recurringScope: RecurringEditScope | undefined;
      let parent: SpaceItem | undefined;
      const sourceItem = props.items.find((item) => item.id === event.id);
      if (isRecurringCalendarEvent(event)) {
        const scope = await chooseRecurringEditScope(t);
        if (!scope) return;
        recurringScope = scope;
        const seriesItemId = sourceItem?.recurringEventId ?? event.dataSpaceItemId ?? event.id;
        parent = await loadSeriesItem(seriesItemId);
      }
      await updateEventTime.mutate({ event, sourceItem, parent, next, recurringScope });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      updateSubmitting = false;
    }
  };
  /** Status and tags a new item takes from the filter, so it shows in the calendar it was created in. */
  const filterDefaults = () => ({
    tagIds: props.filter.tagIds,
    columnId: props.filter.columnIds.length === 1 ? props.filter.columnIds[0] : undefined,
  });
  const announceCreated = (item: SpaceItem) => {
    toast.success(item.startsAt && item.endsAt ? t.eventCreated : t.taskCreated);
    reconcileAfterWrite();
  };
  const openCreateDialog = async (defaults: QuickCreateDefaults) => {
    if (createDialogPending()) return;
    setCreateDialogPending(true);
    const spaceId = props.spaceId;
    try {
      // The dialog stays open until the create answers, so a failure shows in it with the input still there.
      const item = await dialogCore.open<SpaceItem | null>(
        (close) => (
          <ItemForm
            spaceId={spaceId}
            columns={props.columns}
            tags={props.tags}
            templates={props.templates}
            quickCreate
            defaults={{ ...filterDefaults(), ...defaults }}
            onSubmit={async (data) => close(await createSpaceItem(spaceId, data, t.createItemFailed))}
            onCancel={() => close(null)}
            dateConfig={props.dateConfig}
          />
        ),
        itemCreateDialogOptions,
      );
      if (item) announceCreated(item);
    } finally {
      setCreateDialogPending(false);
    }
  };
  const createEventFromSlot = (slot: CalendarEventTimeChange) =>
    openCreateDialog({
      type: "event",
      startsAt: slot.start.toISOString(),
      endsAt: slot.end.toISOString(),
      allDay: slot.allDay ?? false,
    });
  /** The days of a range: an all-day range ends at the midnight after its last day, a time slot on its own end. */
  const daysOf = (range: CalendarEventTimeChange): CalendarDays => ({
    first: calendar.formatDateKey(range.start, props.dateConfig),
    last: calendar.formatDateKey(
      range.allDay === false
        ? new Date(Math.max(range.start.getTime(), range.end.getTime() - 1))
        : calendar.addDays(range.end, -1, props.dateConfig),
      props.dateConfig,
    ),
  });
  /** One selected day gets an event at nine; several get one all-day event over all of them. */
  const createOnDays = (days: CalendarDays) =>
    openCreateDialog(quickCreateDefaults(quickCreateKind(undefined, days), days, props.dateConfig));
  /**
   * The day menu creates through the quick create at the days. Without write access it keeps the calendar's own
   * entries, Open day and Open week.
   */
  const selectionMenu = (_range: CalendarEventTimeChange, controls: CalendarSelectionControls): DropdownItem[] =>
    props.canWrite ? createMenu(controls) : [];
  const createMenu = (controls: CalendarSelectionControls): DropdownItem[] => [
    // New event creates as N and the toolbar do: at nine on one day, all day over several.
    { label: t.newEvent, icon: "ti ti-calendar-plus", action: () => controls.quickCreate() },
    { label: t.newAllDayEvent, icon: "ti ti-sun", action: () => controls.quickCreate("allday" satisfies QuickCreateKind) },
    { label: t.newTaskWithDeadline, icon: "ti ti-square-check", action: () => controls.quickCreate("task" satisfies QuickCreateKind) },
  ];
  const creatingEvent = createDialogPending;
  /**
   * New event creates on the selected days of the month view, else on today while it shows, else on the 1st of the
   * month in view; in the day and week views at the selected slot or day, else today at the next full hour while today
   * shows, else at nine on the first shown day; otherwise at nine on the shown date.
   */
  const createNewEvent = () => {
    const target = isScrollingCalendarView(props.view) || props.view === "month" ? controller()?.createTarget() : undefined;
    if (target && !target.allDay) return createEventFromSlot(target);
    const days = target ? daysOf(target) : null;
    const date = calendar.formatDateKey(props.date, props.dateConfig);
    return createOnDays(days ?? { first: date, last: date });
  };

  /**
   * Checks off a task from the calendar; the reader's own claim goes with it, and someone else's is taken over only
   * after a confirmation, as in the task row. A refused or declined change rejects, so the calendar puts the box back.
   */
  const checkItem = async (event: CalendarEvent, completed: boolean) => {
    const itemId = event.dataSpaceItemId ?? event.id;
    const failed = (error: unknown) => {
      toast.error(error instanceof Error ? error.message : t.updateFailed);
      reconcileAfterWrite();
      return error;
    };
    let previous: SpaceItem;
    try {
      const response = await apiClient[":id"].items[":itemId"].$get({ param: { id: props.spaceId, itemId } });
      if (!response.ok) throw new Error(await readResponseError(response, t.updateFailed));
      previous = await response.json();
    } catch (error) {
      throw failed(error);
    }
    const claim = props.currentUserId ? await resolveCompletionClaim(previous.claim, props.currentUserId, completed, t) : {};
    if (!claim) throw new Error("declined");
    let changed: SpaceItem;
    try {
      changed = await setItemCompleted({ spaceId: props.spaceId, itemId, completed, ...claim }, t.updateFailed);
    } catch (error) {
      throw failed(error);
    }
    // A completed task leaves the calendar with the refresh, so the toast confirms it and offers Undo.
    confirmCompletion({ spaceId: props.spaceId, previous, changed, currentUserId: props.currentUserId }, t);
    reconcileAfterWrite();
  };

  /** A planning gesture creates a block; it never patches task/event fields. */
  const scheduleItem = async (item: SpaceItem, slot: CalendarEventTimeChange) => {
    if (!isAssignedPerson(item, props.currentUserId)) {
      setBlockRetry(undefined);
      setBlockError(bt.assignedFirst);
      requestSpacesDetailNavigation(
        buildCalendarHref(props.baseUrl, props.view, shownDate(), props.filter, item.id, undefined, props.dateConfig),
        { scroll: "preserve" },
      );
      return;
    }
    const intent = { id: crypto.randomUUID(), startsAt: slot.start.toISOString(), endsAt: slot.end.toISOString() };
    let attempted = false;
    const save = async () => {
      try {
        const retry = attempted;
        attempted = true;
        const block = await createTimeBlock(props.spaceId, item.id, intent, bt.createFailed, retry);
        setBlockError(undefined);
        const undo = async () => {
          try {
            await deleteTimeBlock(block.id, bt.deleteFailed);
            setBlockError(undefined);
            reconcileAfterWrite();
          } catch (cause) {
            setBlockError(cause instanceof Error ? cause.message : String(cause));
            setBlockRetry(() => undo);
          }
        };
        toast.success(bt.saved, { action: { label: bt.undo, onClick: () => void undo() } });
        reconcileAfterWrite();
      } catch (cause) {
        setBlockError(bt.failed({ reason: cause instanceof Error ? cause.message : String(cause) }));
        setBlockRetry(() => save);
      }
    };
    await save();
  };

  /** The year view has no quick create, so a task opens in the full dialog on the shown date, as New event does. */
  const createTaskInDialog = () => {
    const day = calendar.formatDateKey(props.date, props.dateConfig);
    return openCreateDialog(quickCreateDefaults("task", { first: day, last: day }, props.dateConfig));
  };
  // The calendar's shortcuts and the two of Spaces, published as commands of this page for the keys, the command
  // palette, and the help; the calendar's shortcuts dialog lists the same ones.
  const spacesCommands = createMemo((): CalendarCommand[] =>
    props.canWrite
      ? [
          {
            id: "spaces.calendar.new-event",
            label: t.newEvent,
            description: t.newEventShortcutDescription,
            shortcut: "n",
            icon: "ti ti-calendar-plus",
            run: () => (props.view === "year" ? void createNewEvent() : controller()?.quickCreate()),
          },
          {
            id: "spaces.calendar.new-task",
            label: t.newTaskWithDeadline,
            description: t.newTaskShortcutDescription,
            shortcut: "shift+n",
            icon: "ti ti-square-check",
            run: () => (props.view === "year" ? void createTaskInDialog() : controller()?.quickCreate("task" satisfies QuickCreateKind)),
          },
        ]
      : [],
  );
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

  return (
    <div class="flex min-h-0 flex-1 flex-col">
      <Show when={blockError()}>
        <div role="alert" class="flex items-center gap-2 text-sm text-danger">
          {blockError()}
          <Show when={blockRetry()}>
            <Button size="sm" variant="ghost" onClick={() => void blockRetry()?.()}>
              {bt.retry}
            </Button>
          </Show>
        </div>
      </Show>
      <CoreCalendar
        class="flex-1"
        view={props.view}
        date={props.date}
        events={events()}
        startHour={8}
        endHour={20}
        dayHours={CALENDAR_DAY_HOURS}
        range={props.range}
        onLoadEarlier={props.onLoadEarlier}
        onLoadLater={props.onLoadLater}
        onVisibleDateChange={(first, last, focus) => {
          setVisibleDays({ first: calendar.formatDateKey(first, props.dateConfig), last: calendar.formatDateKey(last, props.dateConfig) });
          setVisibleDate(focus);
          // Reload and other views open at the scrolling view's focus date.
          const url = new URL(window.location.href);
          const day = calendar.formatDateKey(focus, props.dateConfig);
          if (url.searchParams.get("cd") === day) return;
          url.searchParams.set("cd", day);
          const href = `${url.pathname}${url.search}${url.hash}`;
          if (props.onFollowHref) props.onFollowHref(href);
          else navigate(href, { replace: true, scroll: "manual", viewTransition: false });
        }}
        onEventCheck={props.canWrite ? (event, checked) => checkItem(event, checked) : undefined}
        commands={spacesCommands()}
        onCommandsChange={setCommands}
        controller={setController}
        withWeekNumbers
        dayBadges={dayBadges()}
        dateConfig={props.dateConfig}
        toolbarActions={
          <Show when={props.canWrite}>
            <Button
              type="button"
              variant="input"
              size="sm"
              class="shrink-0 whitespace-nowrap"
              disabled={creatingEvent()}
              onClick={() => void createNewEvent()}
            >
              <i class={`ti ${creatingEvent() ? "ti-loader-2 animate-spin" : "ti-calendar-plus"}`} />
              {/* A phone keeps the icon, so the header holds Today, the views, and this button in one row. */}
              <span class="max-sm:sr-only">{t.newEvent}</span>
            </Button>
          </Show>
        }
        toolbarContent={
          <>
            <FilterChip
              label={t.scope}
              icon="ti ti-filter"
              options={scopeOptions}
              value={[`type:${props.filter.type}`, `assigned:${props.filter.assignedTo}`, `color:${props.filter.colorBy}`]}
              // The color is a display choice, not a filter: Reset keeps it and appears only for a changed filter.
              defaultValue={[
                `type:${defaultCalendarFilter.type}`,
                `assigned:${defaultCalendarFilter.assignedTo}`,
                `color:${props.filter.colorBy}`,
              ]}
              isActive={props.filter.type !== defaultCalendarFilter.type || props.filter.assignedTo !== defaultCalendarFilter.assignedTo}
              onValueChange={(values) => {
                const type = ItemTypeSchema.catch(defaultCalendarFilter.type).parse(
                  values.find((value) => value.startsWith("type:"))?.slice(5),
                );
                const assignedTo = AssignedToFilterSchema.catch(defaultCalendarFilter.assignedTo).parse(
                  values.find((value) => value.startsWith("assigned:"))?.slice(9),
                );
                const colorBy = CalendarColorBySchema.catch(defaultCalendarFilter.colorBy).parse(
                  values.find((value) => value.startsWith("color:"))?.slice(6),
                );
                if (type === props.filter.type && assignedTo === props.filter.assignedTo) setColorBy(colorBy);
                else setFilter({ type, assignedTo, colorBy });
              }}
            />
            <FilterChip
              label={t.priority}
              icon="ti ti-flag"
              options={priorityOptions}
              value={props.filter.priorities}
              onValueChange={(priorities) => setFilter({ priorities: PrioritySchema.array().catch([]).parse(priorities) })}
            />
            <FilterChip
              label={t.status}
              icon="ti ti-layout-kanban"
              options={columnOptions()}
              value={props.filter.columnIds}
              onValueChange={(columnIds) => setFilter({ columnIds })}
            />
            <Show when={props.tags.length > 0}>
              <FilterChip
                label={t.tags}
                icon="ti ti-tag"
                options={tagOptions()}
                value={props.filter.tagIds}
                onValueChange={(tagIds) => setFilter({ tagIds })}
              />
            </Show>
            <span class="ml-auto min-w-[7.5rem] text-right text-xs text-[var(--k2b-text-muted)] tabular-nums whitespace-nowrap max-sm:hidden">
              {t.shownCount({ count: shownCount() })}
            </span>
          </>
        }
        getViewHref={(view) =>
          buildCalendarHref(props.baseUrl, asView(view), shownDate(), props.filter, undefined, undefined, props.dateConfig)
        }
        getDateHref={(date, view) =>
          buildCalendarHref(props.baseUrl, asView(view), date, props.filter, undefined, undefined, props.dateConfig)
        }
        getEventHref={(event) => event.href}
        renderEvent={renderEvent}
        selectedEventId={props.selectedItemId}
        onNavigateHref={props.onNavigateHref}
        onPrefetch={props.onPrefetch}
        navigationPending={props.navigationPending}
        onEventActivate={selectEvent}
        onEventDrop={
          props.canWrite || props.timeBlocks?.some((block) => block.canWrite) ? (event, next) => void updateTime(event, next) : undefined
        }
        onEventResize={
          props.canWrite || props.timeBlocks?.some((block) => block.canWrite) ? (event, next) => void updateTime(event, next) : undefined
        }
        onSlotActivate={
          props.canWrite && !creatingEvent() && (props.view === "day" || props.view === "week")
            ? (slot) => void createEventFromSlot(slot)
            : undefined
        }
        selectionMenu={selectionMenu}
        renderQuickCreate={
          props.canWrite
            ? (range, { create, close }) => (
                <QuickCreate
                  spaceId={props.spaceId}
                  days={daysOf(range)}
                  time={range.allDay ? undefined : { start: range.start.toISOString(), end: range.end.toISOString() }}
                  kind={quickCreateKind(create, daysOf(range))}
                  dateConfig={props.dateConfig}
                  defaults={filterDefaults()}
                  columnId={filterDefaults().columnId ?? props.columns[0]?.id ?? ""}
                  onCreated={(item) => {
                    close();
                    announceCreated(item);
                  }}
                  onMoreOptions={(defaults) => {
                    close();
                    void openCreateDialog(defaults);
                  }}
                />
              )
            : undefined
        }
      />
      {/* A day has no place for overdue and undated tasks, so they wait in a row below it. */}
      <Show when={props.view === "day" && taskTrayFilters(props.filter)}>
        <TaskTray
          spaceId={props.spaceId}
          tray={props.tray ?? null}
          filtered={taskTrayFiltered(props.filter)}
          canCheck={props.canWrite}
          currentUserId={props.currentUserId}
          itemHref={(item) => buildCalendarHref(props.baseUrl, "day", props.date, props.filter, item.id, undefined, props.dateConfig)}
          listHref={(section) => {
            const query = taskTrayFilters(props.filter)?.[section];
            return query ? taskTrayListHref(new URL(props.baseUrl, "http://spaces.local").pathname, query) : undefined;
          }}
          dateConfig={props.dateConfig}
          onSchedulePointerDown={
            props.currentUserId
              ? (event, item) =>
                  controller()?.dragIn(
                    event,
                    {
                      title: item.title,
                      colorHex: calendarItemColors({ ...item, assignees: item.assignees ?? [] }, props.filter.colorBy, props.columns).color,
                      minutes: item.estimatedDurationMinutes ?? 60,
                    },
                    (slot) => void scheduleItem(item, slot),
                  )
              : undefined
          }
        />
      </Show>
    </div>
  );
}
