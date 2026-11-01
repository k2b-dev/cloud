import { type DateContext, dates } from "@k2b/stdlib";
import { Button, Dropdown, type DropdownItem, InlineGuidance, SegmentedControl, TextInput, useLocale } from "@k2b/ui";
import { createMemo, createSignal, Show } from "solid-js";
import type { ItemTemplateKind, SpaceItem, SpaceItemTemplate } from "@/contracts";
import { draftFromTemplate, templateText } from "@/presentation/item-templates";
import { useSpaceMessages } from "../../messages";
import { templateIcon, templateMenuRow } from "../shared/create-menu";
import { createSpaceItem } from "../shared/editItem";
import { allDayEnd, allDayStart, instantFromLocalDateTime } from "../shared/item-form/date";
import { browserTimeZone, templateDraftSource } from "../shared/item-form/templates";
import type { ItemFormData, ItemFormProps } from "../shared/item-form/types";

/** The selected days as `YYYY-MM-DD` keys, both inclusive. */
export type CalendarDays = { first: string; last: string };

export type QuickCreateDefaults = NonNullable<ItemFormProps["defaults"]>;

/** What the quick create makes: a timed event, an all-day event, or a task with a deadline. */
export type QuickCreateKind = "event" | "allday" | "task";

const KINDS: readonly QuickCreateKind[] = ["event", "allday", "task"];

/** The kind a menu entry asked for, or the default for the days: one day gets a timed event, several an all-day one. */
export const quickCreateKind = (create: string | undefined, days: CalendarDays): QuickCreateKind =>
  KINDS.find((kind) => kind === create) ?? (days.first === days.last ? "event" : "allday");

/** A timed event over the days: from 09:00 on the first to 10:00 on one day, or to 17:00 on the last of several. */
export const timedEventDefaults = (days: CalendarDays, dateConfig?: DateContext) => ({
  startsAt: instantFromLocalDateTime(days.first, "09:00", dateConfig),
  endsAt: instantFromLocalDateTime(days.last, days.first === days.last ? "10:00" : "17:00", dateConfig),
});

/** Without a time slot, a task is due all day on the last selected day. */
export const taskDeadline = (days: CalendarDays) => days.last;

/** A time slot of the day or week view, as ISO instants. */
export type CalendarSlot = { start: string; end: string };

/**
 * The item the quick create would make of the days, before its title. A time slot of the day or week view gives an
 * event its times and a task its deadline.
 */
export const quickCreateDefaults = (
  kind: QuickCreateKind,
  days: CalendarDays,
  dateConfig?: DateContext,
  time?: CalendarSlot,
): QuickCreateDefaults => {
  if (kind === "task") return { type: "task", deadline: time?.start ?? taskDeadline(days) };
  if (kind === "allday")
    return { type: "event", allDay: true, startsAt: allDayStart(days.first, dateConfig), endsAt: allDayEnd(days.last, dateConfig) };
  if (time) return { type: "event", allDay: false, startsAt: time.start, endsAt: time.end };
  return { type: "event", allDay: false, ...timedEventDefaults(days, dateConfig) };
};

/**
 * The quick create at the selected days of the month view, or at a time slot of the day and week views: a title,
 * Event, All day, or Task, and a line that says when. Enter creates at once; With details carries everything into the full dialog, where times and the rest change.
 */
