import type { DateContext } from "@k2b/stdlib";
import {
  Button,
  Checkbox,
  CheckboxCard,
  DatePicker,
  DateTimePicker,
  IconButton,
  NumberInput,
  Select,
  TextInput,
  Tooltip,
  useLocale,
} from "@k2b/ui";
import { createMemo, createSignal, For, Index, onMount, Show } from "solid-js";
import { apiClient } from "@/api/client";
import type { PublicField } from "../../../api/public-dto";
import type { Field, FormFieldEntry } from "../../../service";
import RelationPicker from "../records/RelationPicker";
import type { InlineCreateDraft, InlineCreateState } from "./form-submit-payload";
import { gridsFormMessages } from "./messages";
import PrincipalInput from "./PrincipalInput";

export { buildFormSubmitPayload, type InlineCreateState } from "./form-submit-payload";

export type FrontendField = Field | PublicField;

/** A user_input form-field entry — `form_value` entries don't render. */
export type UserInputEntry = Extract<FormFieldEntry, { kind: "user_input" }>;

/** Filter a form-config's entries to the user-renderable subset. */
export const userInputEntriesOf = (entries: FormFieldEntry[]): UserInputEntry[] =>
  entries.filter((e): e is UserInputEntry => e.kind === "user_input");

/**
 * Build the initial value map from a list of user-input entries —
 * seeded with each entry's `defaultValue` when present.
 */
export const buildInitialValues = (entries: UserInputEntry[]): Record<string, unknown> => {
  const values: Record<string, unknown> = {};
  for (const entry of entries) {
    if (
      entry.defaultValue !== undefined &&
      entry.defaultValue !== null &&
      !(typeof entry.defaultValue === "object" && (entry.defaultValue as { kind?: unknown }).kind === "now")
    ) {
      values[entry.fieldId] = entry.defaultValue;
    }
  }
  return values;
};

/**
 * Renders one input row for a grids field. Single source of truth across
 * every record-write surface (public form submit, in-app form modal,
 * create-record dialog, default-value editor in the field designer).
 *
 * Why this matters: rendering used to fork between FormSubmit (here) and
 * `RecordUpsertDialog`. Numeric fields must preserve exact decimal text;
 * select was stacked
 * CheckboxCards here and a freeform `TagsInput` there (which let users type
 * non-existent option ids that the server rejected). Post-cleanup #7
 * collapses both onto this renderer so users see the same widget for the
 * same field type everywhere.
 *
 * Field-type → component mapping (current):
 * - text / unknown → TextInput
 * - longtext → TextInput multiline
 * - json → TextInput multiline (lines=6)
 * - number → TextInput with decimal keyboard hint (server validates exactly)
 * - percent → NumberInput
 * - duration → TextInput with "HH:MM:SS or seconds"; same lenient parser
 *   server-side. NumberInput would lose the HH:MM:SS shorthand.
 * - boolean → Checkbox
 * - date → DatePicker (or DateTimePicker when config.includeTime)
 * - datetime → DateTimePicker
 * - select → Select in single mode, CheckboxCard list in multi mode
 * - relation → RelationPicker (requires `baseId` prop). Picker disabled
 *   without baseId — used by the default-value editor where deep-link
 *   chips don't apply.
 * - principal → caller-scoped Cloud user/group search
 *
 * Optional `error` getter (function form, so the platform components
 * react to signal updates) renders the inline error string. Mirrors
 * the rest of the platform's input convention.
 */
