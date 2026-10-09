import { mutation as mutations } from "@k2b/stdlib/solid";
import {
  Button,
  IconButton,
  MultiSelectInput,
  NumberInput,
  prompts,
  SegmentedControl,
  Select,
  SettingsCollection,
  SettingsGroup,
  Switch,
  TextInput,
  useLocale,
} from "@k2b/ui";
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { apiClient } from "@/api/client";
import type {
  CreateItemTemplate,
  ItemTemplateKind,
  Priority,
  SpaceItemAssignee,
  SpaceItemTemplate,
  SpaceTag,
  TemplateDateRule,
  TemplateWeekday,
  UpdateItemTemplate,
} from "@/contracts";
import { describeTemplateDateRule, formatTemplateDate, proposeTemplateDates } from "@/presentation/item-templates";
import { weekdayOptions } from "@/presentation/recurrence";
import { useSpaceMessages } from "../../messages";
import { priorityOptions } from "../shared/item-form/options";
import { browserTimeZone } from "../shared/item-form/templates";
import SpaceAssigneePicker from "../shared/SpaceAssigneePicker";
import { readErrorMessage } from "./utils";

type TemplateValue = Omit<CreateItemTemplate, "kind"> & { kind: ItemTemplateKind };
type Editing = { kind: ItemTemplateKind; template?: SpaceItemTemplate };

/** Quarter hours for the time Select; an empty choice keeps the default time. */
const TIMES = Array.from(
  { length: 96 },
  (_, index) => `${String(Math.floor(index / 4)).padStart(2, "0")}:${String((index % 4) * 15).padStart(2, "0")}`,
);

