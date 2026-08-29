import type { DateContext } from "@k2b/stdlib";
import { dates as calendar } from "@k2b/stdlib";
import { mutation as mutations, query } from "@k2b/stdlib/solid";
import {
  Button,
  type CalendarEvent,
  type CalendarEventTimeChange,
  Calendar as CoreCalendar,
  dialogCore,
  FilterChip,
  type FilterChipSection,
  PanelDialog,
  panelDialogOptions,
  prompts,
  toast,
} from "@k2b/ui";
import { createEffect, createSignal, Show } from "solid-js";
import { apiClient } from "@/api/client";
import { AssignedToFilterSchema, type CalendarItem, ItemTypeSchema, PrioritySchema, type Recurrence, type SpaceItem } from "@/contracts";
import { readResponseError } from "../../../lib/response";
import { spaceMessages, useSpaceMessages } from "../../messages";
import ItemForm, { type ItemFormData } from "../shared/ItemForm";
import { itemCreateDialogOptions } from "../shared/item-form/dialog";
import { invalidateSpacesData, requestSpacesRouteNavigation } from "../workspace/workspace-events";
import { type CalendarFilter, defaultCalendarFilter, writeCalendarFilter } from "./filter";
import type { CalendarProps, CalendarView } from "./types";

const eventStart = (item: CalendarItem) => item.startsAt ?? item.deadline ?? calendar.today().toISOString();
const eventEnd = (item: CalendarItem) => item.endsAt ?? item.deadline ?? eventStart(item);

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

const priorityColor = (item: CalendarItem) => {
  if (!item.deadline || item.startsAt) return undefined;
  if (item.priority === "urgent" || item.priority === "high") return "red";
  return "amber";
};

