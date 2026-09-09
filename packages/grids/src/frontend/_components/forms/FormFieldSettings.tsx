import { query } from "@k2b/stdlib/solid";
import {
  Button,
  Checkbox,
  confirmDiscardIfDirty,
  dialogCore,
  MultiSelectInput,
  NoticeCard,
  PanelDialog,
  panelDialogOptions,
  TextInput,
  useLocale,
} from "@k2b/ui";
import { createMemo, createSignal, Show } from "solid-js";
import { apiClient } from "@/api/client";
import type { FormFieldEntry } from "../../../service/forms";
import { isRecordInputField } from "../fields/field-render";
import { fieldTypeIcon, fieldTypeLabel } from "../fields/field-type-meta";
import { gridsFieldMessages } from "../fields/messages";
import { errorMessage } from "../utils/api-helpers";
import { FieldInput, type FrontendField } from "./form-fields";
import { gridsFormMessages } from "./messages";
export function FormFieldInspector(props: {
  class?: string;
  entry: () => FormFieldEntry | null;
  field: () => FrontendField | undefined;
  index: () => number;
  updateEntry: (index: number, patch: Partial<Extract<FormFieldEntry, { kind: "user_input" }>>) => void;
  updateFormValue: (index: number, value: unknown) => void;
}) {
  const locale = useLocale();
  const t = () => gridsFormMessages.resolve([locale()]).t;
  const userEntry = createMemo(() =>
    props.entry()?.kind === "user_input" ? (props.entry() as Extract<FormFieldEntry, { kind: "user_input" }>) : null,
  );
  const valueEntry = createMemo(() =>
    props.entry()?.kind === "form_value" ? (props.entry() as Extract<FormFieldEntry, { kind: "form_value" }>) : null,
  );

  return (
    <Show
      when={props.entry() && props.field()}
      fallback={
        <div class={`paper min-h-64 items-center justify-center p-4 text-sm text-dimmed ${props.class ?? "flex"}`}>{t().selectField}</div>
      }
    >
      <div class={`paper min-h-0 flex-col gap-3 p-4 ${props.class ?? "flex"}`}>
        <FormFieldSettings
          entry={props.entry}
          field={props.field}
          userEntry={userEntry}
          valueEntry={valueEntry}
          updateEntry={(patch) => props.updateEntry(props.index(), patch)}
          updateFormValue={(value) => props.updateFormValue(props.index(), value)}
        />
      </div>
    </Show>
  );
}

function FormFieldSettings(props: {
  entry: () => FormFieldEntry | null;
  field: () => FrontendField | undefined;
  userEntry: () => Extract<FormFieldEntry, { kind: "user_input" }> | null;
  valueEntry: () => Extract<FormFieldEntry, { kind: "form_value" }> | null;
  updateEntry: (patch: Partial<Extract<FormFieldEntry, { kind: "user_input" }>>) => void;
  updateFormValue: (value: unknown) => void;
}) {
  const locale = useLocale();
  const t = () => gridsFormMessages.resolve([locale()]).t;
  return (
    <>
      <div class="flex items-start gap-3">
        <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--ui-radius-control)] bg-[var(--ui-surface-subtle)] text-dimmed">
          <i class={`${fieldTypeIcon(props.field()!.type, props.field()!.icon)} text-sm`} />
        </span>
        <div class="min-w-0 flex-1">
          <p class="truncate text-sm font-semibold text-primary">{props.field()!.name}</p>
          <p class="text-[11px] text-dimmed">
            {fieldTypeLabel(props.field()!.type, locale())}
            <Show when={props.valueEntry()}> · {t().fixedValue}</Show>
          </p>
        </div>
      </div>

      <Show when={props.userEntry()}>
        {(entry) => (
          <>
            <Checkbox
              label={t().required}
              description={t().requiredDescription}
              value={() => entry().required ?? false}
              onValueChange={(required) => props.updateEntry({ required })}
            />
            <div class="flex flex-col gap-3">
              <TextInput
                label={t().labelOverride}
                description={t().labelOverrideDescription}
                icon="ti ti-tag"
                value={() => entry().label ?? ""}
                onValueChange={(value) => props.updateEntry({ label: value.trim() === "" ? undefined : value })}
                placeholder={props.field()!.name}
              />
              <TextInput
                label={t().helpText}
                description={t().helpTextDescription}
                icon="ti ti-info-circle"
                value={() => entry().helpText ?? ""}
                onValueChange={(value) => props.updateEntry({ helpText: value.trim() === "" ? undefined : value })}
                placeholder={t().helpTextPlaceholder}
                multiline
                lines={2}
              />
            </div>
            <InlineCreateEditor field={props.field()!} entry={entry()} onChange={(patch) => props.updateEntry(patch)} />
          </>
        )}
      </Show>

      <Show when={props.valueEntry()}>
        {(entry) => (
          <>
            <NoticeCard tone="info" icon={false}>
              {t().hiddenFixedValue}
            </NoticeCard>
            <FieldInput
              field={props.field()!}
              entry={{ kind: "user_input", fieldId: props.field()!.id, required: false }}
              value={entry().value}
              onChange={props.updateFormValue}
            />
          </>
        )}
      </Show>
    </>
  );
}