export function FieldInput(props: {
  field: FrontendField;
  entry: UserInputEntry;
  value: unknown;
  onChange: (v: unknown) => void;
  /** Render an inline error string. Reactive on purpose. */
  error?: () => string | undefined;
  /** Required for relation rendering — drives RelationPicker chip
   *  deep-links. Omitted for the field designer's default-value editor;
   *  RelationPicker degrades to a non-deep-linkable picker there. */
  baseId?: string;
  /** Optional UUID → label map for already-linked relation values. */
  relationLabels?: Record<string, string>;
  /** Existing record id in edit mode. Excluded from self-relation pickers. */
  currentRecordId?: string;
  dateConfig?: DateContext;
  inlineCreates?: () => InlineCreateState;
  onInlineCreatesChange?: (fieldId: string, drafts: InlineCreateDraft[]) => void;
  inlineTargetFields?: Record<string, FrontendField[]>;
}) {
  const locale = useLocale();
  const t = () => gridsFormMessages.resolve([locale()]).t;
  const label = props.entry.label || props.field.name;
  const required = props.entry.required ?? props.field.required;
  const helpText = props.entry.helpText;
  const error = () => props.error?.();

  // Helpers narrowing the unknown value to a usable shape per input
  // type. Each input is forgiving — a wrong-typed stored value falls
  // back to empty, never throws.
  const stringValue = () => (typeof props.value === "string" ? props.value : typeof props.value === "number" ? String(props.value) : "");
  const numberValue = () => (typeof props.value === "number" ? props.value : null);
  const boolValue = () => props.value === true;
  const arrayValue = (): string[] => (Array.isArray(props.value) ? (props.value as string[]) : []);

  switch (props.field.type) {
    case "longtext":
      const markdown = Boolean((props.field.config as { markdown?: boolean }).markdown);
      return (
        <TextInput
          name={props.field.id}
          label={label}
          description={helpText}
          required={required}
          markdown={markdown || undefined}
          multiline={markdown ? undefined : true}
          lines={markdown ? 8 : 4}
          value={stringValue}
          onValueChange={(v) => props.onChange(v)}
          error={error}
        />
      );

    case "json":
      // JSON is a freeform blob — the server stores it as-is in
      // `records.data->fieldId`. We don't validate JSON shape client-
      // side; the server's `jsonHandler` does. Multiline-6 keeps the
      // box tall enough that the user can see the structure as they
      // type without running off the visible area.
      return (
        <TextInput
          name={props.field.id}
          label={label}
          description={helpText}
          required={required}
          multiline
          lines={6}
          value={stringValue}
          onValueChange={(v) => props.onChange(v)}
          error={error}
        />
      );

    case "number": {
      const decimalPlaces = (props.field.config as { decimalPlaces?: number }).decimalPlaces;
      const unit = (props.field.config as { unit?: string }).unit;
      const unitPosition = (props.field.config as { unitPosition?: "prefix" | "suffix" }).unitPosition ?? "suffix";
      const numberText = (): string => {
        const v = props.value;
        if (v === null || v === undefined) return "";
        if (typeof v === "object" && "amount" in v) return String((v as { amount?: unknown }).amount ?? "");
        return String(v);
      };
      return (
        <TextInput
          name={props.field.id}
          label={label}
          description={helpText}
          required={required}
          value={numberText}
          onValueChange={(v) => props.onChange(v)}
          inputMode={decimalPlaces === 0 ? "numeric" : "decimal"}
          icon="ti ti-number"
          prefix={unit && unitPosition === "prefix" ? <span class="font-mono">{unit}</span> : undefined}
          suffix={unit && unitPosition !== "prefix" ? <span class="font-mono">{unit}</span> : undefined}
          clearable={!required}
          error={error}
        />
      );
    }

    case "percent":
      return (
        <NumberInput
          label={label}
          description={helpText}
          required={required}
          min={0}
          max={100}
          value={numberValue}
          onValueChange={(v) => props.onChange(v)}
          decimalPlaces={0}
          suffix={<span class="font-mono">%</span>}
          error={error}
        />
      );

    case "duration":
      // Duration accepts either seconds ("90") or "HH:MM:SS" / "MM:SS".
      // TextInput preserves the shorthand; NumberInput would force
      // the user to compute seconds.
      return (
        <TextInput
          name={props.field.id}
          label={label}
          description={helpText}
          required={required}
          placeholder={t().durationPlaceholder}
          value={stringValue}
          onValueChange={(v) => props.onChange(v)}
          error={error}
        />
      );

    case "boolean":
      return (
        <Checkbox
          label={label}
          description={helpText}
          required={required}
          value={boolValue}
          onValueChange={(v) => props.onChange(v)}
          error={error}
        />
      );

    case "date": {
      const includeTime = (props.field.config as { includeTime?: boolean }).includeTime ?? false;
      const pickerValue = () => stringValue() || null;
      const onPickerChange = (v: string | null) => props.onChange(v ?? "");
      return includeTime ? (
        <DateTimePicker
          label={label}
          description={helpText}
          required={required}
          dateConfig={props.dateConfig}
          value={pickerValue}
          onValueChange={onPickerChange}
          error={error}
          clearable
        />
      ) : (
        <DatePicker
          label={label}
          description={helpText}
          required={required}
          dateConfig={props.dateConfig}
          value={pickerValue}
          onValueChange={onPickerChange}
          error={error}
          clearable
        />
      );
    }

    case "datetime":
      return (
        <DateTimePicker
          label={label}
          description={helpText}
          required={required}
          dateConfig={props.dateConfig}
          value={() => stringValue() || null}
          onValueChange={(v) => props.onChange(v ?? "")}
          error={error}
          clearable
        />
      );

    case "select": {
      const multiple = Boolean((props.field.config as { multiple?: boolean }).multiple);
      const optionCards =
        (props.field.config as { options?: Array<{ id: string; label: string; description?: string; color?: string }> }).options ?? [];
      if (multiple) {
        const isSelected = (id: string) => arrayValue().includes(id);
        const toggle = (id: string, checked: boolean) => {
          const current = arrayValue();
          const next = checked ? (current.includes(id) ? current : [...current, id]) : current.filter((s) => s !== id);
          props.onChange(next);
        };
        return (
          <div class="flex flex-col gap-2">
            <p class="text-sm font-medium">
              {label}
              <Show when={required}>
                <span class="ml-0.5 text-red-500" aria-hidden="true">
                  *
                </span>
              </Show>
            </p>
            <Show when={helpText}>
              <p class="text-xs text-dimmed">{helpText}</p>
            </Show>
            <div class="grid grid-cols-1 gap-2">
              <For each={optionCards}>
                {(option) => (
                  <CheckboxCard
                    label={option.label}
                    description={option.description}
                    color={option.color}
                    value={() => isSelected(option.id)}
                    onValueChange={(checked) => toggle(option.id, checked)}
                  />
                )}
              </For>
            </div>
            <Show when={error()}>
              <p class="text-[11px] text-red-500">{error()}</p>
            </Show>
          </div>
        );
      }
      return (
        <Select
          label={label}
          description={helpText}
          required={required}
          options={optionCards.map((o) => ({ id: o.id, label: o.label, description: o.description }))}
          clearable={!required}
          value={() => arrayValue()[0] ?? ""}
          onValueChange={(v) => props.onChange(v ? [v] : null)}
          error={error}
        />
      );
    }

    case "relation": {
      // Relation rendering: RelationPicker resolves linked records
      // against `targetTableId`. Without `baseId` we still render the
      // picker (server-side validation guards against bad ids); chip
      // deep-links degrade to "open in records view" using a placeholder
      // — non-fatal since the most common no-baseId surface is the
      // field-designer's default-value editor where deep-links don't apply.
      const cfg = props.field.config as {
        targetTableId?: string;
        cardinality?: "single" | "multiple";
      };
      if (!cfg.targetTableId) {
        return (
          <div class="flex flex-col gap-0.5">
            <p class="block text-sm font-medium">{label}</p>
            <p class="text-xs text-amber-600 dark:text-amber-400">{t().relationMissingTarget}</p>
          </div>
        );
      }
      const multi = cfg.cardinality !== "single";
      const inlineDrafts = () => props.inlineCreates?.()[props.field.id] ?? [];
      const inlineTempIds = () => inlineDrafts().map((draft) => draft.tempId);
      const existingRelationIds = () => arrayValue().filter((id) => !id.startsWith("tmp_"));
      const syncInlineDrafts = (drafts: InlineCreateDraft[]) => {
        props.onInlineCreatesChange?.(props.field.id, drafts);
        props.onChange(multi ? [...existingRelationIds(), ...drafts.map((draft) => draft.tempId)] : drafts[0] ? [drafts[0].tempId] : []);
      };
      const createInlineDraft = () => {
        const draft: InlineCreateDraft = { tempId: `tmp_${crypto.randomUUID()}`, data: {} };
        syncInlineDrafts(multi ? [...inlineDrafts(), draft] : [draft]);
      };
      const useExistingRecord = () => {
        props.onInlineCreatesChange?.(props.field.id, []);
        props.onChange(multi ? existingRelationIds() : []);
      };
      const showRelationPicker = () => !props.entry.inlineCreate?.enabled || multi || inlineDrafts().length === 0;
      return (
        <div class="flex flex-col gap-0.5">
          <p class="block text-sm font-medium">
            {label}
            <Show when={required}>
              <span class="ml-0.5 text-red-500" aria-hidden="true">
                *
              </span>
            </Show>
          </p>
          <Show when={helpText}>
            <p class="text-xs text-dimmed leading-snug">{helpText}</p>
          </Show>
          <Show when={showRelationPicker()}>
            <div class="flex flex-col gap-2 sm:flex-row sm:items-start">
              <div class="min-w-0 flex-1">
                <RelationPicker
                  targetTableId={cfg.targetTableId}
                  multi={multi}
                  value={existingRelationIds}
                  labels={() => props.relationLabels ?? {}}
                  onChange={(v) => {
                    props.onChange(multi ? [...v, ...inlineTempIds()] : v);
                    if (!multi && v.length > 0) props.onInlineCreatesChange?.(props.field.id, []);
                  }}
                  excludeIds={() => (props.currentRecordId ? [props.currentRecordId] : [])}
                />
              </div>
              <Show when={props.entry.inlineCreate?.enabled}>
                <Button variant="secondary" size="sm" type="button" class="shrink-0" onClick={createInlineDraft}>
                  <i class="ti ti-plus" />
                  {t().createNew}
                </Button>
              </Show>
            </div>
          </Show>
          <Show when={props.entry.inlineCreate?.enabled}>
            <InlineRelationCreate
              field={props.field}
              entry={props.entry}
              targetTableId={cfg.targetTableId}
              multi={multi}
              drafts={inlineDrafts}
              onDraftsChange={syncInlineDrafts}
              onCreateDraft={createInlineDraft}
              onUseExisting={useExistingRecord}
              targetFields={props.inlineTargetFields?.[cfg.targetTableId]}
              dateConfig={props.dateConfig}
            />
          </Show>
          <Show when={error()}>
            <p class="text-[11px] text-red-500">{error()}</p>
          </Show>
        </div>
      );
    }

    case "principal": {
      const cfg = props.field.config as { cardinality?: "single" | "multiple" };
      return (
        <PrincipalInput
          name={props.field.id}
          label={label}
          description={helpText}
          required={required}
          error={error}
          value={props.value}
          multi={cfg.cardinality !== "single"}
          onChange={props.onChange}
        />
      );
    }

    default:
      // text / unknown-but-userInput → plain text.
      return (
        <TextInput
          name={props.field.id}
          label={label}
          description={helpText}
          required={required}
          value={stringValue}
          onValueChange={(v) => props.onChange(v)}
          error={error}
        />
      );
  }
}

