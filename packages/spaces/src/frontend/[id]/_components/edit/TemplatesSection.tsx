import type { DateContext } from "@k2b/stdlib";
import { mutation as mutations } from "@k2b/stdlib/solid";
import { useLocale } from "@k2b/ui";
import {
  Bar,
  Button,
  Check,
  Choice,
  confirm,
  Dialog,
  Empty,
  Field,
  Inline,
  Input,
  Lookup,
  Menu,
  Notice,
  Row,
  Section,
  Select,
  Text,
  useToast,
} from "@k2b/ui/v2";
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
import { templateIcon } from "../shared/create-menu";
import { priorityOptions } from "../shared/item-form/options";
import { browserTimeZone } from "../shared/item-form/templates";
import { readErrorMessage } from "./utils";

export type TemplateValue = Omit<CreateItemTemplate, "kind"> & { kind: ItemTemplateKind };
type Editing = { kind: ItemTemplateKind; template?: SpaceItemTemplate };

/** A few icons that fit most templates; the kind's default comes first. */
const ICONS: Record<ItemTemplateKind, readonly string[]> = {
  task: ["ti ti-checkbox", "ti ti-report", "ti ti-package", "ti ti-alert-triangle", "ti ti-truck", "ti ti-users", "ti ti-receipt"],
  event: ["ti ti-calendar-event", "ti ti-users", "ti ti-coffee", "ti ti-truck", "ti ti-presentation", "ti ti-phone", "ti ti-video"],
};

/** What a new template proposes, such as a text in its title that a placeholder could replace. */
export type TemplateSuggestions = {
  /**
   * Text in the title that names one week or date, such as "KW 44", and what would make it fit every one, such as
   * "KW {{week}}"; the template only suggests it, the person decides.
   */
  title?: { text: string; replacement: string; token: "week" | "date" };
  /** The weekday the item was due on, offered as a weekdays rule. */
  weekday?: TemplateWeekday;
  /** Shows what a template made from an item leaves out, and who dropped out for lack of access. */
  fromItem?: { dropped: string[] };
};

/** Quarter hours for the time Select; an empty choice keeps the default time. */
/** Minutes typed into a number field; empty or not a positive number is none. */
const minutes = (value: string): number | null => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

const TIMES = Array.from(
  { length: 96 },
  (_, index) => `${String(Math.floor(index / 4)).padStart(2, "0")}:${String((index % 4) * 15).padStart(2, "0")}`,
);

