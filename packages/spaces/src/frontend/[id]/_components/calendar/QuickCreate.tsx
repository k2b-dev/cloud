import { type DateContext, dates } from "@k2b/stdlib";
import { Button, InlineGuidance, SegmentedControl, TextInput } from "@k2b/ui";
import { createSignal, Show } from "solid-js";
import type { SpaceItem } from "@/contracts";
import { useSpaceMessages } from "../../messages";
import { createSpaceItem } from "../shared/editItem";
import { allDayEnd, allDayStart, instantFromLocalDateTime } from "../shared/item-form/date";
import type { ItemFormData, ItemFormProps } from "../shared/item-form/types";

/** The selected days as `YYYY-MM-DD` keys, both inclusive. */
export type CalendarDays = { first: string; last: string };

export type QuickCreateDefaults = NonNullable<ItemFormProps["defaults"]>;

/** What the quick create makes: a timed event, an all-day event, or a task with a deadline. */
export type QuickCreateKind = "event" | "allday" | "task";

const KINDS: readonly QuickCreateKind[] = ["event", "allday", "task"];

const KBD =
  "inline-grid h-5 min-w-5 place-items-center rounded-[0.3125rem] bg-[var(--k2b-surface-muted)] px-1 font-sans text-[0.6875rem] font-medium shadow-[inset_0_-1px_0_var(--k2b-border)]";

/** The kind a menu entry asked for, or the default for the days: one day gets a timed event, several an all-day one. */
export const quickCreateKind = (create: string | undefined, days: CalendarDays): QuickCreateKind =>
  KINDS.find((kind) => kind === create) ?? (days.first === days.last ? "event" : "allday");

/** A timed event over the days: from 09:00 on the first to 10:00 on one day, or to 17:00 on the last of several. */
export const timedEventDefaults = (days: CalendarDays, dateConfig?: DateContext) => ({
  startsAt: instantFromLocalDateTime(days.first, "09:00", dateConfig),
  endsAt: instantFromLocalDateTime(days.last, days.first === days.last ? "10:00" : "17:00", dateConfig),
});

/** A task is due at the end of the last day's working hours, as the deadline presets are. */
export const taskDeadline = (days: CalendarDays, dateConfig?: DateContext) => instantFromLocalDateTime(days.last, "17:00", dateConfig);

/** The item the quick create would make of the days, before its title. */
export const quickCreateDefaults = (kind: QuickCreateKind, days: CalendarDays, dateConfig?: DateContext): QuickCreateDefaults => {
  if (kind === "task") return { type: "task", deadline: taskDeadline(days, dateConfig) };
  if (kind === "allday")
    return { type: "event", allDay: true, startsAt: allDayStart(days.first, dateConfig), endsAt: allDayEnd(days.last, dateConfig) };
  return { type: "event", allDay: false, ...timedEventDefaults(days, dateConfig) };
};

/**
 * The quick create at the selected days of the month view: a title, Event, All day, or Task, and a line that says
 * when. Enter creates at once; With details carries everything into the full dialog, where times and the rest change.
 */