function TemplateForm(props: {
  spaceId: string;
  kind: ItemTemplateKind;
  initial?: SpaceItemTemplate;
  tags: SpaceTag[];
  loading: boolean;
  onCancel: () => void;
  onSave: (value: TemplateValue) => void;
}) {
  const t = useSpaceMessages();
  const locale = useLocale();
  const initial = props.initial;
  const isEvent = props.kind === "event";
  const [name, setName] = createSignal(initial?.name ?? "");
  const [title, setTitle] = createSignal(initial?.title ?? "");
  const [description, setDescription] = createSignal(initial?.description ?? "");
  const [priority, setPriority] = createSignal<string>(initial?.priority ?? "");
  const [tagIds, setTagIds] = createSignal(initial?.tags.map((tag) => tag.id) ?? []);
  const [assignees, setAssignees] = createSignal<SpaceItemAssignee[]>(initial?.assignees ?? []);
  const [assignCreator, setAssignCreator] = createSignal(initial?.assignCreator ?? false);
  const [checklist, setChecklist] = createSignal((initial?.checklist ?? []).join("\n"));
  const [estimate, setEstimate] = createSignal<number | null>(initial?.estimatedDurationMinutes ?? null);
  const [location, setLocation] = createSignal(initial?.location ?? "");
  const [url, setUrl] = createSignal(initial?.url ?? "");
  const [allDay, setAllDay] = createSignal(initial?.allDay ?? false);
  const [duration, setDuration] = createSignal<number | null>(initial?.durationMinutes ?? null);
  const [timeOfDay, setTimeOfDay] = createSignal<string | null>(initial?.timeOfDay ?? null);
  const [ruleType, setRuleType] = createSignal<TemplateDateRule["type"]>(initial?.dateRule.type ?? "none");
  const [weekdays, setWeekdays] = createSignal<TemplateWeekday[]>(initial?.dateRule.type === "weekdays" ? initial.dateRule.weekdays : []);
  const [offsetDays, setOffsetDays] = createSignal<number | null>(initial?.dateRule.type === "offset" ? initial.dateRule.days : 1);
  const [error, setError] = createSignal("");
  /** The text field a placeholder button writes into: the one focused last. */
  let placeholderTarget: "title" | "description" = "title";

  const dateRule = (): TemplateDateRule =>
    ruleType() === "weekdays"
      ? { type: "weekdays", weekdays: weekdays() }
      : ruleType() === "offset"
        ? { type: "offset", days: offsetDays() ?? 0 }
        : { type: "none" };
  const timing = () => ({ kind: props.kind, allDay: isEvent && allDay(), timeOfDay: timeOfDay(), dateRule: dateRule() });
  const preview = createMemo(() => {
    if (ruleType() === "weekdays" && weekdays().length === 0) return t.chooseWeekday;
    const dates = proposeTemplateDates(timing(), {
      now: new Date(),
      timeZone: browserTimeZone(),
    });
    return dates.length ? t.nextProposals({ dates: dates.map((date) => formatTemplateDate(date, locale())).join(", ") }) : t.noProposals;
  });
  const insertPlaceholder = (name: string) => {
    const token = `{{${name}}}`;
    if (placeholderTarget === "description") setDescription((value) => (value ? `${value} ${token}` : token));
    else setTitle((value) => (value ? `${value} ${token}` : token));
  };
  const toggleWeekday = (day: TemplateWeekday) =>
    setWeekdays((current) => (current.includes(day) ? current.filter((value) => value !== day) : [...current, day]));

  const submit = (event: Event) => {
    event.preventDefault();
    setError("");
    if (!name().trim()) return setError(t.nameRequired);
    if (ruleType() === "weekdays" && weekdays().length === 0) return setError(t.chooseWeekday);
    if (isEvent && url().trim()) {
      try {
        new URL(url().trim());
      } catch {
        return setError(t.validEventUrl);
      }
    }
    props.onSave({
      kind: props.kind,
      name: name().trim(),
      title: title(),
      description: description().trim() || null,
      priority: (priority() || null) as Priority | null,
      tagIds: tagIds(),
      assigneeIds: assignees().map((assignee) => assignee.id),
      assignCreator: assignCreator(),
      checklist: isEvent
        ? []
        : checklist()
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean),
      estimatedDurationMinutes: isEvent ? null : estimate(),
      location: isEvent ? location().trim() || null : null,
      url: isEvent ? url().trim() || null : null,
      allDay: isEvent && allDay(),
      durationMinutes: isEvent && !allDay() ? duration() : null,
      timeOfDay: isEvent && allDay() ? null : timeOfDay(),
      dateRule: dateRule(),
    });
  };

  return (
    <form onSubmit={submit} class="spaces-template-form flex flex-col gap-4 py-2">
      <TextInput
        label={t.templateName}
        description={t.templateNameDescription}
        value={name}
        onValueChange={setName}
        maxLength={100}
        required
      />
      <div class="flex flex-col gap-4">
        <div onFocusIn={() => (placeholderTarget = "title")}>
          <TextInput
            label={t.title}
            description={t.templateTitleDescription}
            placeholder={isEvent ? t.eventTitle : t.titlePlaceholder}
            value={title}
            onValueChange={setTitle}
            maxLength={200}
          />
        </div>
        <div onFocusIn={() => (placeholderTarget = "description")}>
          <TextInput label={t.description} value={description} onValueChange={setDescription} multiline lines={3} />
        </div>
        <div class="-mt-2 flex flex-wrap items-center gap-1">
          <span class="text-xs text-dimmed">{t.insertPlaceholder}:</span>
          <For
            each={[
              { name: "date", label: t.placeholderDate },
              { name: "weekday", label: t.placeholderWeekday },
              { name: "week", label: t.placeholderWeek },
            ]}
          >
            {(placeholder) => (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => insertPlaceholder(placeholder.name)}
              >
                {`{{${placeholder.name}}}`} · {placeholder.label}
              </Button>
            )}
          </For>
        </div>
      </div>

      <div class="flex flex-col gap-3">
        <div>
          <p class="mb-1 block text-sm font-medium">{t.templateDates}</p>
          <p class="text-xs text-dimmed">{t.templateDatesDescription}</p>
        </div>
        <SegmentedControl
          ariaLabel={t.templateDates}
          value={ruleType}
          onValueChange={setRuleType}
          options={[
            { value: "none" as const, label: t.dateRuleNone },
            { value: "weekdays" as const, label: t.dateRuleWeekdays },
            { value: "offset" as const, label: t.dateRuleOffset },
          ]}
        />
        <Show when={ruleType() === "weekdays"}>
          <div class="grid grid-cols-7 gap-1" role="group" aria-label={t.dateRuleWeekdays}>
            <For each={weekdayOptions({ locale: locale() })}>
              {(day) => (
                <Button
                  type="button"
                  variant={weekdays().includes(day.id) ? "subtle" : "secondary"}
                  size="sm"
                  aria-label={day.fullLabel}
                  aria-pressed={weekdays().includes(day.id)}
                  class="w-full justify-center px-0"
                  onClick={() => toggleWeekday(day.id)}
                >
                  {day.label}
                </Button>
              )}
            </For>
          </div>
        </Show>
        <Show when={ruleType() === "offset"}>
          <NumberInput
            label={t.offsetDays}
            description={t.offsetDaysDescription}
            value={offsetDays}
            onValueChange={setOffsetDays}
            min={0}
            max={365}
            step={1}
            allowNegative={false}
          />
        </Show>
        <div class="grid grid-cols-1 gap-3 md:grid-cols-2">
          <Show when={!(isEvent && allDay())}>
            <Select
              label={isEvent ? t.startTime : t.dueTime}
              description={isEvent ? t.timeDescriptionEvent : t.timeDescriptionTask}
              icon="ti ti-clock"
              value={timeOfDay}
              onValueChange={setTimeOfDay}
              options={TIMES.map((time) => ({ id: time, label: time }))}
              searchable
              clearable
            />
          </Show>
          <Show when={isEvent && !allDay()}>
            <NumberInput
              label={t.durationMinutes}
              description={t.durationDescription}
              value={duration}
              onValueChange={setDuration}
              min={1}
              step={15}
              suffix="min"
              allowNegative={false}
              clearable
            />
          </Show>
          <Show when={!isEvent}>
            <NumberInput
              label={t.estimatedDuration}
              value={estimate}
              onValueChange={setEstimate}
              min={1}
              step={15}
              suffix="min"
              allowNegative={false}
              clearable
            />
          </Show>
        </div>
        <Show when={isEvent}>
          <Switch label={t.allDayEvent} value={allDay} onValueChange={setAllDay} />
        </Show>
        <p class="text-xs text-dimmed" role="status" aria-live="polite" data-testid="template-proposal-preview">
          {preview()}
        </p>
      </div>

      <Show when={isEvent}>
        <div class="grid grid-cols-1 gap-3 md:grid-cols-2">
          <TextInput label={t.location} icon="ti ti-map-pin" value={location} onValueChange={setLocation} maxLength={500} />
          <TextInput
            label={t.url}
            icon="ti ti-link"
            type="url"
            inputMode="url"
            value={url}
            onValueChange={setUrl}
            placeholder="https://..."
          />
        </div>
      </Show>
      <Show when={!isEvent}>
        <TextInput
          label={t.templateChecklist}
          description={t.templateChecklistDescription}
          value={checklist}
          onValueChange={setChecklist}
          multiline
          lines={3}
        />
      </Show>

      <div class="grid grid-cols-1 gap-3 md:grid-cols-2">
        <Select
          label={t.priority}
          placeholder={t.selectPriority}
          icon="ti ti-flag"
          value={priority}
          onValueChange={(value) => setPriority(value ?? "")}
          options={priorityOptions(locale())}
          clearable
        />
        <Show when={props.tags.length > 0}>
          <MultiSelectInput
            label={t.tags}
            placeholder={t.selectTags}
            searchPlaceholder={t.searchTags}
            icon="ti ti-tags"
            value={tagIds}
            onValueChange={setTagIds}
            options={props.tags.map((tag) => ({ id: tag.id, label: tag.name, color: tag.color }))}
            clearable
          />
        </Show>
      </div>
      <div class="flex flex-col gap-3">
        <p class="text-sm font-medium">{t.assignees}</p>
        <SpaceAssigneePicker spaceId={props.spaceId} value={assignees} onChange={setAssignees} placeholder={t.searchPeople} />
        <Switch label={t.assignMe} description={t.assignMeDescription} value={assignCreator} onValueChange={setAssignCreator} />
      </div>

      <Show when={error()}>
        <p class="flex items-center gap-1 text-sm text-red-500" role="alert">
          <i class="ti ti-alert-circle" aria-hidden="true" />
          {error()}
        </p>
      </Show>
      <div class="flex items-center gap-2">
        <Button type="submit" size="sm" loading={props.loading}>
          <i class="ti ti-check" aria-hidden="true" />
          {initial ? t.save : t.createTemplate}
        </Button>
        <Button type="button" variant="secondary" size="sm" onClick={props.onCancel} disabled={props.loading}>
          {t.cancel}
        </Button>
      </div>
    </form>
  );
}