export function TemplateForm(props: {
  spaceId: string;
  kind: ItemTemplateKind;
  /** The template being edited; without it the form creates one. */
  initial?: SpaceItemTemplate;
  /** Values a new template starts with, such as those of an item saved as a template. */
  draft?: Omit<SpaceItemTemplate, "id" | "spaceId" | "createdAt" | "updatedAt">;
  suggestions?: TemplateSuggestions;
  tags: SpaceTag[];
  timeZone: string;
  loading: boolean;
  /** A save error that keeps the input, such as a lost connection; the button then offers to try again. */
  saveError?: string;
  /** The name is taken; the field says so and stays editable. */
  nameTaken?: boolean;
  onNameInput?: () => void;
  /** The dialog's title, such as "New task template" or "Save as template". */
  title: string;
  /** From the create menu or an item, the dialog points to the settings, where templates are managed. */
  variant?: "settings" | "dialog";
  onCancel: () => void;
  onSave: (value: TemplateValue) => void;
}) {
  const t = useSpaceMessages();
  const locale = useLocale();
  const initial = props.initial ?? props.draft;
  const isEvent = props.kind === "event";
  const [name, setName] = createSignal(initial?.name ?? "");
  const [icon, setIcon] = createSignal<string>(initial?.icon ?? ICONS[props.kind][0]!);
  const iconOptions = () =>
    [...new Set([...(initial?.icon ? [initial.icon] : []), ...ICONS[props.kind]])].map((value) => ({
      value,
      label: value.replace(/^ti ti-/, "").replaceAll("-", " "),
      icon: value,
    }));
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
  const suggested = props.suggestions?.title;
  /** `offered` until the person answers, then whether the placeholder replaced the text. */
  const [titleSuggestion, setTitleSuggestion] = createSignal<"offered" | "replaced" | "kept">("offered");
  const replaceInTitle = () => {
    if (!suggested) return;
    setTitle((value) => value.replace(suggested.text, suggested.replacement));
    setTitleSuggestion("replaced");
  };
  const undoTitle = () => {
    if (!suggested) return;
    setTitle((value) => value.replace(suggested.replacement, suggested.text));
    setTitleSuggestion("kept");
  };
  const suggestedWeekday = props.suggestions?.weekday;
  const [weekdayTaken, setWeekdayTaken] = createSignal(false);
  const weekdayName = () =>
    suggestedWeekday ? (weekdayOptions({ locale: locale() }).find((day) => day.id === suggestedWeekday)?.fullLabel ?? "") : "";
  const takeWeekday = () => {
    if (!suggestedWeekday) return;
    setRuleType("weekdays");
    setWeekdays([suggestedWeekday]);
    setWeekdayTaken(true);
  };
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
    const dates = proposeTemplateDates(timing(), { now: new Date(), timeZone: props.timeZone });
    return dates.length ? t.nextProposals({ dates: dates.map((date) => formatTemplateDate(date, locale())).join(", ") }) : t.noProposals;
  });
  const insertPlaceholder = (name: string) => {
    const token = `{{${name}}}`;
    if (placeholderTarget === "description") setDescription((value) => (value ? `${value} ${token}` : token));
    else setTitle((value) => (value ? `${value} ${token}` : token));
  };
  const toggleWeekday = (day: TemplateWeekday) =>
    setWeekdays((current) => (current.includes(day) ? current.filter((value) => value !== day) : [...current, day]));

  const submit = () => {
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
      icon: icon(),
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

  const loadPeople = async (search: string, context: { signal: AbortSignal; limit: number }) => {
    const response = await apiClient[":id"]["assignable-users"].$get(
      { param: { id: props.spaceId }, query: { search } },
      { init: { signal: context.signal } },
    );
    if (!response.ok) throw new Error(await readErrorMessage(response, t.loadAssigneesFailed));
    const users = await response.json();
    peopleSeen.push(...users);
    return { items: users.slice(0, context.limit).map((user) => ({ value: user.id, label: user.displayName })) };
  };
  /** People the lookup offered, so a pick keeps the name and kind the template stores. */
  const peopleSeen: SpaceItemAssignee[] = [];
  const pickPeople = (ids: string[]) =>
    setAssignees(
      ids.flatMap((id) => {
        const known = assignees().find((person) => person.id === id) ?? peopleSeen.find((person) => person.id === id);
        return known ? [known] : [];
      }),
    );
  const tagNames = () =>
    tagIds()
      .map((id) => props.tags.find((tag) => tag.id === id)?.name)
      .filter(Boolean)
      .join(", ");

  return (
    <Dialog
      title={props.title}
      open
      onOpenChange={(open) => !open && props.onCancel()}
      foot={
        <>
          <Button onClick={props.onCancel} disabled={props.loading}>
            {t.cancel}
          </Button>
          <Button variant="primary" busy={props.loading} onClick={submit}>
            {props.saveError ? t.retry : props.initial ? t.save : props.variant === "dialog" ? t.saveTemplate : t.createTemplate}
          </Button>
        </>
      }
    >
      <Field
        label={t.templateName}
        name="template-name"
        hint={t.templateNameDescription}
        error={props.nameTaken ? t.templateNameTaken : undefined}
        required
      >
        <Input
          value={name()}
          onInput={(value) => {
            setName(value);
            props.onNameInput?.();
          }}
        />
      </Field>
      <Field label={t.templateIcon} name="template-icon">
        <Select value={icon()} options={iconOptions().map((option) => ({ value: option.value, label: option.label }))} onChange={setIcon} />
      </Field>
      <Field label={t.title} name="template-title" hint={t.templateTitleDescription} optional={t.optional}>
        <Input
          value={title()}
          placeholder={isEvent ? t.eventTitle : t.titlePlaceholder}
          onInput={(value) => {
            setTitle(value);
            placeholderTarget = "title";
          }}
        />
      </Field>
      <Show when={suggested}>
        {(found) => (
          <Notice
            tone="ai"
            icon="sparkles"
            actions={
              titleSuggestion() === "offered"
                ? [{ label: t.templateSuggestReplace, onClick: replaceInTitle }]
                : titleSuggestion() === "replaced"
                  ? [{ label: t.templateSuggestUndo, onClick: undoTitle }]
                  : undefined
            }
          >
            {titleSuggestion() === "offered"
              ? found().token === "week"
                ? t.templateSuggestWeek({ text: found().text })
                : t.templateSuggestDate({ text: found().text })
              : titleSuggestion() === "replaced"
                ? t.templateSuggestReplaced
                : t.templateSuggestKept({ text: found().text })}
          </Notice>
        )}
      </Show>
      <Field label={t.description} name="template-description" optional={t.optional}>
        <Input
          multiline
          value={description()}
          onInput={(value) => {
            setDescription(value);
            placeholderTarget = "description";
          }}
        />
      </Field>
      <Bar
        start={<Text type="meta">{t.insertPlaceholder}</Text>}
        end={
          <For
            each={[
              { name: "date", label: t.placeholderDate },
              { name: "weekday", label: t.placeholderWeekday },
              { name: "week", label: t.placeholderWeek },
            ]}
          >
            {(placeholder) => (
              <Button variant="text" title={`{{${placeholder.name}}}`} onClick={() => insertPlaceholder(placeholder.name)}>
                {placeholder.label}
              </Button>
            )}
          </For>
        }
      />
      <Field label={t.templateDates} name="template-dates" hint={t.templateDatesDescription}>
        <Choice
          name="template-dates"
          value={ruleType()}
          options={[
            { value: "none", label: t.dateRuleNone },
            { value: "weekdays", label: t.dateRuleWeekdays },
            { value: "offset", label: t.dateRuleOffset },
          ]}
          onChange={(value) => {
            const next = (["none", "weekdays", "offset"] as const).find((entry) => entry === value);
            if (next) setRuleType(next);
          }}
        />
      </Field>
      <Show when={suggestedWeekday && weekdayName()}>
        <Notice tone="ai" icon="sparkles" actions={weekdayTaken() ? undefined : [{ label: t.templateSuggestYes, onClick: takeWeekday }]}>
          {weekdayTaken() ? t.templateSuggestWeekdayDone({ day: weekdayName() }) : t.templateSuggestWeekday({ day: weekdayName() })}
        </Notice>
      </Show>
      <Show when={ruleType() === "weekdays"}>
        <Bar
          start={
            <Inline>
              <For each={weekdayOptions({ locale: locale() })}>
                {(day) => (
                  <Button pressed={weekdays().includes(day.id)} title={day.fullLabel} onClick={() => toggleWeekday(day.id)}>
                    {day.label}
                  </Button>
                )}
              </For>
            </Inline>
          }
        />
      </Show>
      <Show when={ruleType() === "offset"}>
        <Field label={t.offsetDays} name="template-offset" hint={t.offsetDaysDescription}>
          <Input
            type="number"
            min={0}
            max={365}
            value={offsetDays() === null ? "" : String(offsetDays())}
            onInput={(value) => setOffsetDays(value === "" ? null : Math.max(0, Math.min(365, Number.parseInt(value, 10) || 0)))}
          />
        </Field>
      </Show>
      <Show when={isEvent}>
        <Check switch label={t.allDayEvent} checked={allDay()} onChange={setAllDay} />
      </Show>
      <Field.Row>
        <Show when={!(isEvent && allDay())}>
          <Field
            label={isEvent ? t.startTime : t.dueTime}
            name="template-time"
            hint={isEvent ? t.timeDescriptionEvent : t.timeDescriptionTask}
          >
            <Select
              value={timeOfDay() ?? ""}
              options={[{ value: "", label: t.noTime }, ...TIMES.map((time) => ({ value: time, label: time }))]}
              onChange={(value) => setTimeOfDay(value || null)}
            />
          </Field>
        </Show>
        <Show when={isEvent && !allDay()}>
          <Field label={t.durationMinutes} name="template-duration" hint={t.durationDescription} optional="min">
            <Input
              type="number"
              min={1}
              value={duration() === null ? "" : String(duration())}
              onInput={(value) => setDuration(minutes(value))}
            />
          </Field>
        </Show>
        <Show when={!isEvent}>
          <Field label={t.estimatedDuration} name="template-estimate" optional="min">
            <Input
              type="number"
              min={1}
              value={estimate() === null ? "" : String(estimate())}
              onInput={(value) => setEstimate(minutes(value))}
            />
          </Field>
        </Show>
      </Field.Row>
      <Text type="meta">{preview()}</Text>
      <Show when={isEvent}>
        <Field.Row>
          <Field label={t.location} name="template-location" optional={t.optional}>
            <Input value={location()} onInput={setLocation} />
          </Field>
          <Field label={t.url} name="template-url" optional={t.optional}>
            <Input type="url" value={url()} placeholder="https://" onInput={setUrl} />
          </Field>
        </Field.Row>
      </Show>
      <Show when={!isEvent}>
        <Field label={t.templateChecklist} name="template-checklist" hint={t.templateChecklistDescription} optional={t.optional}>
          <Input multiline value={checklist()} onInput={setChecklist} />
        </Field>
      </Show>
      <Field label={t.priority} name="template-priority" optional={t.optional}>
        <Select
          value={priority()}
          placeholder={t.selectPriority}
          options={[
            { value: "", label: t.noPriority },
            ...priorityOptions(locale()).map((option) => ({ value: option.id, label: option.label })),
          ]}
          onChange={setPriority}
        />
      </Field>
      <Show when={props.tags.length > 0}>
        <Field label={t.tags} name="template-tags" optional={t.optional}>
          {/* k2b-ui gap: no tags input in v2 yet (#4191); the tags are ticked in a menu. */}
          <Menu
            items={props.tags.map((tag) => ({
              label: tag.name,
              checked: tagIds().includes(tag.id),
              onClick: () =>
                setTagIds((current) => (current.includes(tag.id) ? current.filter((id) => id !== tag.id) : [...current, tag.id])),
            }))}
          >
            {tagNames() || t.selectTags}
          </Menu>
        </Field>
      </Show>
      <Field label={t.assignees} name="template-assignees" optional={t.optional}>
        <Lookup
          label={t.searchPeople}
          value={assignees().map((person) => person.id)}
          known={assignees().map((person) => ({ value: person.id, label: person.displayName }))}
          load={loadPeople}
          onChange={pickPeople}
        />
      </Field>
      <Check switch label={t.assignMe} checked={assignCreator()} onChange={setAssignCreator} />
      <Text type="meta">{t.assignMeDescription}</Text>
      <Show when={props.suggestions?.fromItem}>
        {(fromItem) => (
          <Notice tone="note">
            {fromItem().dropped.length
              ? `${t.templateNotCopied} ${t.templateAssigneesDropped({ names: fromItem().dropped.join(", ") })}`
              : t.templateNotCopied}
          </Notice>
        )}
      </Show>
      <Show when={props.variant === "dialog"}>
        <Text type="meta">{t.templateManageInSettings}</Text>
      </Show>
      <Show when={error() || props.saveError}>
        <Notice tone="bad" icon="alert-circle">
          {error() || props.saveError}
        </Notice>
      </Show>
    </Dialog>
  );
}

