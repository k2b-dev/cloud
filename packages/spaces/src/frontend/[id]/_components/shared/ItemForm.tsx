import { dates } from "@k2b/stdlib";
import { useLocale } from "@k2b/ui";
import {
  Bar,
  Button,
  Check,
  Chip,
  Choice,
  confirm,
  DateInput,
  Dialog,
  Field,
  Inline,
  Input,
  Lookup,
  Menu,
  Notice,
  Select,
  Text,
} from "@k2b/ui/v2";
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { apiClient } from "@/api/client";
import { ESTIMATE_STEP_MINUTES, type EstimateSuggestionResult, type SpaceItemAssignee } from "@/contracts";
import { isDateOnlyDeadline } from "@/presentation/deadline";
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
import { templateIcon } from "./create-menu";
import { allDayEnd, allDayStart, DEADLINE_DEFAULT_TIME, dateOnlyRange, datePart, instantFromLocalDateTime } from "./item-form/date";
import { priorityOptions } from "./item-form/options";
import { BLANK_TEMPLATE, browserTimeZone, MAX_TEMPLATE_CHIPS, NO_DATE, OTHER_DATE, templateDraftSource } from "./item-form/templates";
import type { ItemFormData, ItemFormProps, ItemType, Priority } from "./item-form/types";

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
  // A deadline without a time stays a date key; a timed one is edited like the event times.
  const deadlineInitial = (value?: string | null) => (value && isDateOnlyDeadline(value) ? value : dateTimeInitial(value));
  const [deadline, setDeadline] = createSignal(deadlineInitial(props.item?.deadline ?? props.defaults?.deadline));
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
  /**
   * An edit sends the assignees only when the person changed them, so a title edit never replaces a list that changed
   * meanwhile, such as by someone claiming the task.
   */
  const initialTitle = props.item?.title;
  const initialAssigneeIds = props.item?.assignees?.map((assignee) => assignee.id) ?? [];
  let createAttempt: { input: string; key: string } | undefined;
  const assigneeChange = () => {
    const ids = assignees().map((assignee) => assignee.id);
    if (!isEditMode()) return ids.length > 0 ? ids : undefined;
    const before = initialAssigneeIds;
    return ids.length === before.length && ids.every((id) => before.includes(id)) ? undefined : ids;
  };
  const [selectedTags, setSelectedTags] = createSignal<string[]>(props.item?.tags?.map((t) => t.id) ?? props.defaults?.tagIds ?? []);
  const [error, setError] = createSignal("");
  const [submitting, setSubmitting] = createSignal(false);
  const [showFullEditor, setShowFullEditor] = createSignal(!props.quickCreate || isEditMode());
  const [checklist, setChecklist] = createSignal<string[]>(props.defaults?.checklist ?? []);
  const [assignCreator, setAssignCreator] = createSignal(props.defaults?.assignCreator ?? false);

  // ---------- Estimate suggestion (edit only) ----------
  // The assistant's estimate is offered in the estimate field, never set as its value: the person accepts it, types
  // their own, or leaves the field empty, and an open suggestion is not saved.
  const loadEstimate = isEditMode() && !initialIsEvent() ? props.loadEstimateSuggestion : undefined;
  const [estimate, setEstimate] = createSignal<EstimateSuggestionResult | "loading">("loading");
  const [estimateAccepted, setEstimateAccepted] = createSignal(false);
  let estimateRequest: AbortController | undefined;
  const requestEstimate = async () => {
    if (!loadEstimate) return;
    estimateRequest?.abort();
    const request = new AbortController();
    estimateRequest = request;
    setEstimate("loading");
    try {
      const result = await loadEstimate(request.signal);
      if (!request.signal.aborted) setEstimate(result);
    } catch {
      if (!request.signal.aborted) setEstimate({ state: "failed", reason: "error" });
    }
  };
  onMount(() => void requestEstimate());
  onCleanup(() => estimateRequest?.abort());
  let estimateInput: HTMLInputElement | HTMLTextAreaElement | undefined;
  const acceptEstimate = () => {
    const current = estimate();
    if (current === "loading" || current.state !== "ready") return;
    setEstimatedDurationMinutes(current.suggestion.minutes);
    setEstimateAccepted(true);
    estimateInput?.focus();
  };
  const estimateTitle = () => {
    const result = estimate();
    if (result === "loading") return t.estimateSuggestionLoading;
    if (result.state === "ready") return t.estimateSuggestionReady;
    if (result.state === "none") return t.estimateSuggestionNone;
    return result.reason === "allowance"
      ? t.estimateSuggestionAllowance
      : result.reason === "unavailable"
        ? t.estimateSuggestionUnavailable
        : t.estimateSuggestionFailed;
  };
  /** An open suggestion is one the empty field still shows; saving keeps the field empty. */
  const estimateOpen = () => {
    const result = estimate();
    return result !== "loading" && result.state === "ready" && estimatedDurationMinutes() === null && !estimateAccepted();
  };

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
    // An event fills in its day; a task its due day, such as one a calendar selection gave it.
    const eventDay =
      template.kind === "event" && startsAt()
        ? datePart(startsAt(), props.dateConfig)
        : template.kind === "task" && deadline()
          ? datePart(deadline(), props.dateConfig)
          : null;
    const text = templateText(template, { date: date ?? eventDay ?? localNow(new Date(), timeZone()).date, locale: locale() });
    setTitle(text.title);
    setDescription(text.description);
    applied = text;
  };
  /** Untouched placeholders follow every date change, from a chip or from a picker. */
  const followDate = (date: string | null) => {
    if (!ownInput()) fillText(date);
  };

  // k2b-ui gap: a v2 Choice keeps the browser's tick on an option the form declined (fix with lane N, #4160), so a
  // second press on it would do nothing; after a decline the choice is drawn anew from the form's value.
  const [templateRound, setTemplateRound] = createSignal(0);
  const chooseTemplate = async (id: string, opening = false) => {
    if (id === templateId()) return;
    if (
      !opening &&
      ownInput() &&
      !(await confirm({ title: t.replaceInputTitle, description: t.replaceInputQuestion, confirm: t.replaceInput }))
    ) {
      setTemplateRound((round) => round + 1);
      return;
    }
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
    // An item opened from a calendar selection keeps its time; the proposals stay one tap away.
    const keepSlot = template.kind === "event" ? Boolean(props.defaults?.startsAt) : Boolean(props.defaults?.deadline);
    const date = keepSlot
      ? null
      : (proposals()[0] ??
        (template.kind === "event" && !startsAt() ? defaultTemplateDate(template, { now: new Date(), timeZone: timeZone() }) : null));
    const draft = draftFromTemplate(templateDraftSource(template), { date, timeZone: timeZone(), locale: locale() });
    fillText(date);
    // A title the opener carried, such as one typed in the calendar's quick create, stays.
    if (opening && props.defaults?.title) setTitle(props.defaults.title);
    setPriority(draft.priority ?? "");
    // Tags the opener gave, such as a calendar filter's, stay beside the template's, so the item shows where it was made.
    setSelectedTags(opening ? [...new Set([...(props.defaults?.tagIds ?? []), ...draft.tagIds])] : draft.tagIds);
    setAssignees(template.assignees);
    setAssignCreator(draft.assignCreator);
    setChecklist(draft.checklist);
    setEstimatedDurationMinutes(draft.estimatedDurationMinutes ?? null);
    setLocation(draft.location ?? "");
    setUrl(draft.url ?? "");
    if ((template.kind === "task" && !keepSlot) || date) applySchedule(date);
    setDateChoice(keepSlot ? null : (proposals()[0] ?? (template.kind === "task" ? NO_DATE : null)));
  };

  // A "+" that chose a template opens the dialog with it chosen; the chips still switch.
  onMount(() => {
    const id = props.defaults?.templateId;
    if (id && kindTemplates().some((template) => template.id === id)) void chooseTemplate(id, true);
  });
  /** The column a "+" of a column gave the new task, said quietly, since the short form shows no status. */
  const plusColumn = () =>
    !isEditMode() && quickCreate() && props.defaults?.columnId
      ? props.columns.find((column) => column.id === props.defaults?.columnId)
      : undefined;

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
  const changeEventRange = (value: { start: string | null; end: string | null }) => {
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
    ...kindTemplates().map((template) => ({ value: template.id, label: template.name, icon: templateIcon(template) })),
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
  const _defaultIcon = () => (isEditMode() ? "ti ti-pencil" : isEvent() ? "ti ti-calendar-plus" : "ti ti-square-plus");
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
      deadline: !isEvent() && deadline() ? (isDateOnlyDeadline(deadline()) ? deadline() : new Date(deadline()).toISOString()) : undefined,
      estimatedDurationMinutes: !isEvent() ? (estimatedDurationMinutes() ?? (isEditMode() ? null : undefined)) : undefined,
      priority: (priority() || (isEditMode() ? null : undefined)) as Priority | null | undefined,
      assigneeIds: assigneeChange(),
      ...(isEditMode()
        ? {
            expectedTitle: initialTitle,
            ...(assigneeChange() !== undefined
              ? {
                  addAssigneeIds: assignees()
                    .map((assignee) => assignee.id)
                    .filter((id) => !initialAssigneeIds.includes(id)),
                  removeAssigneeIds: initialAssigneeIds.filter((id) => !assignees().some((assignee) => assignee.id === id)),
                }
              : {}),
          }
        : {}),
      tagIds: isEditMode() || selectedTags().length > 0 ? selectedTags() : undefined,
      ...(!isEditMode() && !isEvent() && checklist().length ? { checklist: checklist() } : {}),
      ...(!isEditMode() && assignCreator() ? { assignCreator: true } : {}),
    };
    if (!isEditMode()) {
      const input = JSON.stringify(data);
      if (createAttempt?.input !== input) createAttempt = { input, key: crypto.randomUUID() };
      data.requestKey = createAttempt.key;
    }
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

  const peopleSeen: SpaceItemAssignee[] = [];
  const loadPeople = async (search: string, context: { signal: AbortSignal; limit: number }) => {
    const response = await apiClient[":id"]["assignable-users"].$get(
      { param: { id: props.spaceId }, query: { search } },
      { init: { signal: context.signal } },
    );
    if (!response.ok) throw new Error(t.loadAssigneesFailed);
    const users = await response.json();
    peopleSeen.push(...users);
    return { items: users.slice(0, context.limit).map((user) => ({ value: user.id, label: user.displayName })) };
  };
  const pickPeople = (ids: string[]) =>
    setAssignees(
      ids.flatMap((id) => {
        const known = assignees().find((person) => person.id === id) ?? peopleSeen.find((person) => person.id === id);
        return known ? [known] : [];
      }),
    );
  const tagNames = () =>
    selectedTags()
      .map((id) => props.tags?.find((tag) => tag.id === id)?.name)
      .filter(Boolean)
      .join(", ");
  /** The day and the time of a value the form keeps (a date key or an instant), as the person reads them. */
  const dayOf = (value: string) => (value ? datePart(value, props.dateConfig) : "");
  const timeOf = (value: string) => (value && !isDateOnlyDeadline(value) ? dates.formatTime(value, props.dateConfig) : "");
  const validTime = (time: string) => /^\d{1,2}:\d{2}$/.test(time.trim());
  /** A deadline is a day, or a day and a time; the time is optional. */
  const setDeadlineParts = (day: string, time: string) => {
    if (!day) return changeDeadline(null);
    if (time.trim() && !validTime(time)) return setError(t.invalidTime);
    changeDeadline(time.trim() ? instantFromLocalDateTime(day, time.trim().padStart(5, "0"), props.dateConfig) : day);
  };
  /** An event's start or end from its day and time; an all-day event counts whole days. */
  const setEventPart = (edge: "start" | "end", day: string, time: string) => {
    const range = eventRange();
    if (allDay()) {
      changeEventRange(edge === "start" ? { start: day || null, end: range.end } : { start: range.start, end: day || null });
      return;
    }
    if (day && !validTime(time)) return setError(t.invalidTime);
    const instant = day ? instantFromLocalDateTime(day, time.trim().padStart(5, "0"), props.dateConfig) : null;
    changeEventRange(edge === "start" ? { start: instant, end: range.end } : { start: range.start, end: instant });
  };
  const deadlineFields = () => (
    <Field.Row>
      <Field label={t.deadline} name="deadline" optional={t.optional}>
        {/* k2b-ui gap: the v2 date picker is not out yet (#4159); until then a day is typed as 2026-11-27. */}
        <DateInput value={dayOf(deadline())} onInput={(day) => setDeadlineParts(day, timeOf(deadline()))} />
      </Field>
      <Field label={t.time} name="deadline-time" optional={t.optional}>
        {/* k2b-ui gap: no time field in v2 yet; a time is typed as hours and minutes. */}
        <Input
          value={timeOf(deadline())}
          placeholder={DEADLINE_DEFAULT_TIME}
          onInput={(time) => setDeadlineParts(dayOf(deadline()) || dayOf(new Date().toISOString()), time)}
        />
      </Field>
    </Field.Row>
  );
  const scheduleFields = () => (
    <>
      <Field.Row>
        <Field label={t.start} name="starts" required>
          <DateInput value={dayOf(startsAt())} onInput={(day) => setEventPart("start", day, timeOf(startsAt()) || "09:00")} />
        </Field>
        <Show when={!allDay()}>
          <Field label={t.time} name="starts-time">
            <Input value={timeOf(startsAt())} placeholder="09:00" onInput={(time) => setEventPart("start", dayOf(startsAt()), time)} />
          </Field>
        </Show>
      </Field.Row>
      <Field.Row>
        <Field label={t.end} name="ends" required>
          <DateInput
            value={allDay() ? (eventRange().end ?? "") : dayOf(endsAt())}
            onInput={(day) => setEventPart("end", day, timeOf(endsAt()) || "10:00")}
          />
        </Field>
        <Show when={!allDay()}>
          <Field label={t.time} name="ends-time">
            <Input
              value={timeOf(endsAt())}
              placeholder="10:00"
              onInput={(time) => setEventPart("end", dayOf(endsAt()) || dayOf(startsAt()), time)}
            />
          </Field>
        </Show>
      </Field.Row>
      <Check switch label={t.allDayEvent} checked={allDay()} onChange={handleAllDayChange} />
    </>
  );
  /** The ready suggestion, if there is one. */
  const estimateReady = () => {
    const result = estimate();
    return result !== "loading" && result.state === "ready" ? result.suggestion : null;
  };
  /**
   * Gustav's estimate in one line under the field, from the first frame on, so arriving and accepting move nothing:
   * what Gustav is doing or found, and whether an open suggestion is kept.
   */
  const estimateLine = () => {
    const suggestion = estimateReady();
    if (!suggestion) return estimateTitle();
    if (estimateAccepted()) return t.estimateSuggestionTaken({ minutes: suggestion.minutes });
    const found = `${suggestion.confidence === "low" ? t.estimateSuggestionUnsure : t.estimateSuggestionReady}: ${suggestion.minutes} min`;
    return estimateOpen() ? `${found}. ${t.estimateSuggestionUnsaved}` : found;
  };

  return (
    <Dialog
      title={props.title ?? defaultTitle()}
      open
      onOpenChange={(open) => !open && props.onCancel()}
      foot={
        <>
          <Show when={quickCreate()}>
            <Button variant="text" onClick={() => setShowFullEditor(true)}>
              {t.moreOptions}
            </Button>
          </Show>
          <Button onClick={props.onCancel} disabled={submitting()}>
            {t.cancel}
          </Button>
          <Button variant="primary" busy={submitting()} onClick={() => void handleSubmit(new Event("submit"))}>
            {props.submitLabel ?? defaultSubmitLabel()}
          </Button>
        </>
      }
    >
      <Show when={!isEditMode() && references().length}>
        <Field label={commandMessages().linkedSource} name="references">
          <Inline>
            <For each={references()}>
              {(reference) => (
                <Chip icon="link" onClick={() => setReferences((items) => items.filter((item) => item !== reference))}>
                  {`${reference.label} ×`}
                </Chip>
              )}
            </For>
          </Inline>
        </Field>
      </Show>
      <Show when={!isEditMode()}>
        <Choice
          name="kind"
          label={t.type}
          value={itemType()}
          options={[
            { value: "task", label: t.task },
            { value: "event", label: t.event },
          ]}
          onChange={(value) => handleTypeChange(value === "event" ? "event" : "task")}
        />
      </Show>
      <Show when={quickCreate() && kindTemplates().length > 0}>
        <Show
          when={kindTemplates().length <= MAX_TEMPLATE_CHIPS}
          fallback={
            <Field label={t.template} name="template">
              <Select
                value={templateId()}
                options={templateOptions().map((option) => ({ value: option.value, label: option.label }))}
                onChange={(value) => void chooseTemplate(value)}
              />
            </Field>
          }
        >
          {/* A few templates stand side by side, one tap each, as before; drawn anew after a declined template. */}
          <Show when={templateRound() + 1} keyed>
            <Choice
              name="template"
              label={t.template}
              value={templateId()}
              options={templateOptions().map((option) => ({ value: option.value, label: option.label }))}
              onChange={(value) => void chooseTemplate(value)}
            />
          </Show>
        </Show>
      </Show>
      <Field label={t.title} name="title" error={error() === t.titleRequired ? error() : undefined} required>
        <Input
          value={title()}
          placeholder={isEvent() ? t.eventTitle : t.titlePlaceholder}
          onInput={(value) => {
            setTitle(value);
            setError("");
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.isComposing) void handleSubmit(new Event("submit"));
          }}
        />
      </Field>
      <Field label={t.description} name="description" hint={!isEditMode() ? t.descriptionHint : undefined} optional={t.optional}>
        <Input multiline value={description()} placeholder={t.markdownDescriptionPlaceholder} onInput={setDescription} />
      </Field>
      <Show when={selectedTemplate() && proposals().length > 0}>
        <Field
          label={isEvent() ? t.templateWhen : t.templateDue}
          name="template-date"
          hint={t.templateProposal({ rule: describeTemplateDateRule(selectedTemplate()!, locale()) })}
        >
          <Choice
            name="template-date"
            value={dateChoice() ?? undefined}
            options={dateOptions().map((option) => ({ value: option.value, label: option.label }))}
            onChange={chooseDate}
          />
        </Field>
      </Show>
      <Show when={templateSummary().length > 0}>
        <Text type="meta">{`${t.fromTemplate} ${templateSummary().join(" · ")}`}</Text>
      </Show>
      <Show when={plusColumn()}>{(column) => <Text type="meta">{t.landsInColumn({ column: column().name })}</Text>}</Show>
      <Show
        when={!quickCreate()}
        fallback={
          <>
            {/* A deadline the dialog was opened with shows, so the task is never created with a date it hides. */}
            <Show when={!isEvent() && (dateChoice() === OTHER_DATE || (Boolean(props.defaults?.deadline) && !selectedTemplate()))}>
              {deadlineFields()}
            </Show>
            <Show when={isEvent()}>{scheduleFields()}</Show>
          </>
        }
      >
        <Show when={!isEvent()}>
          {deadlineFields()}
          <Field
            label={t.estimatedDuration}
            name="estimate"
            hint={!isEditMode() ? t.estimatedDurationDescription : (estimateReady()?.reason ?? undefined)}
            optional="min"
          >
            <Input
              ref={(element) => (estimateInput = element)}
              type="number"
              min={ESTIMATE_STEP_MINUTES}
              value={estimatedDurationMinutes() === null ? "" : String(estimatedDurationMinutes())}
              placeholder={estimateOpen() ? String(estimateReady()!.minutes) : undefined}
              onInput={(value) => {
                const parsed = Number.parseInt(value, 10);
                setEstimatedDurationMinutes(Number.isFinite(parsed) && parsed > 0 ? parsed : null);
              }}
            />
          </Field>
          <Show when={loadEstimate}>
            <Notice
              tone="ai"
              actions={
                estimateReady() && !estimateAccepted()
                  ? [{ label: t.estimateSuggestionAccept, onClick: acceptEstimate }]
                  : (() => {
                      const result = estimate();
                      return result !== "loading" && result.state === "failed" && result.reason === "error"
                        ? [{ label: t.retry, onClick: () => void requestEstimate() }]
                        : undefined;
                    })()
              }
            >
              {estimateLine()}
            </Notice>
          </Show>
        </Show>
        <Show when={isEvent()}>
          {scheduleFields()}
          <Check switch label={t.repeatEvent} checked={recurrenceEnabled()} onChange={handleRecurrenceEnabled} />
          <Show when={recurrenceEnabled()}>
            <Field.Row>
              <Field label={t.frequency} name="frequency">
                <Select
                  value={recurrenceFrequency()}
                  options={recurrenceFrequencyOptions(props.dateConfig).map((option) => ({ value: option.id, label: option.label }))}
                  onChange={(value) => {
                    const next = (["daily", "weekly", "monthly", "yearly"] as const).find((entry) => entry === value);
                    if (next) setRecurrenceFrequency(next);
                  }}
                />
              </Field>
              <Field label={t.every} name="interval">
                <Input
                  type="number"
                  min={1}
                  value={String(recurrenceInterval() ?? 1)}
                  onInput={(value) => setRecurrenceInterval(Math.max(1, Number.parseInt(value, 10) || 1))}
                />
              </Field>
            </Field.Row>
            <Show when={recurrenceFrequency() === "weekly"}>
              <Bar
                start={
                  <Inline>
                    <For each={weekdayOptions(props.dateConfig)}>
                      {(day) => (
                        <Button
                          pressed={recurrenceByDay().includes(day.id)}
                          title={day.fullLabel}
                          onClick={() => toggleRecurrenceDay(day.id)}
                        >
                          {day.label}
                        </Button>
                      )}
                    </For>
                  </Inline>
                }
              />
            </Show>
            <Field.Row>
              <Field label={t.ends} name="ends-mode">
                <Select
                  value={recurrenceEndMode()}
                  options={recurrenceEndOptions(props.dateConfig).map((option) => ({ value: option.id, label: option.label }))}
                  onChange={(value) => {
                    const next = (["never", "on", "after"] as const).find((entry) => entry === value);
                    if (next) setRecurrenceEndMode(next);
                  }}
                />
              </Field>
              <Show when={recurrenceEndMode() === "on"}>
                <Field label={t.until} name="until">
                  <DateInput value={recurrenceUntil()} onInput={setRecurrenceUntil} />
                </Field>
              </Show>
              <Show when={recurrenceEndMode() === "after"}>
                <Field label={t.occurrences} name="count">
                  <Input
                    type="number"
                    min={1}
                    value={recurrenceCount() === null ? "" : String(recurrenceCount())}
                    onInput={(value) => setRecurrenceCount(Number.parseInt(value, 10) || null)}
                  />
                </Field>
              </Show>
            </Field.Row>
            <Text type="meta">{recurrenceSummary()}</Text>
          </Show>
          <Field.Row>
            <Field label={t.location} name="location" optional={t.optional}>
              <Input value={location()} placeholder={t.locationPlaceholder} onInput={setLocation} />
            </Field>
            <Field label={t.url} name="url" optional={t.optional} error={error() === t.validEventUrl ? error() : undefined}>
              <Input
                type="url"
                value={url()}
                placeholder="https://"
                onInput={(value) => {
                  setUrl(value);
                  setError("");
                }}
              />
            </Field>
          </Field.Row>
        </Show>
        <Field.Row>
          <Field label={t.status} name="status" required={!isEvent()}>
            <Select
              value={columnId()}
              placeholder={t.selectColumn}
              options={columnOptions().map((option) => ({ value: option.id, label: option.label }))}
              onChange={setColumnId}
            />
          </Field>
          <Field label={t.priority} name="priority" optional={t.optional}>
            <Select
              value={priority() ?? ""}
              options={[
                { value: "", label: t.noPriority },
                ...priorityOptions(props.dateConfig?.locale).map((option) => ({ value: option.id, label: option.label })),
              ]}
              onChange={setPriority}
            />
          </Field>
        </Field.Row>
        <Show when={props.tags && props.tags.length > 0}>
          <Field label={t.tags} name="tags" optional={t.optional}>
            {/* k2b-ui gap: no tags input in v2 yet (#4191); the tags are ticked in a menu. */}
            <Menu
              items={(props.tags ?? []).map((tag) => ({
                label: tag.name,
                checked: selectedTags().includes(tag.id),
                onClick: () =>
                  setSelectedTags((current) => (current.includes(tag.id) ? current.filter((id) => id !== tag.id) : [...current, tag.id])),
              }))}
            >
              {tagNames() || t.selectTags}
            </Menu>
          </Field>
        </Show>
        <Show when={!isEditMode() && !isEvent() && (templateId() !== BLANK_TEMPLATE || checklist().length > 0)}>
          <Field label={t.templateChecklist} name="checklist" hint={t.templateChecklistDescription} optional={t.optional}>
            <Input
              multiline
              value={checklist().join("\n")}
              onInput={(value) =>
                setChecklist(
                  value
                    .split("\n")
                    .map((line) => line.trim())
                    .filter(Boolean),
                )
              }
            />
          </Field>
        </Show>
        <Show when={!isEditMode() && (templateId() !== BLANK_TEMPLATE || assignCreator())}>
          <Check switch label={t.assignMe} checked={assignCreator()} onChange={setAssignCreator} />
        </Show>
        <Field label={t.assignees} name="assignees" hint={t.assigneesDescription} optional={t.optional}>
          <Lookup
            label={t.searchPeople}
            value={assignees().map((person) => person.id)}
            known={assignees().map((person) => ({ value: person.id, label: person.displayName }))}
            load={loadPeople}
            onChange={pickPeople}
          />
        </Field>
      </Show>
      <Show when={error() && error() !== t.titleRequired && error() !== t.validEventUrl}>
        <Notice tone="bad" icon="alert-circle">
          {error()}
        </Notice>
      </Show>
    </Dialog>
  );
}