const cloneFormFieldEntry = (entry: FormFieldEntry): FormFieldEntry => {
  if (entry.kind === "form_value") return { ...entry };
  return {
    ...entry,
    inlineCreate: entry.inlineCreate
      ? {
          enabled: entry.inlineCreate.enabled,
          fields: (entry.inlineCreate.fields ?? []).map((field) => ({ ...field })),
        }
      : undefined,
  };
};

export const openFormFieldSettingsDialog = (args: { entry: FormFieldEntry; field: FrontendField }) =>
  dialogCore.open<FormFieldEntry | null>((close, context) => {
    const locale = useLocale();
    const t = () => gridsFormMessages.resolve([locale()]).t;
    const [draft, setDraft] = createSignal<FormFieldEntry>(cloneFormFieldEntry(args.entry));
    const initial = JSON.stringify(draft());
    const dismiss = async () => {
      if (await confirmDiscardIfDirty(JSON.stringify(draft()) !== initial)) close(null);
    };
    context.setDismissHandler(dismiss);
    const userEntry = createMemo(() =>
      draft().kind === "user_input" ? (draft() as Extract<FormFieldEntry, { kind: "user_input" }>) : null,
    );
    const valueEntry = createMemo(() =>
      draft().kind === "form_value" ? (draft() as Extract<FormFieldEntry, { kind: "form_value" }>) : null,
    );
    const updateEntry = (patch: Partial<Extract<FormFieldEntry, { kind: "user_input" }>>) => {
      setDraft((current) => (current.kind === "user_input" ? { ...current, ...patch } : current));
    };
    const updateFormValue = (value: unknown) => {
      setDraft((current) => (current.kind === "form_value" ? { ...current, value } : current));
    };

    return (
      <PanelDialog>
        <PanelDialog.Header
          title={t().fieldSettings({ name: args.field.name })}
          icon={fieldTypeIcon(args.field.type, args.field.icon)}
          close={dismiss}
        />
        <PanelDialog.Body>
          <FormFieldSettings
            entry={draft}
            field={() => args.field}
            userEntry={userEntry}
            valueEntry={valueEntry}
            updateEntry={updateEntry}
            updateFormValue={updateFormValue}
          />
        </PanelDialog.Body>
        <PanelDialog.Footer>
          <span class="text-[11px] text-dimmed">{t().confirmStagesSettings}</span>
          <div class="flex items-center gap-2">
            <Button variant="secondary" size="sm" type="button" onClick={dismiss}>
              {t().cancel}
            </Button>
            <Button variant="primary" size="sm" type="button" onClick={() => close(cloneFormFieldEntry(draft()))}>
              {t().confirm}
            </Button>
          </div>
        </PanelDialog.Footer>
      </PanelDialog>
    );
  }, panelDialogOptions);