const toCalendarEvent = (
  item: CalendarItem,
  baseUrl: string,
  view: CalendarView,
  date: Date,
  filter: CalendarFilter,
  dateConfig?: DateContext,
): CalendarEvent => {
  const { t } = spaceMessages.resolve(dateConfig?.locale ? [dateConfig.locale] : []);
  const isDeadline = Boolean(item.deadline && !item.startsAt);
  const detailItemId = item.isRecurringInstance ? (item.recurringEventId ?? item.id) : item.id;
  const occurrenceId = item.recurrenceId ?? undefined;
  return {
    id: item.id,
    title: item.title,
    description: item.descriptionPreview ?? undefined,
    start: eventStart(item),
    end: eventEnd(item),
    allDay: item.allDay || !item.startsAt,
    color: priorityColor(item),
    colorHex: isDeadline ? undefined : (item.tags?.[0]?.color ?? "#0ea5e9"),
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
                <i class="ti ti-chevron-right shrink-0 text-sm text-dimmed opacity-50 transition-[opacity,transform] group-hover:translate-x-0.5 group-hover:opacity-100 group-focus-visible:opacity-100" />
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
  const [optimisticTimes, setOptimisticTimes] = createSignal<Record<string, CalendarEventTimeChange>>({});
  const [createDialogPending, setCreateDialogPending] = createSignal(false);
  const [seriesItemSource, setSeriesItemSource] = createSignal<string | null>(null);
  const reconcileAfterWrite = () => void invalidateSpacesData().catch(() => prompts.error(t.calendarRefreshFailed));
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
  const events = () =>
    props.items.map((item) => {
      const event = toCalendarEvent(item, props.baseUrl, props.view, props.date, props.filter, props.dateConfig);
      const optimistic = optimisticTimes()[item.id];
      return optimistic ? { ...event, start: optimistic.start, end: optimistic.end, allDay: optimistic.allDay } : event;
    });
  const clearOptimisticTime = (eventId: string) => {
    const current = optimisticTimes();
    if (!(eventId in current)) return;
    const next = { ...current };
    delete next[eventId];
    setOptimisticTimes(next);
  };
  let previousItems = props.items;
  createEffect(() => {
    const items = props.items;
    const itemsChanged = items !== previousItems;
    previousItems = items;
    const current = optimisticTimes();
    if (!itemsChanged) return;
    const settled = Object.entries(current).filter(([eventId, optimistic]) => {
      const item = items.find((candidate) => candidate.id === eventId);
      return (
        !item ||
        (new Date(eventStart(item)).getTime() === optimistic.start.getTime() &&
          new Date(eventEnd(item)).getTime() === optimistic.end.getTime() &&
          Boolean(item.allDay) === Boolean(optimistic.allDay))
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
      buildCalendarHref(props.baseUrl, props.view, props.date, { ...props.filter, ...patch }, undefined, undefined, props.dateConfig),
      { replace: true },
    );
  };
  const selectEvent = (event: CalendarEvent) => {
    if (event.href) requestSpacesRouteNavigation(event.href, { scroll: "preserve" });
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
  const updateEventTime = mutations.create<
    boolean,
    {
      event: CalendarEvent;
      sourceItem: CalendarItem | undefined;
      parent: SpaceItem | undefined;
      next: CalendarEventTimeChange;
      action: "move" | "resize";
      recurringScope?: RecurringEditScope;
    },
    { eventId: string; next: CalendarEventTimeChange; action: "move" | "resize" }
  >({
    onBefore: ({ event, sourceItem, next, action }) => {
      const optimistic = sourceItem?.deadline && !sourceItem.startsAt ? { ...next, end: next.start, allDay: true } : next;
      setOptimisticTimes({ ...optimisticTimes(), [event.id]: optimistic });
      return { eventId: event.id, next, action };
    },
    mutation: async ({ event, sourceItem, parent, next, recurringScope }) => {
      if (sourceItem?.deadline && !sourceItem.startsAt) {
        const itemId = event.dataSpaceItemId ?? event.id;
        const res = await apiClient[":id"].items[":itemId"].$patch({
          param: { id: props.spaceId, itemId },
          json: { deadline: next.start.toISOString(), startsAt: null, endsAt: null, allDay: true },
        });
        if (!res.ok) throw new Error(await readResponseError(res, t.deadlineUpdateFailed));
        return true;
      }
      if (isRecurringCalendarEvent(event)) {
        if (!recurringScope || !parent) return false;
        return applyRecurringTimeChange(event, parent, next, recurringScope);
      }
      const itemId = event.dataSpaceItemId ?? event.id;
      const res = await apiClient[":id"].items[":itemId"].$patch({
        param: { id: props.spaceId, itemId },
        json: {
          startsAt: next.start.toISOString(),
          endsAt: next.end.toISOString(),
          deadline: null,
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
      if (!context) {
        reconcileAfterWrite();
        return;
      }
      const target = context.next.allDay
        ? context.next.start.toLocaleDateString(props.dateConfig?.locale ?? "en", {
            weekday: "short",
            month: "short",
            day: "numeric",
            timeZone: props.dateConfig?.timeZone,
          })
        : context.next.start.toLocaleTimeString(props.dateConfig?.locale ?? "en", {
            hour: "2-digit",
            minute: "2-digit",
            timeZone: props.dateConfig?.timeZone,
          });
      toast.success(context.action === "resize" ? t.eventDurationUpdated : t.eventMoved({ target }));
      reconcileAfterWrite();
    },
    onError: (error, context) => {
      if (context) clearOptimisticTime(context.eventId);
      prompts.error(error.message);
      void invalidateSpacesData().catch(() => prompts.error(t.eventStateUnconfirmed));
    },
  });
  let updateSubmitting = false;
  const updateTime = async (event: CalendarEvent, next: CalendarEventTimeChange, action: "move" | "resize") => {
    if (updateSubmitting || updateEventTime.loading()) return;
    updateSubmitting = true;
    try {
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
      await updateEventTime.mutate({ event, sourceItem, parent, next, action, recurringScope });
    } catch (error) {
      prompts.error(error instanceof Error ? error.message : String(error));
    } finally {
      updateSubmitting = false;
    }
  };
  const createEvent = mutations.create<SpaceItem, ItemFormData>({
    mutation: async (intent) => {
      const res = await apiClient[":id"].items.$post({
        param: { id: props.spaceId },
        json: { ...normalizeCreatePayload(intent) },
      });
      if (!res.ok) throw new Error(await readResponseError(res, t.createItemFailed));
      return res.json();
    },
    onSuccess: (item) => {
      toast.success(item.startsAt && item.endsAt ? t.eventCreated : t.taskCreated);
      reconcileAfterWrite();
    },
    onError: (error) => prompts.error(error.message),
  });
  const createEventFromSlot = async (slot: CalendarEventTimeChange) => {
    if (createDialogPending() || createEvent.loading()) return;
    setCreateDialogPending(true);
    try {
      const intent = await dialogCore.open<ItemFormData | null>(
        (close) => (
          <ItemForm
            spaceId={props.spaceId}
            columns={props.columns}
            tags={props.tags}
            quickCreate
            defaults={{
              type: "event",
              startsAt: slot.start.toISOString(),
              endsAt: slot.end.toISOString(),
              allDay: slot.allDay ?? false,
              tagIds: props.filter.tagIds,
              columnId: props.filter.columnIds.length === 1 ? props.filter.columnIds[0] : undefined,
            }}
            onSubmit={(data) => close(data)}
            onCancel={() => close(null)}
            dateConfig={props.dateConfig}
          />
        ),
        itemCreateDialogOptions,
      );
      if (intent) void createEvent.mutate(intent);
    } finally {
      setCreateDialogPending(false);
    }
  };
  const creatingEvent = () => createDialogPending() || createEvent.loading();
  const defaultNewEventSlot = (): CalendarEventTimeChange => {
    const dateKey = calendar.formatDateKey(props.date, props.dateConfig);
    const start = props.dateConfig?.timeZone
      ? new Date(calendar.zonedDateTimeToInstant(`${dateKey}T09:00`, props.dateConfig.timeZone, { disambiguation: "compatible" }))
      : new Date(`${dateKey}T09:00:00`);
    const end = new Date(start.getTime() + 60 * 60 * 1000);
    return { start, end, allDay: false };
  };

  return (
    <div class="flex min-h-0 flex-1 flex-col">
      <CoreCalendar
        class="flex-1"
        view={props.view}
        date={props.date}
        events={events()}
        startHour={8}
        endHour={20}
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
              onClick={() => void createEventFromSlot(defaultNewEventSlot())}
            >
              <i class={`ti ${creatingEvent() ? "ti-loader-2 animate-spin" : "ti-calendar-plus"}`} />
              {t.newEvent}
            </Button>
          </Show>
        }
        toolbarContent={
          <div class="no-scrollbar flex shrink-0 items-center gap-2 overflow-x-auto border-b border-zinc-100 bg-zinc-50/65 px-2 py-2 dark:border-zinc-800/70 dark:bg-zinc-950/35">
            <FilterChip
              label={t.scope}
              icon="ti ti-filter"
              options={scopeOptions}
              value={[`type:${props.filter.type}`, `assigned:${props.filter.assignedTo}`]}
              defaultValue={[`type:${defaultCalendarFilter.type}`, `assigned:${defaultCalendarFilter.assignedTo}`]}
              isActive={props.filter.type !== defaultCalendarFilter.type || props.filter.assignedTo !== defaultCalendarFilter.assignedTo}
              onValueChange={(values) => {
                const type = values.find((value) => value.startsWith("type:"))?.slice(5);
                const assignedTo = values.find((value) => value.startsWith("assigned:"))?.slice(9);
                setFilter({
                  type: ItemTypeSchema.catch(defaultCalendarFilter.type).parse(type),
                  assignedTo: AssignedToFilterSchema.catch(defaultCalendarFilter.assignedTo).parse(assignedTo),
                });
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
            <span class="ml-auto inline-flex min-w-16 shrink-0 items-center justify-end gap-1 text-xs text-dimmed">
              <Show when={props.navigationPending} fallback={t.shownCount({ count: props.items.length })}>
                <i class="ti ti-loader-2 animate-spin" aria-hidden="true" />
                {t.updating}
              </Show>
            </span>
          </div>
        }
        getViewHref={(view) =>
          buildCalendarHref(props.baseUrl, view as CalendarView, props.date, props.filter, undefined, undefined, props.dateConfig)
        }
        getDateHref={(date, view) =>
          buildCalendarHref(props.baseUrl, view as CalendarView, date, props.filter, undefined, undefined, props.dateConfig)
        }
        getEventHref={(event) => event.href}
        selectedEventId={props.selectedItemId}
        onNavigateHref={props.onNavigateHref}
        onPrefetch={props.onPrefetch}
        navigationPending={props.navigationPending}
        onEventActivate={selectEvent}
        onEventDrop={props.canWrite && !updateEventTime.loading() ? (event, next) => void updateTime(event, next, "move") : undefined}
        onEventResize={props.canWrite && !updateEventTime.loading() ? (event, next) => void updateTime(event, next, "resize") : undefined}
        onSlotActivate={
          props.canWrite && !creatingEvent() && (props.view === "day" || props.view === "week")
            ? (slot) => void createEventFromSlot(slot)
            : undefined
        }
      />
    </div>
  );
}
