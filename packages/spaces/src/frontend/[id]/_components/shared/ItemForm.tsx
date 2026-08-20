import {
  Button,
  CheckboxCard,
  DatePicker,
  DateRangePicker,
  DateTimePicker,
  MultiSelectInput,
  NumberInput,
  PanelDialog,
  SegmentedControl,
  Select,
  Switch,
  TextInput,
} from "@k2b/ui";
import { createSignal, For, Show } from "solid-js";
import type { SpaceItemAssignee } from "@/contracts";
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
import { PRIORITY_OPTIONS } from "./item-form/options";
import type { ItemFormProps, ItemType, Priority } from "./item-form/types";
import SpaceAssigneePicker from "./SpaceAssigneePicker";

export type { ItemFormData } from "./item-form/types";

/**
 * Unified form for creating and editing items.
 * - Create mode: item is undefined, shows type selector and tags
 * - Edit mode: item is provided, type is fixed based on existing data
 */
export default function ItemForm(props: ItemFormProps) {
  const isEditMode = () => !!props.item;
  const initialIsEvent = () => Boolean(props.item?.startsAt && props.item?.endsAt);
  const dateTimeInitial = (value?: string | null) => (props.dateConfig?.timeZone ? (value ?? "") : (value?.slice(0, 16) ?? ""));

  // Form state
  const [title, setTitle] = createSignal(props.item?.title ?? "");
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
  const [showFullEditor, setShowFullEditor] = createSignal(!props.quickCreate || isEditMode() || itemType() !== "event");
  const [showQuickDescription, setShowQuickDescription] = createSignal(Boolean(description()));
  const [showQuickEventDetails, setShowQuickEventDetails] = createSignal(Boolean(location() || url()));

  const isEvent = () => itemType() === "event";
  const defaultTitle = () => (isEditMode() ? (isEvent() ? "Edit event" : "Edit task") : isEvent() ? "New event" : "New task");
  const defaultSubmitLabel = () => (isEditMode() ? (isEvent() ? "Save Event" : "Save Task") : isEvent() ? "Create Event" : "Create Task");
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
  const quickCreate = () => props.quickCreate && !isEditMode() && isEvent() && !showFullEditor();
  const quickRecurrenceValue = () => {
    if (!recurrenceEnabled()) return "never";
    if (
      recurrenceInterval() === 1 &&
      recurrenceByDay().length === 0 &&
      recurrenceEndMode() === "never" &&
      !recurrenceUntil() &&
      !recurrenceCount()
    ) {
      return recurrenceFrequency();
    }
    return "custom";
  };
  const quickRecurrenceOptions = [
    { id: "never", label: "Does not repeat", icon: "ti ti-calendar-off" },
    ...recurrenceFrequencyOptions,
    { id: "custom", label: "Custom…", icon: "ti ti-adjustments" },
  ];

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

  const handleQuickRecurrenceChange = (value: string | null) => {
    if (!value || value === "never") {
      handleRecurrenceEnabled(false);
      return;
    }
    handleRecurrenceEnabled(true);
    if (value === "custom") {
      setShowFullEditor(true);
      return;
    }
    setRecurrenceFrequency(value as RecurrenceFrequency);
    setRecurrenceInterval(1);
    setRecurrenceByDay([]);
    setRecurrenceEndMode("never");
    setRecurrenceUntil("");
    setRecurrenceCount(null);
  };

  const handleTypeChange = (type: ItemType) => {
    setItemType(type);
    if (type === "task") {
      setStartsAt("");
      setEndsAt("");
    } else {
      setDeadline("");
      setEstimatedDurationMinutes(null);
    }
  };

  const handleAllDayChange = (enabled: boolean) => {
    if (enabled === allDay()) return;
    if (enabled) {
      const nextRange = dateOnlyRange(startsAt(), endsAt(), props.dateConfig);
      setStartsAt(nextRange.start ?? "");
      setEndsAt(nextRange.end ?? nextRange.start ?? "");
    } else if (startsAt()) {
      const start = instantFromLocalDateTime(datePart(startsAt(), props.dateConfig), "09:00", props.dateConfig);
      const end = instantFromLocalDateTime(datePart(endsAt() || startsAt(), props.dateConfig), "10:00", props.dateConfig);
      setStartsAt(start);
      setEndsAt(end);
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

  const handleSubmit = (e: Event) => {
    e.preventDefault();
    setError("");

    if (!title().trim()) {
      setError("Title is required");
      return;
    }

    if (!isEvent() && !columnId()) {
      setError("Please select a status");
      return;
    }

    const eventStartsAt = submitEventStart();
    const eventEndsAt = submitEventEnd();

    if (isEvent()) {
      if (!eventStartsAt || !eventEndsAt) {
        setError("Events require both start and end time");
        return;
      }
      if (new Date(eventEndsAt) <= new Date(eventStartsAt)) {
        setError("End time must be after start time");
        return;
      }
      if (url().trim()) {
        try {
          new URL(url().trim());
        } catch {
          setError("Event URL must be a valid URL");
          return;
        }
      }
    }

    props.onSubmit({
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
    });
  };

  return (
    <PanelDialog>
      <form onSubmit={handleSubmit} class="flex min-h-0 flex-1 flex-col overflow-hidden">
        <PanelDialog.Header title={props.title ?? defaultTitle()} icon={props.icon ?? "ti ti-pencil"} close={props.onCancel} />
        <PanelDialog.Body>
          <Show
            when={quickCreate()}
            fallback={
              <>
                <PanelDialog.Section title="General" subtitle="Core details and timing." icon="ti ti-info-circle">
                  <Show when={!isEditMode() && !props.quickCreate}>
                    <div>
                      <p class="mb-1 block text-sm font-medium">Type</p>
                      <p class="mb-2 text-xs text-dimmed">Tasks have a deadline, events have a start and end time</p>
                      <SegmentedControl
                        options={[
                          { value: "task" as const, label: "Task", icon: "ti ti-checkbox" },
                          {
                            value: "event" as const,
                            label: "Event",
                            icon: "ti ti-calendar-event",
                          },
                        ]}
                        value={itemType}
                        onValueChange={handleTypeChange}
                      />
                    </div>
                  </Show>
                  <TextInput
                    label="Title"
                    description={!isEditMode() ? "A short summary of what needs to be done" : undefined}
                    placeholder="What needs to be done?"
                    icon="ti ti-text-caption"
                    value={title}
                    onValueChange={(v) => {
                      setTitle(v);
                      setError("");
                    }}
                    required
                  />
                  <TextInput
                    label="Description"
                    description={!isEditMode() ? "Optional details or notes" : undefined}
                    placeholder="Description in markdown ..."
                    value={description}
                    onValueChange={setDescription}
                    markdown
                  />
                  <Show when={!isEvent()}>
                    <div class="grid grid-cols-1 gap-3 md:grid-cols-2">
                      <DateTimePicker
                        label="Deadline"
                        description={!isEditMode() ? "When should this be completed?" : undefined}
                        value={() => deadline() || null}
                        onValueChange={(value) => setDeadline(value ?? "")}
                        dateConfig={props.dateConfig}
                        presets={deadlinePresets(props.dateConfig)}
                        clearable
                      />
                      <NumberInput
                        label="Estimated duration"
                        description={!isEditMode() ? "Planning estimate in minutes" : undefined}
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
                      label="Schedule"
                      description={
                        !isEditMode() ? (allDay() ? "Calendar days for the event" : "Start and end time for the event") : undefined
                      }
                      value={eventRange}
                      onValueChange={(value) => {
                        setStartsAt(value.start ?? "");
                        setEndsAt(value.end ?? "");
                        setError("");
                      }}
                      dateConfig={props.dateConfig}
                      datePresets={scheduleDatePresets(props.dateConfig)}
                      durationPresets={allDay() ? undefined : EVENT_DURATION_PRESETS}
                      required
                      clearable
                    />
                    <CheckboxCard
                      label="All-day event"
                      description="Use dates only and show the event in the all-day calendar row"
                      icon="ti ti-calendar"
                      variant="input"
                      value={allDay}
                      onValueChange={handleAllDayChange}
                    />
                  </Show>
                </PanelDialog.Section>

                <Show when={isEvent()}>
                  <PanelDialog.Section title="Repeat" subtitle="Optional recurring event series." icon="ti ti-repeat">
                    <CheckboxCard
                      label="Repeat event"
                      description="Create a recurring event series"
                      icon="ti ti-repeat"
                      variant="input"
                      value={recurrenceEnabled}
                      onValueChange={handleRecurrenceEnabled}
                    />
                    <Show when={recurrenceEnabled()}>
                      <div class="grid grid-cols-1 gap-3 md:grid-cols-2">
                        <Select
                          label="Frequency"
                          description={!isEditMode() ? "Repeat cadence" : undefined}
                          icon="ti ti-repeat"
                          value={recurrenceFrequency}
                          onValueChange={(value) => value && setRecurrenceFrequency(value as RecurrenceFrequency)}
                          options={recurrenceFrequencyOptions}
                        />
                        <NumberInput
                          label="Every"
                          description={!isEditMode() ? "Interval between repeats" : undefined}
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
                          <p class="mb-1 block text-sm font-medium">Weekdays</p>
                          <p class="mb-2 text-xs text-dimmed">Leave empty to use the event start weekday</p>
                          <div class="grid grid-cols-7 gap-1">
                            <For each={weekdayOptions}>
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
                          label="Ends"
                          description={!isEditMode() ? "Limit the series when needed" : undefined}
                          icon="ti ti-calendar-due"
                          value={recurrenceEndMode}
                          onValueChange={(value) => value && setRecurrenceEndMode(value as RecurrenceEndMode)}
                          options={recurrenceEndOptions}
                        />
                        <Show when={recurrenceEndMode() === "on"}>
                          <DatePicker
                            label="Until"
                            description={!isEditMode() ? "Last date that may contain an occurrence" : undefined}
                            value={() => recurrenceUntil() || null}
                            onValueChange={(value) => setRecurrenceUntil(value ?? "")}
                            dateConfig={props.dateConfig}
                            clearable
                          />
                        </Show>
                        <Show when={recurrenceEndMode() === "after"}>
                          <NumberInput
                            label="Occurrences"
                            description={!isEditMode() ? "Maximum number of generated events" : undefined}
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
                  <PanelDialog.Section
                    title="Event details"
                    subtitle="Location and external reference for calendar subscriptions."
                    icon="ti ti-map-pin"
                  >
                    <div class="grid grid-cols-1 gap-3 md:grid-cols-2">
                      <TextInput
                        label="Location"
                        description={!isEditMode() ? "Where does it happen?" : undefined}
                        placeholder="Office, meeting room, or address"
                        icon="ti ti-map-pin"
                        value={location}
                        onValueChange={setLocation}
                      />
                      <TextInput
                        label="URL"
                        description={!isEditMode() ? "Meeting link or reference" : undefined}
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

                <PanelDialog.Section title="Organize" subtitle="Workflow, priority, tags, and ownership." icon="ti ti-tags">
                  <div class="grid grid-cols-1 gap-3 md:grid-cols-2">
                    <Select
                      label="Status"
                      description={!isEditMode() ? "Current workflow state" : undefined}
                      placeholder="Select column"
                      icon="ti ti-progress"
                      value={columnId}
                      onValueChange={(value) => value && setColumnId(value)}
                      options={columnOptions()}
                      required={!isEvent()}
                    />
                    <Select
                      label="Priority"
                      description={!isEditMode() ? "How urgent is this?" : undefined}
                      placeholder="Select priority"
                      icon="ti ti-flag"
                      value={priority}
                      onValueChange={(value) => setPriority(value ?? "")}
                      options={PRIORITY_OPTIONS}
                      clearable
                    />
                  </div>
                  <Show when={props.tags && props.tags.length > 0}>
                    <MultiSelectInput
                      label="Tags"
                      description={!isEditMode() ? "Categorize with tags" : undefined}
                      placeholder="Select tags"
                      searchPlaceholder="Search tags..."
                      icon="ti ti-tags"
                      value={selectedTags}
                      onValueChange={setSelectedTags}
                      options={(props.tags ?? []).map((tag) => ({ id: tag.id, label: tag.name, color: tag.color }))}
                      clearable
                    />
                  </Show>

                  <div class="flex flex-col gap-3">
                    <div>
                      <p class="mb-1 block text-sm font-medium">Assignees</p>
                      <p class="text-xs text-dimmed">Assign initial owners or leave unassigned</p>
                    </div>
                    <SpaceAssigneePicker
                      spaceId={props.spaceId}
                      value={assignees}
                      onChange={(next) => setAssignees(next)}
                      placeholder="Search people with access..."
                    />
                  </div>
                </PanelDialog.Section>
              </>
            }
          >
            <div class="flex flex-col gap-5">
              <TextInput
                label="Title"
                placeholder="Event title"
                icon="ti ti-text-caption"
                value={title}
                onValueChange={(value) => {
                  setTitle(value);
                  setError("");
                }}
                autofocus
                required
              />

              <DateRangePicker
                withTime={!allDay()}
                label="Schedule"
                description={allDay() ? "Calendar days for the event" : "Start and end time"}
                value={eventRange}
                onValueChange={(value) => {
                  setStartsAt(value.start ?? "");
                  setEndsAt(value.end ?? "");
                  setError("");
                }}
                dateConfig={props.dateConfig}
                datePresets={scheduleDatePresets(props.dateConfig)}
                durationPresets={allDay() ? undefined : EVENT_DURATION_PRESETS}
                required
                clearable
              />

              <Switch label="All-day event" value={allDay} onValueChange={handleAllDayChange} />

              <Select
                label="Repeat"
                icon="ti ti-repeat"
                value={quickRecurrenceValue}
                onValueChange={handleQuickRecurrenceChange}
                options={quickRecurrenceOptions}
              />

              <Show when={recurrenceEnabled()}>
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

              <Show when={showQuickDescription()}>
                <TextInput
                  label="Description"
                  placeholder="Description in markdown ..."
                  value={description}
                  onValueChange={setDescription}
                  markdown
                />
              </Show>

              <Show when={showQuickEventDetails()}>
                <div class="grid grid-cols-1 gap-3 md:grid-cols-2">
                  <TextInput
                    label="Location"
                    placeholder="Office, meeting room, or address"
                    icon="ti ti-map-pin"
                    value={location}
                    onValueChange={setLocation}
                  />
                  <TextInput
                    label="URL"
                    placeholder="https://..."
                    icon="ti ti-link"
                    type="url"
                    inputMode="url"
                    value={url}
                    onValueChange={(value) => {
                      setUrl(value);
                      setError("");
                    }}
                  />
                </div>
              </Show>

              <div class="flex flex-wrap items-center gap-1">
                <Show when={!showQuickDescription()}>
                  <Button type="button" variant="ghost" size="sm" onClick={() => setShowQuickDescription(true)}>
                    <i class="ti ti-align-left" aria-hidden="true" />
                    Add description
                  </Button>
                </Show>
                <Show when={!showQuickEventDetails()}>
                  <Button type="button" variant="ghost" size="sm" onClick={() => setShowQuickEventDetails(true)}>
                    <i class="ti ti-map-pin" aria-hidden="true" />
                    Add location or link
                  </Button>
                </Show>
              </div>
            </div>
          </Show>

          <Show when={error()}>
            <div class="flex items-center gap-1 text-sm text-red-500">
              <i class="ti ti-alert-circle" />
              {error()}
            </div>
          </Show>
        </PanelDialog.Body>

        <PanelDialog.Footer>
          <Show when={quickCreate()}>
            <Button type="button" variant="ghost" size="sm" onClick={() => setShowFullEditor(true)}>
              More options
            </Button>
          </Show>
          <div class="ml-auto flex items-center gap-2">
            <Button type="button" variant="secondary" size="sm" onClick={props.onCancel}>
              Cancel
            </Button>
            <Button type="submit" size="sm">
              {props.submitLabel ?? defaultSubmitLabel()}
            </Button>
          </div>
        </PanelDialog.Footer>
      </form>
    </PanelDialog>
  );
}
