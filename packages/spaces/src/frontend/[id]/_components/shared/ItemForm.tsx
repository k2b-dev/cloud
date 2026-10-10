import {
  Button,
  CheckboxCard,
  ChoiceChips,
  DatePicker,
  DateRangePicker,
  type DateRangeValue,
  DateTimePicker,
  MultiSelectInput,
  NumberInput,
  PanelDialog,
  prompts,
  SegmentedControl,
  Select,
  Switch,
  TextInput,
  useLocale,
} from "@k2b/ui";
import { createMemo, createSignal, For, Show } from "solid-js";
import type { SpaceItemAssignee } from "@/contracts";
import {
  defaultTemplateDate,
  describeTemplateDateRule,
  draftFromTemplate,
  formatTemplateDate,
  localNow,
  proposeTemplateDates,
  templateSchedule,
  templateText,
} from "@/presentation/item-templates";
import {
  emptyRecurrenceState,
  type RecurrenceEndMode,
  type RecurrenceFrequency,
  recurrenceEndOptions,
  recurrenceFrequencyOptions,
  recurrenceFromFormState,
  recurrenceToFormState,
  summarizeRecurrenceState,
  weekdayOptions,
} from "@/presentation/recurrence";
import { spaceCommandMessages } from "../../../../commands";
import { useSpaceMessages } from "../../messages";
import {
  allDayEnd,
  allDayStart,
  dateOnlyRange,
  datePart,
  deadlinePresets,
  EVENT_DURATION_PRESETS,
  instantFromLocalDateTime,
  scheduleDatePresets,
} from "./item-form/date";
import { priorityOptions } from "./item-form/options";
import { BLANK_TEMPLATE, browserTimeZone, MAX_TEMPLATE_CHIPS, NO_DATE, OTHER_DATE, templateDraftSource } from "./item-form/templates";
import type { ItemFormData, ItemFormProps, ItemType, Priority } from "./item-form/types";
import SpaceAssigneePicker from "./SpaceAssigneePicker";

export type { ItemFormData } from "./item-form/types";

/**
 * Unified form for creating and editing items.
 * - Create mode: item is undefined, shows type selector and tags
 * - Edit mode: item is provided, type is fixed based on existing data
 */