export default function QuickCreate(props: {
  spaceId: string;
  days: CalendarDays;
  kind: QuickCreateKind;
  dateConfig?: DateContext;
  /** Status and tags a new item takes from the calendar's filter. */
  defaults: Pick<QuickCreateDefaults, "columnId" | "tagIds">;
  columnId: string;
  onCreated: (item: SpaceItem) => void;
  onMoreOptions: (defaults: QuickCreateDefaults) => void;
}) {
  const t = useSpaceMessages();
  const [title, setTitle] = createSignal("");
  const [kind, setKind] = createSignal<QuickCreateKind>(props.kind);
  const [error, setError] = createSignal("");
  const [submitting, setSubmitting] = createSignal(false);

  const context = () => ({ weekStartsOn: 1 as const, ...props.dateConfig });
  /** A short day such as "Wed, Oct 14", or "Mi 14. Okt" in German without the abbreviation dots. */
  const day = (key: string) => {
    const locale = props.dateConfig?.locale ?? "en";
    const format = new Intl.DateTimeFormat(locale, {
      weekday: "short",
      day: "numeric",
      month: "short",
      timeZone: props.dateConfig?.timeZone,
    });
    const date = dates.parseCalendarDate(key, context());
    if (!locale.startsWith("de")) return format.format(date);
    const part = (type: Intl.DateTimeFormatPartTypes) =>
      format
        .formatToParts(date)
        .find((entry) => entry.type === type)
        ?.value.replace(/\.$/, "") ?? "";
    return `${part("weekday")} ${part("day")}. ${part("month")}`;
  };
  const time = (value: string) => dates.formatTime(new Date(value), context());
  /** When the item would be, as one short line. */
  const when = () => {
    const values = quickCreateDefaults(kind(), props.days, props.dateConfig);
    if (kind() === "task") return t.quickCreateDue({ date: `${day(props.days.last)}, ${time(values.deadline ?? "")}` });
    const range = props.days.first === props.days.last ? day(props.days.first) : `${day(props.days.first)} – ${day(props.days.last)}`;
    if (kind() === "allday") return t.quickCreateAllDay({ range });
    if (props.days.first === props.days.last) return `${range} · ${time(values.startsAt ?? "")}–${time(values.endsAt ?? "")}`;
    return `${day(props.days.first)}, ${time(values.startsAt ?? "")} – ${day(props.days.last)}, ${time(values.endsAt ?? "")}`;
  };

  const formDefaults = (): QuickCreateDefaults => ({
    ...props.defaults,
    ...quickCreateDefaults(kind(), props.days, props.dateConfig),
    title: title().trim() || undefined,
  });

  const submit = async () => {
    if (submitting()) return;
    setError("");
    const defaults = formDefaults();
    if (!defaults.title) {
      setError(t.titleRequired);
      return;
    }
    const data: ItemFormData = {
      columnId: defaults.columnId ?? props.columnId,
      title: defaults.title,
      startsAt: defaults.type === "event" ? defaults.startsAt : undefined,
      endsAt: defaults.type === "event" ? defaults.endsAt : undefined,
      allDay: defaults.type === "event" ? Boolean(defaults.allDay) : false,
      deadline: defaults.type === "task" ? defaults.deadline : undefined,
      tagIds: defaults.tagIds?.length ? defaults.tagIds : undefined,
    };
    setSubmitting(true);
    try {
      props.onCreated(await createSpaceItem(props.spaceId, data, t.createItemFailed));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form
      class="flex flex-col gap-2"
      data-spaces-quick-create
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <TextInput
        aria-label={t.title}
        placeholder={t.quickCreatePlaceholder}
        value={title}
        onValueChange={setTitle}
        onSubmit={() => void submit()}
      />
      {/* The choice keeps its natural width, so the line beside it says when. */}
      <div class="flex min-w-0 items-center gap-2.5 [&_.k2b-segmented-control]:w-auto! [&_.k2b-segmented-control]:shrink-0! [&_.k2b-segmented-control__option]:flex-none! [&_.k2b-segmented-control__option]:px-2! [&_.k2b-segmented-control__option]:whitespace-nowrap!">
        <SegmentedControl<QuickCreateKind>
          ariaLabel={t.type}
          size="sm"
          value={kind}
          onValueChange={setKind}
          options={[
            { value: "event", label: t.event },
            { value: "allday", label: t.allDay },
            { value: "task", label: t.task },
          ]}
        />
        <span class="min-w-0 truncate text-xs text-[var(--k2b-text-secondary)]" data-spaces-quick-create-when="">
          {when()}
        </span>
      </div>
      <Show when={error()}>
        <InlineGuidance tone="danger" icon="ti ti-alert-circle" role="alert">
          {error()}
        </InlineGuidance>
      </Show>
      <div class="mt-0.5 flex items-center gap-1">
        {/* Keys help only where a keyboard is likely. */}
        <span class="mr-auto text-[0.6875rem] text-[var(--k2b-text-muted)] pointer-coarse:invisible" aria-hidden="true">
          <kbd class={KBD}>↵</kbd> {t.quickCreateEnter} · <kbd class={KBD}>Esc</kbd> {t.quickCreateEscape}
        </span>
        <Button type="button" variant="ghost" size="sm" onClick={() => props.onMoreOptions(formDefaults())}>
          {t.withDetails}
        </Button>
        <Button type="submit" variant="primary" size="sm" disabled={submitting()}>
          <Show when={submitting()}>
            <i class="ti ti-loader-2 animate-spin" aria-hidden="true" />
          </Show>
          {kind() === "task" ? t.quickCreateTask : t.quickCreateSubmit}
        </Button>
      </div>
    </form>
  );
}