export default function QuickCreate(props: {
  spaceId: string;
  days: CalendarDays;
  /** A time slot of the day or week view; without it an event starts at nine. */
  time?: CalendarSlot;
  kind: QuickCreateKind;
  dateConfig?: DateContext;
  /** Status and tags a new item takes from the calendar's filter. */
  defaults: Pick<QuickCreateDefaults, "columnId" | "tagIds">;
  columnId: string;
  /** The Space's templates; "Template" offers those of the chosen kind. */
  templates?: readonly SpaceItemTemplate[];
  /** Opens the template form for "Create template…"; the quick create closes first. */
  onCreateTemplate?: (kind: ItemTemplateKind) => void;
  onCreated: (item: SpaceItem) => void;
  onMoreOptions: (defaults: QuickCreateDefaults) => void;
}) {
  const t = useSpaceMessages();
  const locale = useLocale();
  const [title, setTitle] = createSignal("");
  const [kind, setKind] = createSignal<QuickCreateKind>(props.kind);
  const [template, setTemplate] = createSignal<SpaceItemTemplate>();
  const templateKind = (): ItemTemplateKind => (kind() === "task" ? "task" : "event");
  const kindTemplates = createMemo(() => (props.templates ?? []).filter((candidate) => candidate.kind === templateKind()));
  /** The day a template's placeholders name: the due day of a task, the first day of an event. */
  const templateDay = () => (kind() === "task" ? props.days.last : props.days.first);
  const chooseTemplate = (chosen: SpaceItemTemplate) => {
    setTemplate(chosen);
    setTitle(templateText(chosen, { date: templateDay(), locale: locale() }).title);
    setError("");
  };
  /** A template belongs to one kind, so switching the kind leaves it; the typed title stays. */
  const changeKind = (next: QuickCreateKind) => {
    setKind(next);
    if (template() && template()!.kind !== templateKind()) setTemplate(undefined);
  };
  /** What the chosen template adds beyond its title, and that the selection decides when. */
  const fromTemplate = () => {
    const chosen = template();
    if (!chosen) return "";
    const parts =
      chosen.kind === "task"
        ? [
            chosen.tags[0]?.name,
            chosen.checklist.length ? t.templateHintChecklist({ count: chosen.checklist.length }) : undefined,
            chosen.assignees[0]?.displayName,
            t.quickCreateDueFromSelection,
          ]
        : [chosen.location ? t.templateHintPlace({ place: chosen.location }) : undefined, t.quickCreateTimeFromSelection];
    return parts.filter(Boolean).join(" · ");
  };
  const templateItems = (): DropdownItem[] => [
    ...kindTemplates().map((candidate) => templateMenuRow(candidate, t, locale(), chooseTemplate)),
    ...(props.onCreateTemplate
      ? [
          {
            label: t.createMenuCreateTemplate,
            icon: "ti ti-template",
            description: kindTemplates().length
              ? undefined
              : kind() === "task"
                ? t.quickCreateNoTaskTemplates
                : t.quickCreateNoEventTemplates,
            action: () => props.onCreateTemplate?.(templateKind()),
          },
        ]
      : []),
  ];
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
    const values = quickCreateDefaults(kind(), props.days, props.dateConfig, props.time);
    // A task without a time slot is due all day, so its line names the day alone.
    if (kind() === "task")
      return t.quickCreateDue({
        date: props.time ? `${day(props.days.last)}, ${time(values.deadline ?? "")}` : day(props.days.last),
      });
    const range = props.days.first === props.days.last ? day(props.days.first) : `${day(props.days.first)} – ${day(props.days.last)}`;
    if (kind() === "allday") return t.quickCreateAllDay({ range });
    if (props.days.first === props.days.last) return `${range} · ${time(values.startsAt ?? "")}–${time(values.endsAt ?? "")}`;
    return `${day(props.days.first)}, ${time(values.startsAt ?? "")} – ${day(props.days.last)}, ${time(values.endsAt ?? "")}`;
  };

  const formDefaults = (): QuickCreateDefaults & { templateId?: string } => ({
    ...props.defaults,
    ...quickCreateDefaults(kind(), props.days, props.dateConfig, props.time),
    title: title().trim() || undefined,
    templateId: template()?.id,
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
    // The template fills in the rest; the selection keeps the date, the time, and the length.
    const chosen = template();
    if (chosen) {
      const draft = draftFromTemplate(templateDraftSource(chosen), {
        date: null,
        timeZone: props.dateConfig?.timeZone ?? browserTimeZone(),
        locale: locale(),
        now: new Date(`${templateDay()}T12:00:00Z`),
      });
      const tagIds = [...new Set([...(data.tagIds ?? []), ...draft.tagIds])];
      Object.assign(data, {
        description: draft.description,
        priority: draft.priority,
        tagIds: tagIds.length ? tagIds : undefined,
        assigneeIds: draft.assigneeIds.length ? draft.assigneeIds : undefined,
        ...(draft.assignCreator ? { assignCreator: true } : {}),
        ...(defaults.type === "task"
          ? { checklist: draft.checklist.length ? draft.checklist : undefined, estimatedDurationMinutes: draft.estimatedDurationMinutes }
          : { location: draft.location, url: draft.url }),
      } satisfies Partial<ItemFormData>);
    }
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
          onValueChange={changeKind}
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
      {/* Always one line high, so choosing a template moves nothing. */}
      <p class="min-h-[1.125rem] truncate text-xs text-[var(--k2b-text-secondary)]" data-spaces-quick-create-from="" aria-live="polite">
        {fromTemplate()}
      </p>
      <div class="mt-0.5 flex items-center gap-1">
        <Show when={kindTemplates().length || props.onCreateTemplate} fallback={<span class="mr-auto" />}>
          <span class="mr-auto">
            <Dropdown.Root
              items={templateItems()}
              label={
                kind() === "task"
                  ? t.quickCreateTaskTemplateFor({ day: day(templateDay()) })
                  : t.quickCreateEventTemplateFor({ day: day(templateDay()) })
              }
              icons="tile"
              phone="sheet"
              width="18rem"
              note={t.quickCreateTemplateHint}
              sheetTop={() => (
                <p class="px-3 pb-1 text-[0.9375rem] font-semibold">
                  {kind() === "task"
                    ? t.quickCreateTaskTemplateFor({ day: day(templateDay()) })
                    : t.quickCreateEventTemplateFor({ day: day(templateDay()) })}
                </p>
              )}
            >
              {/* A fixed width: the chosen template's name truncates instead of moving the buttons beside it. */}
              <Dropdown.Trigger variant="secondary" size="sm" class="w-[9.5rem] [&_.k2b-button__label]:min-w-0">
                <i class={template() ? templateIcon(template()!) : "ti ti-template"} aria-hidden="true" />
                <span class="min-w-0 flex-1 truncate text-left">{template()?.name ?? t.quickCreateTemplate}</span>
                <i class="ti ti-chevron-down text-xs opacity-70" aria-hidden="true" />
              </Dropdown.Trigger>
            </Dropdown.Root>
          </span>
        </Show>
        {/* While a save runs, the full form would create the same item a second time. */}
        <Button type="button" variant="ghost" size="sm" disabled={submitting()} onClick={() => props.onMoreOptions(formDefaults())}>
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