function InlineRelationCreate(props: {
  field: FrontendField;
  entry: UserInputEntry;
  targetTableId: string;
  multi: boolean;
  drafts: () => InlineCreateDraft[];
  onDraftsChange?: (drafts: InlineCreateDraft[]) => void;
  onCreateDraft: () => void;
  onUseExisting: () => void;
  targetFields?: FrontendField[];
  dateConfig?: DateContext;
}) {
  const locale = useLocale();
  const t = () => gridsFormMessages.resolve([locale()]).t;
  const allowedIds = createMemo(() => new Set((props.entry.inlineCreate?.fields ?? []).map((entry) => entry.fieldId)));
  const [loadedFields, setLoadedFields] = createSignal<FrontendField[]>(props.targetFields ?? []);

  onMount(async () => {
    if (props.targetFields) return;
    const res = await apiClient.fields["by-table"][":tableId"].$get({ param: { tableId: props.targetTableId } });
    if (res.ok) setLoadedFields(await res.json());
  });

  const inlineFields = createMemo(() => {
    const orderById = new Map((props.entry.inlineCreate?.fields ?? []).map((entry, index) => [entry.fieldId, index]));
    return loadedFields()
      .filter((field) => !field.deletedAt && allowedIds().has(field.id))
      .sort((a, b) => (orderById.get(a.id) ?? 9999) - (orderById.get(b.id) ?? 9999) || a.position - b.position);
  });

  const setDraftField = (index: number, fieldId: string, value: unknown) => {
    const next = props.drafts().map((draft, i) => (i === index ? { ...draft, data: { ...draft.data, [fieldId]: value } } : draft));
    props.onDraftsChange?.(props.multi ? next : next.slice(0, 1));
  };

  const removeDraft = (index: number) => {
    const next = props.drafts().filter((_, i) => i !== index);
    props.onDraftsChange?.(next);
  };

  const inlineEntryFor = (field: FrontendField): UserInputEntry => {
    const config = props.entry.inlineCreate?.fields?.find((entry) => entry.fieldId === field.id);
    return {
      kind: "user_input",
      fieldId: field.id,
      label: config?.label,
      helpText: config?.helpText,
      required: config?.required ?? field.required,
      defaultValue: config?.defaultValue,
    };
  };

  return (
    <Show when={props.drafts().length > 0}>
      <div class="paper mt-2 flex flex-col gap-2 p-3">
        <div class="flex items-start justify-between gap-2">
          <div>
            <p class="text-xs font-semibold text-primary">{t().newRelatedRecord}</p>
            <p class="text-[11px] text-dimmed">{t().linkedRecordSavedTogether}</p>
          </div>
          <div class="flex items-center gap-1">
            <Show when={props.multi}>
              <Button variant="secondary" size="sm" type="button" onClick={props.onCreateDraft}>
                <i class="ti ti-plus" />
                {t().another}
              </Button>
            </Show>
            <Show when={!props.multi}>
              <Button variant="secondary" size="sm" type="button" onClick={props.onUseExisting}>
                {t().useExisting}
              </Button>
            </Show>
          </div>
        </div>
        <Show when={inlineFields().length > 0} fallback={<p class="text-[11px] text-dimmed">{t().noInlineFields}</p>}>
          <Index each={props.drafts()}>
            {(draft, index) => (
              <div class="flex flex-col gap-2">
                <Show when={props.multi}>
                  <div class="flex justify-end">
                    <Tooltip.Anchor content={t().removeDraft}>
                      <IconButton
                        variant="ghost"
                        size="sm"
                        type="button"
                        class="h-7 w-7"
                        onClick={() => removeDraft(index)}
                        label={t().removeDraft}
                      >
                        <i class="ti ti-x" />
                      </IconButton>
                    </Tooltip.Anchor>
                  </div>
                </Show>
                <For each={inlineFields()}>
                  {(field) => (
                    <FieldInput
                      field={field}
                      entry={inlineEntryFor(field)}
                      value={draft().data[field.id]}
                      onChange={(value) => setDraftField(index, field.id, value)}
                      dateConfig={props.dateConfig}
                    />
                  )}
                </For>
              </div>
            )}
          </Index>
        </Show>
      </div>
    </Show>
  );
}
