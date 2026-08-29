import { Button, IconButton, NoticeCard, Placeholder, prompts, Select, Tag, Tooltip, useLocale } from "@k2b/ui";
import { createMemo, createSignal, Index, Show } from "solid-js";
import type { PublicField as Field } from "../../../api/public-dto";
import type { FormFieldEntry } from "../../../service/forms";
import { isRecordInputField } from "../fields/field-render";
import { fieldTypeIcon, fieldTypeLabel } from "../fields/field-type-meta";
import { FormFieldInspector, openFormFieldSettingsDialog } from "./FormFieldSettings";
import { gridsFormMessages } from "./messages";

const canBeFormInput = (field: Field) => isRecordInputField(field.type);

export function FormFieldsEditor(props: {
  tableFields: Field[];
  entries: () => FormFieldEntry[];
  setEntries: (next: FormFieldEntry[]) => void;
}) {
  const locale = useLocale();
  const t = () => gridsFormMessages.resolve([locale()]).t;
  const [selectedEntryIndex, setSelectedEntryIndex] = createSignal(0);
  const includedIds = createMemo(() => new Set(props.entries().map((entry) => entry.fieldId)));
  const addable = createMemo(() =>
    props.tableFields.filter((field) => !field.deletedAt && canBeFormInput(field) && !includedIds().has(field.id)),
  );
  const fieldById = createMemo(() => new Map(props.tableFields.map((field) => [field.id, field])));
  const selectedIndex = createMemo(() => Math.min(selectedEntryIndex(), Math.max(props.entries().length - 1, 0)));
  const selectedEntry = createMemo(() => props.entries()[selectedIndex()] ?? null);
  const selectedField = createMemo(() => {
    const entry = selectedEntry();
    return entry ? fieldById().get(entry.fieldId) : undefined;
  });

  const replaceEntries = (next: FormFieldEntry[]) => {
    props.setEntries(next);
  };

  const addEntry = async (fieldId: string) => {
    const field = fieldById().get(fieldId);
    if (!field) return;
    const kind = await chooseFormFieldEntryKind(field, locale());
    if (!kind) return;
    replaceEntries([
      ...props.entries(),
      kind === "form_value" ? { kind: "form_value", fieldId, value: null } : { kind: "user_input", fieldId, required: field.required },
    ]);
    setSelectedEntryIndex(props.entries().length);
  };

  const removeEntry = (index: number) => {
    replaceEntries(props.entries().filter((_, i) => i !== index));
    setSelectedEntryIndex(Math.max(0, Math.min(index, props.entries().length - 2)));
  };

  const updateEntry = (index: number, patch: Partial<Extract<FormFieldEntry, { kind: "user_input" }>>) => {
    replaceEntries(
      props.entries().map((entry, i) => {
        if (i !== index || entry.kind !== "user_input") return entry;
        return { ...entry, ...patch };
      }),
    );
  };

  const updateFormValue = (index: number, value: unknown) => {
    replaceEntries(
      props.entries().map((entry, i) => {
        if (i !== index || entry.kind !== "form_value") return entry;
        return { ...entry, value };
      }),
    );
  };

  const moveEntry = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= props.entries().length) return;
    const next = [...props.entries()];
    [next[index], next[target]] = [next[target]!, next[index]!];
    replaceEntries(next);
    setSelectedEntryIndex(target);
  };

  const openFieldSettings = async (index: number) => {
    const entry = props.entries()[index];
    const field = entry ? fieldById().get(entry.fieldId) : undefined;
    if (!entry || !field) return;
    const next = await openFormFieldSettingsDialog({ entry, field });
    if (!next) return;
    replaceEntries(props.entries().map((current, i) => (i === index ? next : current)));
    setSelectedEntryIndex(index);
  };

  return (
    <div class="grid min-h-[28rem] grid-cols-1 gap-3 md:grid-cols-2">
      <div class="flex min-h-0 flex-col gap-3">
        <div class="flex items-center justify-between gap-2">
          <div>
            <p class="text-sm font-semibold text-primary">{t().formFields}</p>
            <p class="text-[11px] text-dimmed">{t().formFieldsDescription}</p>
          </div>
          <span class="text-[10px] text-dimmed">{props.entries().length}</span>
        </div>
        <Show
          when={props.entries().length > 0}
          fallback={<Placeholder surface="paper" align="left" class="p-3" description={<>{t().noFields}</>} />}
        >
          <ul class="flex min-h-0 flex-col gap-1 overflow-y-auto">
            <Index each={props.entries()}>
              {(entry, idx) => {
                const field = () => fieldById().get(entry().fieldId);
                const selected = () => selectedIndex() === idx;
                return (
                  <li>
                    <div
                      class={`paper flex w-full items-center gap-2 px-2 py-2 text-left transition-colors ${
                        selected() ? "app-accent-border app-accent-text bg-[var(--ui-selected)]" : "hover:paper-highlighted"
                      }`}
                    >
                      <button
                        type="button"
                        class="flex min-w-0 flex-1 items-center gap-2 text-left"
                        onClick={() => setSelectedEntryIndex(idx)}
                      >
                        <Show when={field()} fallback={<i class="ti ti-alert-triangle text-dimmed" />}>
                          {(f) => <i class={`${fieldTypeIcon(f().type, f().icon)} shrink-0 text-dimmed`} />}
                        </Show>
                        <span class="min-w-0 flex-1">
                          <span class="block truncate text-sm font-medium text-primary">{field()?.name ?? t().missingField}</span>
                          <span class="block truncate text-[10px] text-dimmed">
                            {entry().kind === "form_value" ? t().fixedValue : fieldTypeLabel(field()?.type ?? "text", locale())}
                          </span>
                        </span>
                      </button>
                      <Show when={entry().kind === "form_value"}>
                        <Tag size="sm">{t().fixed}</Tag>
                      </Show>
                      <Show when={entry().kind === "user_input" && (entry() as Extract<FormFieldEntry, { kind: "user_input" }>).required}>
                        <Tag size="sm">{t().required}</Tag>
                      </Show>
                      <div class="flex shrink-0 items-center gap-0.5">
                        <Tooltip.Anchor content={t().moveFieldUp}>
                          <IconButton
                            variant="ghost"
                            size="sm"
                            type="button"
                            onClick={() => moveEntry(idx, -1)}
                            disabled={idx === 0}
                            label={t().moveFieldUp}
                          >
                            <i class="ti ti-arrow-up" />
                          </IconButton>
                        </Tooltip.Anchor>
                        <Tooltip.Anchor content={t().moveFieldDown}>
                          <IconButton
                            variant="ghost"
                            size="sm"
                            type="button"
                            onClick={() => moveEntry(idx, 1)}
                            disabled={idx === props.entries().length - 1}
                            label={t().moveFieldDown}
                          >
                            <i class="ti ti-arrow-down" />
                          </IconButton>
                        </Tooltip.Anchor>
                        <Tooltip.Anchor content={t().editFieldSettings} class="md:hidden">
                          <IconButton
                            variant="ghost"
                            size="sm"
                            type="button"
                            onClick={() => void openFieldSettings(idx)}
                            label={t().editFieldSettings}
                          >
                            <i class="ti ti-pencil" />
                          </IconButton>
                        </Tooltip.Anchor>
                        <Tooltip.Anchor content={t().removeFromForm}>
                          <IconButton
                            variant="ghost"
                            size="sm"
                            type="button"
                            class="text-red-500 hover:text-red-600"
                            onClick={() => removeEntry(idx)}
                            label={t().removeFromForm}
                          >
                            <i class="ti ti-trash" />
                          </IconButton>
                        </Tooltip.Anchor>
                      </div>
                    </div>
                  </li>
                );
              }}
            </Index>
          </ul>
        </Show>
        <Show when={addable().length > 0}>
          <Select
            label={t().addField}
            description={t().addFieldDescription}
            value={() => ""}
            onValueChange={(value) => {
              if (value) void addEntry(value);
            }}
            options={addable().map((field) => ({
              id: field.id,
              label: field.name,
              description: fieldTypeLabel(field.type, locale()),
              icon: fieldTypeIcon(field.type, field.icon),
            }))}
            placeholder={t().pickField}
          />
        </Show>
      </div>

      <FormFieldInspector
        class="hidden md:flex"
        entry={selectedEntry}
        field={selectedField}
        index={selectedIndex}
        updateEntry={updateEntry}
        updateFormValue={updateFormValue}
      />
    </div>
  );
}

const chooseFormFieldEntryKind = (field: Field, locale: string) => {
  const { t } = gridsFormMessages.resolve([locale]);
  return prompts.dialog<"user_input" | "form_value">(
    (close) => (
      <div class="flex flex-col gap-4">
        <NoticeCard tone="info" icon={false}>
          <p class="font-semibold">{t.useField({ name: field.name })}</p>
          <p class="mt-1">{t.fieldKindDescription}</p>
        </NoticeCard>
        <div class="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" size="sm" type="button" onClick={() => close("form_value")}>
            <i class="ti ti-lock" /> {t.addFixedValue}
          </Button>
          <Button variant="primary" size="sm" type="button" onClick={() => close("user_input")}>
            <i class="ti ti-pencil" /> {t.addFormField}
          </Button>
        </div>
      </div>
    ),
    { title: t.addField, icon: fieldTypeIcon(field.type, field.icon), size: "small" },
  );
};