function InlineCreateEditor(props: {
  field: FrontendField;
  entry: Extract<FormFieldEntry, { kind: "user_input" }> | null;
  onChange: (patch: Partial<Extract<FormFieldEntry, { kind: "user_input" }>>) => void;
}) {
  const locale = useLocale();
  const t = () => gridsFormMessages.resolve([locale()]).t;
  const targetTableId = () =>
    props.field.type === "relation" ? (props.field.config as { targetTableId?: string }).targetTableId : undefined;
  const fieldsQuery = query.create({
    source: targetTableId,
    load: async (tableId, { abortSignal }) => {
      if (!tableId) return [];
      const res = await apiClient.fields["by-table"][":tableId"].$get({ param: { tableId } }, { init: { signal: abortSignal } });
      if (!res.ok) throw new Error(await errorMessage(res, t().loadInlineFieldsFailed));
      return res.json();
    },
  });
  const targetFields = () => fieldsQuery.data() ?? [];
  const fieldsUnavailable = () => fieldsQuery.loading() || fieldsQuery.refreshing() || Boolean(fieldsQuery.error());

  const enabled = () => Boolean(props.entry?.inlineCreate?.enabled);
  const selectedFieldIds = () => (props.entry?.inlineCreate?.fields ?? []).map((entry) => entry.fieldId);
  const candidateFields = createMemo(() =>
    targetFields().filter((field) => !field.deletedAt && isRecordInputField(field.type) && field.type !== "relation"),
  );
  const fieldOption = (field: FrontendField) => ({
    id: field.id,
    label: field.name,
    description: gridsFieldMessages.resolve([locale()]).t.typeLabel({ type: field.type }),
    icon: fieldTypeIcon(field.type, field.icon),
  });
  const candidateOptions = createMemo(() => candidateFields().map(fieldOption));
  const selectedInlineOptions = createMemo(() =>
    selectedFieldIds()
      .map((fieldId) => targetFields().find((field) => field.id === fieldId))
      .filter((field) => field !== undefined)
      .map(fieldOption),
  );

  const setEnabled = (next: boolean) => {
    props.onChange(
      next
        ? {
            inlineCreate: {
              enabled: true,
              fields:
                props.entry?.inlineCreate?.fields ??
                candidateFields()
                  .slice(0, 1)
                  .map((field) => ({ fieldId: field.id, required: field.required })),
            },
          }
        : { inlineCreate: undefined },
    );
  };

  const setInlineFieldIds = (ids: string[]) => {
    const fieldById = new Map(candidateFields().map((field) => [field.id, field]));
    props.onChange({
      inlineCreate: {
        enabled: true,
        fields: ids
          .map((fieldId) => {
            const field = fieldById.get(fieldId);
            return field ? { fieldId, required: field.required } : null;
          })
          .filter((entry): entry is { fieldId: string; required: boolean } => Boolean(entry)),
      },
    });
  };

  return (
    <Show when={targetTableId()}>
      <div class="mt-1 flex flex-col gap-2">
        <Checkbox
          label={t().inlineCreate}
          description={t().inlineCreateDescription}
          value={enabled}
          onValueChange={setEnabled}
          disabled={fieldsUnavailable()}
        />
        <Show when={fieldsQuery.loading()}>
          <p class="text-sm text-dimmed" role="status">
            {t().loadingFields}
          </p>
        </Show>
        <Show when={fieldsQuery.error()}>
          {(error) => (
            <NoticeCard
              tone="danger"
              title={t().loadInlineFieldsFailed}
              detail={error().message === t().loadInlineFieldsFailed ? undefined : error().message}
            >
              <Button variant="secondary" size="sm" onClick={() => fieldsQuery.refresh()}>
                {t().retry}
              </Button>
            </NoticeCard>
          )}
        </Show>
        <Show when={enabled()}>
          <MultiSelectInput
            label={t().inlineFields}
            description={t().inlineFieldsDescription}
            placeholder={t().pickFields}
            icon="ti ti-columns"
            value={selectedFieldIds}
            onValueChange={setInlineFieldIds}
            options={candidateOptions()}
            selectedOptions={selectedInlineOptions}
            clearable
            disabled={fieldsUnavailable()}
          />
        </Show>
      </div>
    </Show>
  );
}