/** Settings tab for the task and event templates of a Space; everyone who writes may change them. */
export function TemplatesSection(props: {
  spaceId: string;
  templates: SpaceItemTemplate[];
  tags: SpaceTag[];
  dateConfig?: DateContext;
  onWorkspaceChange?: () => void;
  onSettingsChange?: () => Promise<void>;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const t = useSpaceMessages();
  const toast = useToast();
  const locale = useLocale();
  const [editing, setEditing] = createSignal<Editing | null>(null);
  createEffect(() => props.onDirtyChange(editing() !== null));
  onCleanup(() => props.onDirtyChange(false));

  const reconcile = () => {
    props.onWorkspaceChange?.();
    void props.onSettingsChange?.().catch((error) => toast(error.message, { status: "bad" }));
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
    onError: (error) => toast(error.message, { status: "bad" }),
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
    onError: (error) => toast(error.message, { status: "bad" }),
  });
  let deletePromptPending = false;
  const deleteTemplate = async (template: SpaceItemTemplate) => {
    if (deletePromptPending || deleteMutation.loading()) return;
    deletePromptPending = true;
    try {
      const confirmed = await confirm({
        title: t.deleteTemplate,
        description: t.deleteTemplateConfirm({ name: template.name }),
        confirm: t.delete,
      });
      if (confirmed) void deleteMutation.mutate(template);
    } finally {
      deletePromptPending = false;
    }
  };

  const collection = (kind: ItemTemplateKind) => {
    const list = () => props.templates.filter((template) => template.kind === kind);
    return (
      <Section
        icon={kind === "task" ? "checkbox" : "calendar-event"}
        title={kind === "task" ? t.taskTemplates : t.eventTemplates}
        summary={kind === "task" ? t.taskTemplatesDescription : t.eventTemplatesDescription}
        count={list().length}
        actions={[
          {
            label: kind === "task" ? t.newTaskTemplate : t.newEventTemplate,
            icon: "plus",
            disabled: editing() !== null,
            onClick: () => setEditing({ kind }),
          },
        ]}
      >
        <Show when={list().length > 0} fallback={<Empty icon="template" text={kind === "task" ? t.noTaskTemplates : t.noEventTemplates} />}>
          <For each={list()}>
            {(template) => (
              <Row
                icon={templateIcon(template).replace(/^ti\s+ti-/, "")}
                lines={[template.name, describeTemplateDateRule(template, locale())]}
                end={
                  <Menu
                    label={t.moreActionsFor({ label: template.name })}
                    items={[
                      {
                        label: t.editTemplate,
                        icon: "pencil",
                        disabled: editing() !== null,
                        onClick: () => setEditing({ kind, template }),
                      },
                      {
                        label: t.deleteTemplate,
                        icon: "trash",
                        danger: true,
                        disabled: deleteMutation.loading(),
                        onClick: () => void deleteTemplate(template),
                      },
                    ]}
                  />
                }
              />
            )}
          </For>
        </Show>
      </Section>
    );
  };

  return (
    <>
      {collection("task")}
      {collection("event")}
      <Show when={editing()} keyed>
        {(current) => (
          <TemplateForm
            title={current.template ? t.editTemplate : current.kind === "task" ? t.newTaskTemplate : t.newEventTemplate}
            spaceId={props.spaceId}
            kind={current.kind}
            initial={current.template}
            tags={props.tags}
            timeZone={props.dateConfig?.timeZone ?? browserTimeZone()}
            loading={saveMutation.loading()}
            onCancel={() => setEditing(null)}
            onSave={(value) => void saveMutation.mutate({ id: current.template?.id, value })}
          />
        )}
      </Show>
    </>
  );
}