/** Admin tab for the task and event templates of a Space. */
export function TemplatesSection(props: {
  spaceId: string;
  templates: SpaceItemTemplate[];
  tags: SpaceTag[];
  onWorkspaceChange?: () => void;
  onSettingsChange?: () => Promise<void>;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const t = useSpaceMessages();
  const locale = useLocale();
  const [editing, setEditing] = createSignal<Editing | null>(null);
  createEffect(() => props.onDirtyChange(editing() !== null));
  onCleanup(() => props.onDirtyChange(false));

  const reconcile = () => {
    props.onWorkspaceChange?.();
    void props.onSettingsChange?.().catch((error) => prompts.error(error.message));
  };

  const saveMutation = mutations.create<SpaceItemTemplate, { id?: string; value: TemplateValue }>({
    mutation: async ({ id, value }) => {
      if (id) {
        const { kind: _kind, ...changes } = value;
        const response = await apiClient[":id"].templates[":templateId"].$patch({
          param: { id: props.spaceId, templateId: id },
          json: changes satisfies UpdateItemTemplate,
        });
        if (!response.ok) throw new Error(await readErrorMessage(response, t.updateTemplateFailed));
        return response.json();
      }
      const response = await apiClient[":id"].templates.$post({ param: { id: props.spaceId }, json: value });
      if (!response.ok) throw new Error(await readErrorMessage(response, t.createTemplateFailed));
      return response.json();
    },
    onSuccess: () => {
      setEditing(null);
      reconcile();
    },
    onError: (error) => prompts.error(error.message),
  });

  const deleteMutation = mutations.create<string, SpaceItemTemplate>({
    mutation: async (template) => {
      const response = await apiClient[":id"].templates[":templateId"].$delete({
        param: { id: props.spaceId, templateId: template.id },
      });
      if (!response.ok) throw new Error(await readErrorMessage(response, t.deleteTemplateFailed));
      return template.id;
    },
    onSuccess: (id) => {
      if (editing()?.template?.id === id) setEditing(null);
      reconcile();
    },
    onError: (error) => prompts.error(error.message),
  });
  let deletePromptPending = false;
  const deleteTemplate = async (template: SpaceItemTemplate) => {
    if (deletePromptPending || deleteMutation.loading()) return;
    deletePromptPending = true;
    try {
      const confirmed = await prompts.confirm(t.deleteTemplateConfirm({ name: template.name }), {
        title: t.deleteTemplate,
        icon: "ti ti-trash",
        variant: "danger",
        confirmText: t.delete,
      });
      if (confirmed) void deleteMutation.mutate(template);
    } finally {
      deletePromptPending = false;
    }
  };

  const collection = (kind: ItemTemplateKind) => (
    <SettingsCollection
      title={kind === "task" ? t.taskTemplates : t.eventTemplates}
      description={kind === "task" ? t.taskTemplatesDescription : t.eventTemplatesDescription}
      empty={kind === "task" ? t.noTaskTemplates : t.noEventTemplates}
    >
      <SettingsCollection.Action>
        <Button type="button" size="sm" disabled={editing() !== null} onClick={() => setEditing({ kind })}>
          <i class="ti ti-plus" aria-hidden="true" />
          {kind === "task" ? t.newTaskTemplate : t.newEventTemplate}
        </Button>
      </SettingsCollection.Action>
      <For each={props.templates.filter((template) => template.kind === kind)}>
        {(template) => (
          <SettingsCollection.Item
            title={template.name}
            description={describeTemplateDateRule(template, locale())}
            icon={<i class="ti ti-template text-base text-dimmed" aria-hidden="true" />}
          >
            <SettingsCollection.Item.Actions>
              <IconButton
                label={`${t.editTemplate}: ${template.name}`}
                size="sm"
                title={t.edit}
                disabled={editing() !== null}
                onClick={() => setEditing({ kind, template })}
              >
                <i class="ti ti-pencil" aria-hidden="true" />
              </IconButton>
              <IconButton
                label={`${t.deleteTemplate}: ${template.name}`}
                size="sm"
                title={t.delete}
                disabled={deleteMutation.loading()}
                onClick={() => void deleteTemplate(template)}
              >
                <i class="ti ti-trash" aria-hidden="true" />
              </IconButton>
            </SettingsCollection.Item.Actions>
          </SettingsCollection.Item>
        )}
      </For>
    </SettingsCollection>
  );

  return (
    <>
      <Show when={editing()} keyed>
        {(current) => (
          <SettingsGroup
            title={current.template ? t.editTemplate : current.kind === "task" ? t.newTaskTemplate : t.newEventTemplate}
            description={t.templateFormDescription}
          >
            <TemplateForm
              spaceId={props.spaceId}
              kind={current.kind}
              initial={current.template}
              tags={props.tags}
              loading={saveMutation.loading()}
              onCancel={() => setEditing(null)}
              onSave={(value) => void saveMutation.mutate({ id: current.template?.id, value })}
            />
          </SettingsGroup>
        )}
      </Show>
      {collection("task")}
      {collection("event")}
    </>
  );
}