export default function ItemForm(props: ItemFormProps) {
  const t = useSpaceMessages();
  const locale = useLocale();
  const commandMessages = () => spaceCommandMessages.resolve([locale()]).t;
  const [references, setReferences] = createSignal(props.defaults?.references ?? []);
  const isEditMode = () => !!props.item;
  const initialIsEvent = () => Boolean(props.item?.startsAt && props.item?.endsAt);
  const dateTimeInitial = (value?: string | null) => (props.dateConfig?.timeZone ? (value ?? "") : (value?.slice(0, 16) ?? ""));

  // Form state
  const [title, setTitle] = createSignal(props.item?.title ?? props.defaults?.title ?? "");
  const [description, setDescription] = createSignal(props.item?.description ?? "");
  const [location, setLocation] = createSignal(props.item?.location ?? "");
  const [url, setUrl] = createSignal(props.item?.url ?? "");
  const [columnId, setColumnId] = createSignal(props.item?.columnId ?? props.defaults?.columnId ?? props.columns[0]?.id ?? "");
  const [itemType, setItemType] = createSignal<ItemType>(
    initialIsEvent() ? "event" : isEditMode() ? "task" : (props.defaults?.type ?? "task"),
  );
  const [deadline, setDeadline] = createSignal(dateTimeInitial(props.item?.deadline ?? props.defaults?.deadline));
  const [estimatedDurationMinutes, setEstimatedDurationMinutes] = createSignal<number | null>(
    props.item?.estimatedDurationMinutes ?? props.defaults?.estimatedDurationMinutes ?? null,
  );
  const [startsAt, setStartsAt] = createSignal(dateTimeInitial(props.item?.startsAt ?? props.defaults?.startsAt));
  const [endsAt, setEndsAt] = createSignal(dateTimeInitial(props.item?.endsAt ?? props.defaults?.endsAt));
  const [allDay, setAllDay] = createSignal(props.item?.allDay ?? props.defaults?.allDay ?? false);
  const initialRecurrence = recurrenceToFormState(props.item?.recurrence ?? props.defaults?.recurrence, props.dateConfig);
  const [recurrenceEnabled, setRecurrenceEnabled] = createSignal(initialRecurrence.preset !== "never");
  const [recurrenceFrequency, setRecurrenceFrequency] = createSignal<RecurrenceFrequency>(initialRecurrence.frequency);
  const [recurrenceInterval, setRecurrenceInterval] = createSignal<number | null>(initialRecurrence.interval);
  const [recurrenceByDay, setRecurrenceByDay] = createSignal<string[]>(initialRecurrence.byDay);
  const [recurrenceEndMode, setRecurrenceEndMode] = createSignal<RecurrenceEndMode>(initialRecurrence.endMode);
  const [recurrenceUntil, setRecurrenceUntil] = createSignal(initialRecurrence.until);
  const [recurrenceCount, setRecurrenceCount] = createSignal<number | null>(initialRecurrence.count);
  const [priority, setPriority] = createSignal(props.item?.priority ?? props.defaults?.priority ?? "");
  const [assignees, setAssignees] = createSignal<SpaceItemAssignee[]>(props.item?.assignees ?? []);
  const [selectedTags, setSelectedTags] = createSignal<string[]>(props.item?.tags?.map((t) => t.id) ?? props.defaults?.tagIds ?? []);
  const [error, setError] = createSignal("");
  const [submitting, setSubmitting] = createSignal(false);
  const [showFullEditor, setShowFullEditor] = createSignal(!props.quickCreate || isEditMode());
  const [checklist, setChecklist] = createSignal<string[]>(props.defaults?.checklist ?? []);
  const [assignCreator, setAssignCreator] = createSignal(props.defaults?.assignCreator ?? false);

  // ---------- Templates (create only) ----------
  const timeZone = () => props.dateConfig?.timeZone ?? browserTimeZone();
  const kindTemplates = createMemo(() => (isEditMode() ? [] : (props.templates ?? []).filter((template) => template.kind === itemType())));
  const [templateId, setTemplateId] = createSignal(BLANK_TEMPLATE);
  const selectedTemplate = () => kindTemplates().find((template) => template.id === templateId());
  const proposals = createMemo(() => {
    const template = selectedTemplate();
    return template ? proposeTemplateDates(template, { now: new Date(), timeZone: timeZone() }) : [];
  });
  /** The date chip in effect: a proposed `YYYY-MM-DD`, OTHER_DATE, NO_DATE, or null after the event picker moved. */
  const [dateChoice, setDateChoice] = createSignal<string | null>(null);
  /**
   * Title and description as the template filled them; anything else counts as the person's own input, including a
   * title the quick create passed on.
   */
  let applied = { title: props.defaults?.title ? "" : title(), description: description() };
  const ownInput = () => title().trim() !== applied.title.trim() || description().trim() !== applied.description.trim();

  const applySchedule = (date: string | null) => {
    const template = selectedTemplate();
    if (!template) return;
    const schedule = templateSchedule(templateDraftSource(template), date, timeZone());
    if (template.kind === "task") {
      setDeadline(schedule.deadline ?? "");
      return;
    }
    if (!date) return;
    setAllDay(template.allDay);
    setStartsAt(schedule.startsAt ?? "");
    setEndsAt(schedule.endsAt ?? "");
  };

  /** Fills the template's text for `date`; null means the event's day, or today for a task without a date. */
  const fillText = (date: string | null) => {
    const template = selectedTemplate();
    if (!template) return;
    const eventDay = template.kind === "event" && startsAt() ? datePart(startsAt(), props.dateConfig) : null;
    const text = templateText(template, { date: date ?? eventDay ?? localNow(new Date(), timeZone()).date, locale: locale() });
    setTitle(text.title);
    setDescription(text.description);
    applied = text;
  };
  /** Untouched placeholders follow every date change, from a chip or from a picker. */
  const followDate = (date: string | null) => {
    if (!ownInput()) fillText(date);
  };

  const chooseTemplate = async (id: string) => {
    if (id === templateId()) return;
    if (
      ownInput() &&
      !(await prompts.confirm(t.replaceInputQuestion, { title: t.replaceInputTitle, confirmText: t.replaceInput, icon: "ti ti-template" }))
    )
      return;
    setTemplateId(id);
    setError("");
    const template = selectedTemplate();
    if (!template) {
      setTitle("");
      setDescription("");
      applied = { title: "", description: "" };
      setPriority("");
      setSelectedTags([]);
      setAssignees([]);
      setAssignCreator(false);
      setChecklist([]);
      setEstimatedDurationMinutes(null);
      setLocation("");
      setUrl("");
      if (!isEvent()) setDeadline("");
      setDateChoice(null);
      return;
    }
    // An event opened from a calendar slot keeps the slot; the proposals stay one tap away.
    const keepSlot = template.kind === "event" && Boolean(props.defaults?.startsAt);
    const date = keepSlot
      ? null
      : (proposals()[0] ??
        (template.kind === "event" && !startsAt() ? defaultTemplateDate(template, { now: new Date(), timeZone: timeZone() }) : null));
    const draft = draftFromTemplate(templateDraftSource(template), { date, timeZone: timeZone(), locale: locale() });
    fillText(date);
    setPriority(draft.priority ?? "");
    setSelectedTags(draft.tagIds);
    setAssignees(template.assignees);
    setAssignCreator(draft.assignCreator);
    setChecklist(draft.checklist);
    setEstimatedDurationMinutes(draft.estimatedDurationMinutes ?? null);
    setLocation(draft.location ?? "");
    setUrl(draft.url ?? "");
    if (template.kind === "task" || date) applySchedule(date);
    setDateChoice(keepSlot ? null : (proposals()[0] ?? (template.kind === "task" ? NO_DATE : null)));
  };

  const chooseDate = (choice: string) => {
    setDateChoice(choice);
    setError("");
    if (choice === OTHER_DATE) return;
    if (choice === NO_DATE) {
      setDeadline("");
      followDate(null);
      return;
    }
    applySchedule(choice);
    followDate(choice);
  };
  const changeDeadline = (value: string | null) => {
    setDeadline(value ?? "");
    setError("");
    followDate(value ? datePart(value, props.dateConfig) : null);
  };
  /**
   * The form keeps event times as instants and an all-day range as local midnights with an exclusive end, the way
   * items store them; the picker shows and returns an all-day range as inclusive calendar dates.
   */
  const changeEventRange = (value: DateRangeValue) => {
    const start = value.start && allDay() ? allDayStart(value.start, props.dateConfig) : value.start;
    const end = value.end && allDay() ? allDayEnd(value.end, props.dateConfig) : value.end;
    setStartsAt(start ?? "");
    setEndsAt(end ?? "");
    setDateChoice(null);
    setError("");
    if (start) followDate(datePart(start, props.dateConfig));
  };

  const templateOptions = (): { value: string; label: string; icon?: string }[] => [
    { value: BLANK_TEMPLATE, label: t.blankTemplate },
    ...kindTemplates().map((template) => ({ value: template.id, label: template.name, icon: "ti ti-template" })),
  ];
  const dateOptions = () => [
    ...proposals().map((date) => ({ value: date, label: formatTemplateDate(date, locale()) })),
    ...(isEvent()
      ? []
      : [
          { value: OTHER_DATE, label: t.otherDate, icon: "ti ti-calendar" },
          { value: NO_DATE, label: t.noDate },
        ]),
  ];
  const templateSummary = () => {
    const template = selectedTemplate();
    if (!template) return [];
    const priorityLabel = priorityOptions(locale()).find((option) => option.id === template.priority)?.label;
    return [
      ...(template.kind === "task" && checklist().length ? [t.checklistCount({ count: checklist().length })] : []),
      ...template.tags.map((tag) => tag.name),
      ...(template.priority && priorityLabel ? [priorityLabel] : []),
      ...template.assignees.map((assignee) => assignee.displayName),
      ...(assignCreator() ? [t.you] : []),
      ...(template.kind === "event" && template.location ? [template.location] : []),
      ...(template.kind === "event" && !template.allDay && template.durationMinutes
        ? [t.minutesShort({ count: template.durationMinutes })]
        : []),
    ];
  };

  const isEvent = () => itemType() === "event";
  const defaultTitle = () => (isEditMode() ? (isEvent() ? t.editEvent : t.editTask) : isEvent() ? t.newEvent : t.newTask);
  const defaultIcon = () => (isEditMode() ? "ti ti-pencil" : isEvent() ? "ti ti-calendar-plus" : "ti ti-square-plus");
  const defaultSubmitLabel = () => (isEditMode() ? (isEvent() ? t.saveEvent : t.saveTask) : isEvent() ? t.createEvent : t.createTask);
  const eventRange = () =>
    allDay() ? dateOnlyRange(startsAt(), endsAt(), props.dateConfig) : { start: startsAt() || null, end: endsAt() || null };
  const recurrenceSummary = () =>
    summarizeRecurrenceState(
      {
        preset: recurrenceEnabled() ? "custom" : "never",
        frequency: recurrenceFrequency(),
        interval: recurrenceInterval() ?? 1,
        byDay: recurrenceByDay(),
        endMode: recurrenceEndMode(),
        until: recurrenceUntil(),
        count: recurrenceCount(),
      },
      { startsAt: startsAt(), allDay: allDay(), dateConfig: props.dateConfig },
    );
  const columnOptions = () =>
    props.columns.map((c) => ({
      id: c.id,
      label: c.name,
      icon: "ti ti-layout-list",
    }));

  const defaultColumnId = () => props.columns[0]?.id ?? "";
  const quickCreate = () => props.quickCreate && !isEditMode() && !showFullEditor();

  const toggleRecurrenceDay = (day: string) => {
    setRecurrenceByDay((prev) => (prev.includes(day) ? prev.filter((value) => value !== day) : [...prev, day]));
  };

  const handleRecurrenceEnabled = (enabled: boolean) => {
    setRecurrenceEnabled(enabled);
    if (!enabled) {
      const empty = emptyRecurrenceState();
      setRecurrenceFrequency(empty.frequency);
      setRecurrenceInterval(empty.interval);
      setRecurrenceByDay(empty.byDay);
      setRecurrenceEndMode(empty.endMode);
      setRecurrenceUntil(empty.until);
      setRecurrenceCount(empty.count);
    }
  };

  const handleTypeChange = (type: ItemType) => {
    setItemType(type);
    setError("");
    // Templates belong to one kind; the entered text stays, the template's extras go.
    if (templateId() !== BLANK_TEMPLATE) {
      setTemplateId(BLANK_TEMPLATE);
      setChecklist([]);
      setAssignCreator(false);
      setDateChoice(null);
    }
  };

  const handleAllDayChange = (enabled: boolean) => {
    if (enabled === allDay()) return;
    // Both directions read the range as calendar days, so the exclusive all-day end never adds a day.
    const days = dateOnlyRange(startsAt(), endsAt(), props.dateConfig);
    const lastDay = days.end ?? days.start;
    if (enabled) {
      setStartsAt(days.start ? allDayStart(days.start, props.dateConfig) : "");
      setEndsAt(lastDay ? allDayEnd(lastDay, props.dateConfig) : "");
    } else if (days.start) {
      setStartsAt(instantFromLocalDateTime(days.start, "09:00", props.dateConfig));
      setEndsAt(instantFromLocalDateTime(days.end ?? days.start, "10:00", props.dateConfig));
    }
    setAllDay(enabled);
    setError("");
  };

  const submitEventStart = () => {
    if (!allDay()) return startsAt() ? new Date(startsAt()).toISOString() : undefined;
    const range = eventRange();
    return range.start ? allDayStart(range.start, props.dateConfig) : undefined;
  };
  const submitEventEnd = () => {
    if (!allDay()) return endsAt() ? new Date(endsAt()).toISOString() : undefined;
    const range = eventRange();
    return range.end ? allDayEnd(range.end, props.dateConfig) : undefined;
  };

  const handleSubmit = async (e: Event) => {
    e.preventDefault();
    if (submitting()) return;
    setError("");

    if (!title().trim()) {
      setError(t.titleRequired);
      return;
    }

    if (!isEvent() && !columnId()) {
      setError(t.selectStatusRequired);
      return;
    }

    const eventStartsAt = submitEventStart();
    const eventEndsAt = submitEventEnd();

    if (isEvent()) {
      if (!eventStartsAt || !eventEndsAt) {
        setError(t.eventTimesRequired);
        return;
      }
      if (new Date(eventEndsAt) <= new Date(eventStartsAt)) {
        setError(t.endAfterStart);
        return;
      }
      if (url().trim()) {
        try {
          new URL(url().trim());
        } catch {
          setError(t.validEventUrl);
          return;
        }
      }
    }

    const data: ItemFormData = {
      ...(!isEditMode() && references().length ? { references: references() } : {}),
      columnId: columnId() || defaultColumnId(),
      title: title().trim(),
      description: description().trim() || undefined,
      location: isEvent() ? location().trim() || (isEditMode() ? null : undefined) : undefined,
      url: isEvent() ? url().trim() || (isEditMode() ? null : undefined) : undefined,
      startsAt: isEvent() ? eventStartsAt : undefined,
      endsAt: isEvent() ? eventEndsAt : undefined,
      allDay: isEvent() ? allDay() : false,
      recurrence:
        isEvent() && recurrenceEnabled()
          ? recurrenceFromFormState(
              {
                preset: "custom",
                frequency: recurrenceFrequency(),
                interval: recurrenceInterval() ?? 1,
                byDay: recurrenceByDay(),
                endMode: recurrenceEndMode(),
                until: recurrenceUntil(),
                count: recurrenceCount(),
              },
              startsAt(),
              props.dateConfig,
            )
          : null,
      deadline: !isEvent() && deadline() ? new Date(deadline()).toISOString() : undefined,
      estimatedDurationMinutes: !isEvent() ? (estimatedDurationMinutes() ?? (isEditMode() ? null : undefined)) : undefined,
      priority: (priority() || (isEditMode() ? null : undefined)) as Priority | null | undefined,
      assigneeIds: isEditMode() || assignees().length > 0 ? assignees().map((assignee) => assignee.id) : undefined,
      tagIds: isEditMode() || selectedTags().length > 0 ? selectedTags() : undefined,
      ...(!isEditMode() && !isEvent() && checklist().length ? { checklist: checklist() } : {}),
      ...(!isEditMode() && assignCreator() ? { assignCreator: true } : {}),
    };
    // A save that runs from the dialog keeps it open until the server answers; a refusal stays here with the input.
    setSubmitting(true);
    try {
      await props.onSubmit(data);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : String(submitError));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <PanelDialog>
      <form
        onSubmit={handleSubmit}
        class="spaces-item-form flex min-h-0 flex-1 flex-col overflow-hidden"
        data-presentation={quickCreate() ? "compact" : "full"}
      >
        <PanelDialog.Header title={props.title ?? defaultTitle()} icon={props.icon ?? defaultIcon()} close={props.onCancel} />
        <PanelDialog.Body>
          <Show when={!isEditMode() && references().length}>
            <PanelDialog.Section title={commandMessages().linkedSource} icon="ti ti-link">
              <For each={references()}>
                {(reference) => (
                  <Button
                    variant="subtle"
                    size="sm"
                    aria-label={commandMessages().removeSource({ title: reference.label })}
                    onClick={() => setReferences((items) => items.filter((item) => item !== reference))}
                  >
                    <i class="ti ti-link" aria-hidden="true" /> {reference.label} <i class="ti ti-x" aria-hidden="true" />
                  </Button>
                )}
              </For>
            </PanelDialog.Section>
          </Show>
          <Show when={!isEditMode()}>
            <SegmentedControl
              ariaLabel={t.type}
              options={[
                { value: "task" as const, label: t.task, icon: "ti ti-checkbox" },
                { value: "event" as const, label: t.event, icon: "ti ti-calendar-event" },
              ]}
              value={itemType}
              onValueChange={handleTypeChange}
            />
          </Show>
          <Show when={quickCreate() && kindTemplates().length > 0}>
            <Show
              when={kindTemplates().length <= MAX_TEMPLATE_CHIPS}
              fallback={
                <Select
                  label={t.template}
                  placeholder={t.chooseTemplate}
                  icon="ti ti-template"
                  value={templateId}
                  onValueChange={(value) => void chooseTemplate(value ?? BLANK_TEMPLATE)}
                  options={templateOptions().map((option) => ({ id: option.value, label: option.label, icon: option.icon }))}
                  searchable
                />
              }
            >
              <ChoiceChips
                label={t.template}
                value={templateId}
                onValueChange={(value) => void chooseTemplate(value)}
                options={templateOptions()}
                class="spaces-template-choice"
              />
            </Show>
          </Show>
          <Show
            when={quickCreate()}
            fallback={
              <>
                <PanelDialog.Section title={t.general} subtitle={t.generalDescription} icon="ti ti-info-circle">
                  <TextInput
                    label={t.title}
                    description={!isEditMode() ? t.titleDescription : undefined}
                    placeholder={t.titlePlaceholder}
                    icon="ti ti-text-caption"
                    value={title}
                    onValueChange={(v) => {
                      setTitle(v);
                      setError("");
                    }}
                    required
                  />
                  <TextInput
                    label={t.description}
                    description={!isEditMode() ? t.descriptionHint : undefined}
                    placeholder={t.markdownDescriptionPlaceholder}
                    value={description}
                    onValueChange={setDescription}
                    markdown
                  />
                  <Show when={!isEvent()}>
                    <div class="grid grid-cols-1 gap-3 md:grid-cols-2">
                      <DateTimePicker
                        label={t.deadline}
                        description={!isEditMode() ? t.deadlineDescription : undefined}
                        value={() => deadline() || null}
                        onValueChange={changeDeadline}
                        dateConfig={props.dateConfig}
                        presets={deadlinePresets(props.dateConfig)}
                        clearable
                      />
                      <NumberInput
                        label={t.estimatedDuration}
                        description={!isEditMode() ? t.estimatedDurationDescription : undefined}
                        value={estimatedDurationMinutes}
                        onValueChange={setEstimatedDurationMinutes}
                        min={1}
                        max={2_147_483_647}
                        step={15}
                        suffix="min"
                        allowNegative={false}
                        clearable
                      />
                    </div>
                  </Show>

                  <Show when={isEvent()}>
                    <DateRangePicker
                      withTime={!allDay()}
                      label={t.schedule}
                      description={!isEditMode() ? (allDay() ? t.calendarDaysDescription : t.eventTimesDescription) : undefined}
                      value={eventRange}
                      onValueChange={changeEventRange}
                      dateConfig={props.dateConfig}
                      datePresets={scheduleDatePresets(props.dateConfig)}
                      durationPresets={allDay() ? undefined : EVENT_DURATION_PRESETS}
                      required
                      clearable
                    />
                    <CheckboxCard
                      label={t.allDayEvent}
                      description={t.allDayEventDescription}
                      icon="ti ti-calendar"
                      variant="input"
                      value={allDay}
                      onValueChange={handleAllDayChange}
                    />
                  </Show>
                </PanelDialog.Section>

                <Show when={isEvent()}>
                  <PanelDialog.Section title={t.repeat} subtitle={t.repeatDescription} icon="ti ti-repeat">
                    <CheckboxCard
                      label={t.repeatEvent}
                      description={t.repeatEventDescription}
                      icon="ti ti-repeat"
                      variant="input"
                      value={recurrenceEnabled}
                      onValueChange={handleRecurrenceEnabled}
                    />
                    <Show when={recurrenceEnabled()}>
                      <div class="grid grid-cols-1 gap-3 md:grid-cols-2">
                        <Select
                          label={t.frequency}
                          description={!isEditMode() ? t.frequencyDescription : undefined}
                          icon="ti ti-repeat"
                          value={recurrenceFrequency}
                          onValueChange={(value) => value && setRecurrenceFrequency(value as RecurrenceFrequency)}
                          options={recurrenceFrequencyOptions(props.dateConfig)}
                        />
                        <NumberInput
                          label={t.every}
                          description={!isEditMode() ? t.intervalDescription : undefined}
                          icon="ti ti-refresh"
                          value={recurrenceInterval}
                          onValueChange={setRecurrenceInterval}
                          min={1}
                          step={1}
                          allowNegative={false}
                        />
                      </div>
                      <Show when={recurrenceFrequency() === "weekly"}>
                        <div>
                          <p class="mb-1 block text-sm font-medium">{t.weekdays}</p>
                          <p class="mb-2 text-xs text-dimmed">{t.weekdaysDescription}</p>
                          <div class="grid grid-cols-7 gap-1">
                            <For each={weekdayOptions(props.dateConfig)}>
                              {(day) => (
                                <Button
                                  type="button"
                                  variant={recurrenceByDay().includes(day.id) ? "subtle" : "secondary"}
                                  size="sm"
                                  aria-label={day.fullLabel}
                                  aria-pressed={recurrenceByDay().includes(day.id)}
                                  class="w-full justify-center px-0"
                                  onClick={() => toggleRecurrenceDay(day.id)}
                                >
                                  {day.label}
                                </Button>
                              )}
                            </For>
                          </div>
                        </div>
                      </Show>
                      <div class="grid grid-cols-1 gap-3 md:grid-cols-2">
                        <Select
                          label={t.ends}
                          description={!isEditMode() ? t.endsDescription : undefined}
                          icon="ti ti-calendar-due"
                          value={recurrenceEndMode}
                          onValueChange={(value) => value && setRecurrenceEndMode(value as RecurrenceEndMode)}
                          options={recurrenceEndOptions(props.dateConfig)}
                        />
                        <Show when={recurrenceEndMode() === "on"}>
                          <DatePicker
                            label={t.until}
                            description={!isEditMode() ? t.untilDescription : undefined}
                            value={() => recurrenceUntil() || null}
                            onValueChange={(value) => setRecurrenceUntil(value ?? "")}
                            dateConfig={props.dateConfig}
                            clearable
                          />
                        </Show>
                        <Show when={recurrenceEndMode() === "after"}>
                          <NumberInput
                            label={t.occurrences}
                            description={!isEditMode() ? t.occurrencesDescription : undefined}
                            icon="ti ti-list-numbers"
                            value={recurrenceCount}
                            onValueChange={setRecurrenceCount}
                            min={1}
                            step={1}
                            allowNegative={false}
                            clearable
                          />
                        </Show>
                      </div>
                      <div
                        class="flex items-start gap-2 rounded-lg bg-zinc-50 px-3 py-2.5 text-sm text-zinc-700 dark:bg-zinc-900/50 dark:text-zinc-300"
                        role="status"
                        aria-live="polite"
                        aria-atomic="true"
                      >
                        <i class="ti ti-calendar-repeat mt-0.5 shrink-0 text-blue-600 dark:text-blue-400" aria-hidden="true" />
                        <span>{recurrenceSummary()}</span>
                      </div>
                    </Show>
                  </PanelDialog.Section>
                </Show>

                <Show when={isEvent()}>
                  <PanelDialog.Section title={t.eventDetails} subtitle={t.eventDetailsDescription} icon="ti ti-map-pin">
                    <div class="grid grid-cols-1 gap-3 md:grid-cols-2">
                      <TextInput
                        label={t.location}
                        description={!isEditMode() ? t.locationDescription : undefined}
                        placeholder={t.locationPlaceholder}
                        icon="ti ti-map-pin"
                        value={location}
                        onValueChange={setLocation}
                      />
                      <TextInput
                        label={t.url}
                        description={!isEditMode() ? t.urlDescription : undefined}
                        placeholder="https://..."
                        icon="ti ti-link"
                        type="url"
                        inputMode="url"
                        value={url}
                        onValueChange={(v) => {
                          setUrl(v);
                          setError("");
                        }}
                      />
                    </div>
                  </PanelDialog.Section>
                </Show>

                <PanelDialog.Section title={t.organize} subtitle={t.organizeDescription} icon="ti ti-tags">
                  <div class="grid grid-cols-1 gap-3 md:grid-cols-2">
                    <Select
                      label={t.status}
                      description={!isEditMode() ? t.statusDescription : undefined}
                      placeholder={t.selectColumn}
                      icon="ti ti-progress"
                      value={columnId}
                      onValueChange={(value) => value && setColumnId(value)}
                      options={columnOptions()}
                      required={!isEvent()}
                    />
                    <Select
                      label={t.priority}
                      description={!isEditMode() ? t.priorityDescription : undefined}
                      placeholder={t.selectPriority}
                      icon="ti ti-flag"
                      value={priority}
                      onValueChange={(value) => setPriority(value ?? "")}
                      options={priorityOptions(props.dateConfig?.locale)}
                      clearable
                    />
                  </div>
                  <Show when={props.tags && props.tags.length > 0}>
                    <MultiSelectInput
                      label={t.tags}
                      description={!isEditMode() ? t.tagsDescription : undefined}
                      placeholder={t.selectTags}
                      searchPlaceholder={t.searchTags}
                      icon="ti ti-tags"
                      value={selectedTags}
                      onValueChange={setSelectedTags}
                      options={(props.tags ?? []).map((tag) => ({ id: tag.id, label: tag.name, color: tag.color }))}
                      clearable
                    />
                  </Show>

                  <Show when={!isEditMode() && !isEvent() && (templateId() !== BLANK_TEMPLATE || checklist().length > 0)}>
                    <TextInput
                      label={t.templateChecklist}
                      description={t.templateChecklistDescription}
                      value={() => checklist().join("\n")}
                      onValueChange={(value) =>
                        setChecklist(
                          value
                            .split("\n")
                            .map((line) => line.trim())
                            .filter(Boolean),
                        )
                      }
                      multiline
                      lines={3}
                    />
                  </Show>
                  <Show when={!isEditMode() && (templateId() !== BLANK_TEMPLATE || assignCreator())}>
                    <Switch label={t.assignMe} description={t.assignMeDescription} value={assignCreator} onValueChange={setAssignCreator} />
                  </Show>

                  <div class="flex flex-col gap-3">
                    <div>
                      <p class="mb-1 block text-sm font-medium">{t.assignees}</p>
                      <p class="text-xs text-dimmed">{t.assigneesDescription}</p>
                    </div>
                    <SpaceAssigneePicker
                      spaceId={props.spaceId}
                      value={assignees}
                      onChange={(next) => setAssignees(next)}
                      placeholder={t.searchPeople}
                    />
                  </div>
                </PanelDialog.Section>
              </>
            }
          >
            <div class="flex flex-col gap-5">
              <TextInput
                label={t.title}
                placeholder={isEvent() ? t.eventTitle : t.titlePlaceholder}
                icon="ti ti-text-caption"
                value={title}
                onValueChange={(value) => {
                  setTitle(value);
                  setError("");
                }}
                autofocus
                required
              />

              <TextInput
                label={t.description}
                placeholder={t.markdownDescriptionPlaceholder}
                value={description}
                onValueChange={setDescription}
                multiline
                lines={3}
              />

              <Show when={selectedTemplate() && proposals().length > 0}>
                <ChoiceChips
                  label={isEvent() ? t.templateWhen : t.templateDue}
                  description={t.templateProposal({ rule: describeTemplateDateRule(selectedTemplate()!, locale()) })}
                  value={dateChoice}
                  onValueChange={chooseDate}
                  options={dateOptions()}
                  class="spaces-template-dates"
                />
              </Show>
              {/* A deadline the dialog was opened with shows, so the task is never created with a date it hides. */}
              <Show when={!isEvent() && (dateChoice() === OTHER_DATE || (Boolean(props.defaults?.deadline) && !selectedTemplate()))}>
                <DateTimePicker
                  label={t.deadline}
                  value={() => deadline() || null}
                  onValueChange={changeDeadline}
                  dateConfig={props.dateConfig}
                  presets={deadlinePresets(props.dateConfig)}
                  clearable
                />
              </Show>

              <Show when={templateSummary().length > 0}>
                <p class="spaces-template-summary text-xs text-dimmed" data-testid="template-summary">
                  <span>{t.fromTemplate}</span> <span class="text-zinc-700 dark:text-zinc-300">{templateSummary().join(" · ")}</span>
                </p>
              </Show>

              <Show when={isEvent()}>
                <DateRangePicker
                  withTime={!allDay()}
                  label={t.schedule}
                  description={allDay() ? t.calendarDaysDescription : t.startAndEnd}
                  value={eventRange}
                  onValueChange={changeEventRange}
                  dateConfig={props.dateConfig}
                  datePresets={scheduleDatePresets(props.dateConfig)}
                  durationPresets={allDay() ? undefined : EVENT_DURATION_PRESETS}
                  required
                  clearable
                />

                <Switch label={t.allDayEvent} value={allDay} onValueChange={handleAllDayChange} />
              </Show>
            </div>
          </Show>

          <Show when={error()}>
            <div class="flex items-center gap-1 text-sm text-red-500" role="alert">
              <i class="ti ti-alert-circle" />
              {error()}
            </div>
          </Show>
        </PanelDialog.Body>

        <PanelDialog.Footer>
          <Show when={quickCreate()}>
            <Button type="button" variant="ghost" size="sm" onClick={() => setShowFullEditor(true)}>
              {t.moreOptions}
            </Button>
          </Show>
          <div class="ml-auto flex items-center gap-2">
            <Button type="button" variant="secondary" size="sm" onClick={props.onCancel} disabled={submitting()}>
              {t.cancel}
            </Button>
            <Button type="submit" size="sm" loading={submitting()}>
              {props.submitLabel ?? defaultSubmitLabel()}
            </Button>
          </div>
        </PanelDialog.Footer>
      </form>
    </PanelDialog>
  );
}
