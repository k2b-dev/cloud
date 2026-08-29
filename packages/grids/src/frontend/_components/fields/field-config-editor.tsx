import { timed } from "@k2b/stdlib/solid";
import {
  Button,
  CheckboxCard,
  ColorInput,
  IconButton,
  NoticeCard,
  NumberInput,
  Select,
  TemplateEditor,
  TemplatePreview,
  type TemplateVariable,
  TextInput,
  useLocale,
} from "@k2b/ui";
import { createEffect, createSignal, For, Index, onCleanup, Show } from "solid-js";
import { apiClient } from "../../../api/client";
import type { PublicField as Field } from "../../../api/public-dto";
import { errorMessage } from "../utils/api-helpers";
import { FormulaExpressionEditor } from "./FormulaExpressionEditor";
import { gridsFieldMessages } from "./messages";

// =============================================================================
// Type catalog
// =============================================================================

export type FieldConfigState = Record<string, unknown>;

const REGEX_PRESETS = [
  { label: "Email", value: "^[^ @]+@[^ @]+\\.[^ @]{2,}$" },
  { label: "URL", value: "^https?://.+$" },
  { label: "Phone", value: "^\\+?[0-9 .()\\-]{5,}$" },
  { label: "Slug", value: "^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$" },
  { label: "ISBN", value: "^[0-9Xx -]{10,17}$" },
];

const FILE_ACCEPT_PRESETS = [
  { label: "Images", values: ["image/*"] },
  {
    label: "Photos",
    values: ["image/jpeg", "image/png", "image/heic", "image/webp"],
  },
  { label: "PDF", values: ["application/pdf", ".pdf"] },
  {
    label: "Spreadsheets",
    values: [
      ".csv",
      ".tsv",
      ".xls",
      ".xlsx",
      "application/vnd.ms-excel",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ],
  },
  {
    label: "Documents",
    values: [".doc", ".docx", ".odt", "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  },
  { label: "Text", values: ["text/plain", ".txt", ".md"] },
  { label: "Archives", values: [".zip", ".tar", ".gz", ".7z"] },
];

export const TYPE_OPTIONS = [
  // Tier 1
  { value: "text", label: "Text" },
  { value: "longtext", label: "Long text" },
  { value: "number", label: "Number" },
  { value: "boolean", label: "Boolean" },
  { value: "date", label: "Date" },
  { value: "select", label: "Select" },
  { value: "principal", label: "People and groups" },
  { value: "id", label: "ID" },
  // Tier 2
  { value: "percent", label: "Percent" },
  { value: "duration", label: "Duration" },
  // Tier 3
  { value: "json", label: "JSON" },
  { value: "file", label: "File" },
  { value: "relation", label: "Relation (link to another table)" },
  { value: "lookup", label: "Lookup (project a field through a relation)" },
  { value: "rollup", label: "Rollup (aggregate over a relation)" },
  { value: "formula", label: "Formula" },
  { value: "html_template", label: "HTML template" },
];

export const TYPE_LABELS: Record<string, string> = Object.fromEntries(TYPE_OPTIONS.map((o) => [o.value, o.label]));

// System fields are read-only and never reach this editor, but include them
// for the column-type pill in the list view.
TYPE_LABELS["created_at"] = "Created at";
TYPE_LABELS["updated_at"] = "Updated at";
TYPE_LABELS["created_by"] = "Created by";
TYPE_LABELS["updated_by"] = "Updated by";

/**
 * Plain-language primer per field type. Aimed at someone who's never
 * built a database — explain WHAT the field is for and WHEN to pick it,
 * not how it's stored. The constraint inputs further down (precision,
 * regex, cardinality) should make sense after reading these.
 */
export const FIELD_TYPE_DESCRIPTIONS: Record<string, string> = {
  text: "A single line of text — names, titles, codes, anything short. Set min/max length if the value should be a certain size, or a regex pattern to enforce a format like a postcode.",
  longtext: "Multi-line text — paragraphs, notes, instructions. Bound the size the same way as text if you need to.",
  number: "A number, stored decimal-safe. Use decimal places for money or exact measurements; set 0 decimal places for whole numbers.",
  boolean: "A yes/no checkbox.",
  date: "A calendar date, optionally with a time. Bound it to a min and/or max date if you only want values in a certain range.",
  select: "A fixed list of choices. Use single mode for one choice, or multiple mode for tags/categories.",
  principal: "One or more Cloud users or groups. People can only select identities they are allowed to discover.",
  id: "A server-generated identifier. Use it for inventory numbers, loan numbers, short codes, UUIDs, or other values users should not type manually.",
  percent: "A percentage from 0 to 100.",
  duration: "A length of time. Type as HH:MM:SS or seconds; displayed as HH:MM:SS.",
  json: "A free-form JSON value. Use this when no other type fits.",
  file: "Small files stored directly in Postgres. The app-level upload limit is controlled from the Grids admin settings.",
  relation: "A link to one or more records in another table. Pick the target table and which of its columns to show.",
  lookup: "Pulls a column from a linked record so you can see it on this row, without copying the data.",
  rollup: "Summarises values from linked records — count them, add them up, average them, or take the smallest or largest.",
  formula:
    'A computed value, recalculated whenever the row is read. Reference columns by name, quote names with spaces like "Unit price", and use functions like IF, CONCAT, ROUND, AVG.',
  html_template:
    "A computed HTML value rendered for every record from Liquid, the other fields, and optional CSS. Use it for email bodies, descriptions, and exports.",
};

/** Default config blob for a brand-new field of `type`. */
export const defaultConfigForType = (type: string): FieldConfigState => {
  switch (type) {
    case "select":
      return { multiple: false, options: [] };
    case "principal":
      return { cardinality: "multiple" };
    case "id":
      return { strategy: "sequence", padding: 4 };
    case "date":
      return { includeTime: false };
    case "file":
      return { maxFiles: 10 };
    case "html_template":
      return { template: "", css: "" };
    default:
      return {};
  }
};

// =============================================================================
// Top-level editor — switches sub-form by type
// =============================================================================

type EditorProps = {
  currentFieldId?: string;
  type: string;
  /** ID of the table this field lives on. Needed by lookup/rollup so
   *  the relation-field picker can list THIS table's relation fields. */
  currentTableId: string;
  baseId?: string;
  tableId?: string;
  config: () => FieldConfigState;
  onChange: (next: FieldConfigState) => void;
  /** Tables in the same base — used by relation targetTableId, including the current table for self-relations. */
  otherTables: Array<{ id: string; name: string }>;
  /** Fields per table id — used for lookup/rollup target pickers. */
  fieldsByTable: Record<string, Field[]>;
};

/** Field types that can't sensibly serve as a presentable label. Lookup
 *  can target formula fields because the read pipeline resolves them;
 *  rollup stays stricter because aggregation must stay SQL-native. */
const NON_LOOKUP_TARGET_TYPES = new Set(["relation", "lookup", "rollup", "html_template", "file"]);
const NON_ROLLUP_TARGET_TYPES = new Set(["relation", "lookup", "rollup", "formula", "html_template", "file", "select", "json", "longtext"]);

// Set of types we know how to show a constraint form for. Anything outside
// this set falls into the "no extra configuration" hint.
const CONFIGURABLE = new Set([
  "text",
  "longtext",
  "number",
  "percent",
  "duration",
  "date",
  "select",
  "principal",
  "id",
  "relation",
  "lookup",
  "rollup",
  "formula",
  "html_template",
  "file",
]);

/**
 * Renders the constraint / config form for a single field type. Each
 * sub-form is a thin layer that owns its inputs and pushes a new config
 * blob to the parent on every change. The blob's shape mirrors the
 * server-side configSchema in packages/grids/src/field-types/<type>.ts.
 *
 * JSON has no user-tunable constraints in the current schema, so it falls
 * through to a "nothing to configure" hint.
 */
export function FieldConfigEditor(props: EditorProps) {
  const locale = useLocale();
  const t = () => gridsFieldMessages.resolve([locale()]).t;
  // Description has been promoted to a top-level Field column; the new
  // table editor renders its own input for it. This component now focuses
  // purely on type-specific constraint forms.
  return (
    <div class="flex flex-col gap-3">
      <Show when={props.type === "text" || props.type === "longtext"}>
        <TextConstraints config={props.config} onChange={props.onChange} markdown={props.type === "longtext"} />
      </Show>
      <Show when={props.type === "number" || props.type === "percent" || props.type === "duration"}>
        <NumberConstraints config={props.config} onChange={props.onChange} />
      </Show>
      <Show when={props.type === "date"}>
        <DateConstraints config={props.config} onChange={props.onChange} />
      </Show>
      <Show when={props.type === "select"}>
        <SelectConstraints config={props.config} onChange={props.onChange} />
      </Show>
      <Show when={props.type === "principal"}>
        <PrincipalConstraints config={props.config} onChange={props.onChange} />
      </Show>
      <Show when={props.type === "id"}>
        <IdConstraints config={props.config} onChange={props.onChange} />
      </Show>
      <Show when={props.type === "relation"}>
        <RelationConstraints
          config={props.config}
          onChange={props.onChange}
          currentTableId={props.currentTableId}
          otherTables={props.otherTables}
          fieldsByTable={props.fieldsByTable}
        />
      </Show>
      <Show when={props.type === "lookup" || props.type === "rollup"}>
        <LookupRollupConstraints
          config={props.config}
          onChange={props.onChange}
          isRollup={props.type === "rollup"}
          currentTableId={props.currentTableId}
          fieldsByTable={props.fieldsByTable}
        />
      </Show>
      <Show when={props.type === "formula"}>
        <FormulaConstraints
          config={props.config}
          onChange={props.onChange}
          fields={props.fieldsByTable[props.currentTableId] ?? []}
          currentFieldId={props.currentFieldId}
          currentTableId={props.currentTableId}
          baseId={props.baseId}
          tableId={props.tableId}
        />
      </Show>
      <Show when={props.type === "html_template"}>
        <HtmlTemplateConstraints
          config={props.config}
          onChange={props.onChange}
          fields={props.fieldsByTable[props.currentTableId] ?? []}
          currentFieldId={props.currentFieldId}
          currentTableId={props.currentTableId}
        />
      </Show>
      <Show when={props.type === "file"}>
        <FileConstraints config={props.config} onChange={props.onChange} />
      </Show>
      <Show when={!CONFIGURABLE.has(props.type)}>
        <p class="text-xs text-dimmed">{t().noExtraConfig}</p>
      </Show>
    </div>
  );
}

function PrincipalConstraints(props: { config: () => FieldConfigState; onChange: (next: FieldConfigState) => void }) {
  const locale = useLocale();
  const t = () => gridsFieldMessages.resolve([locale()]).t;
  const cardinality = () => (props.config().cardinality === "single" ? "single" : "multiple");
  return (
    <Select
      label={t().cardinality}
      description={t().principalCardinalityDescription}
      value={cardinality}
      onValueChange={(value) => props.onChange({ ...props.config(), cardinality: value })}
      options={[
        { id: "single", label: t().onePrincipal },
        { id: "multiple", label: t().multiplePrincipals },
      ]}
    />
  );
}

// =============================================================================
// Sub-forms — one per type family
// =============================================================================

function TextConstraints(props: { config: () => FieldConfigState; onChange: (next: FieldConfigState) => void; markdown?: boolean }) {
  const locale = useLocale();
  const t = () => gridsFieldMessages.resolve([locale()]).t;
  const cfg = () => props.config();
  const update = (patch: FieldConfigState) => props.onChange({ ...cfg(), ...patch });

  const minLen = () => (typeof cfg().minLength === "number" ? String(cfg().minLength) : "");
  const maxLen = () => (typeof cfg().maxLength === "number" ? String(cfg().maxLength) : "");
  const regex = () => (typeof cfg().regex === "string" ? (cfg().regex as string) : "");
  const markdown = () => Boolean(cfg().markdown);

  // Constraints are TextInputs (not NumberField/NumberInput) because the
  // optional semantics need an empty state — NumberInput clamps to its
  // `min` prop and has no way to represent "no constraint". Parse on
  // input, ignore non-numeric or negative input; empty string clears.
  // Matches DecimalConstraints' pattern for the same reason.
  const onLength = (key: "minLength" | "maxLength", v: string) => {
    const t = v.trim();
    if (t === "") return update({ [key]: undefined });
    const n = Number(t);
    if (!Number.isInteger(n) || n < 0) return;
    update({ [key]: n });
  };

  return (
    <div class="grid grid-cols-2 gap-3">
      <TextInput
        label={t().minLength}
        description={t().noMinimum}
        value={minLen}
        onValueChange={(v) => onLength("minLength", v)}
        placeholder={t().exampleValue({ value: "3" })}
      />
      <TextInput
        label={t().maxLength}
        description={t().noMaximum}
        value={maxLen}
        onValueChange={(v) => onLength("maxLength", v)}
        placeholder={t().exampleValue({ value: "50" })}
      />
      <div class="col-span-2">
        <TextInput
          label={t().pattern}
          description={t().noPattern}
          value={regex}
          onValueChange={(v) => update({ regex: v.trim() === "" ? undefined : v })}
          placeholder={t().exampleValue({ value: "^[A-Z]{3}-\\d+$" })}
          icon="ti ti-regex"
        />
        <div class="mt-2 flex flex-wrap gap-1.5">
          <For
            each={REGEX_PRESETS.map((preset) => ({
              ...preset,
              label:
                preset.label === "Email"
                  ? t().email
                  : preset.label === "Phone"
                    ? t().phone
                    : preset.label === "Slug"
                      ? t().slug
                      : preset.label === "ISBN"
                        ? t().isbn
                        : t().url,
            }))}
          >
            {(preset) => (
              <Button variant="secondary" size="sm" type="button" onClick={() => update({ regex: preset.value })}>
                {preset.label}
              </Button>
            )}
          </For>
        </div>
      </div>
      <Show when={props.markdown}>
        <div class="col-span-2">
          <CheckboxCard
            label={t().renderMarkdown}
            description={t().renderMarkdownDescription}
            icon="ti ti-markdown"
            value={markdown}
            onValueChange={(checked) => update({ markdown: checked || undefined })}
          />
        </div>
      </Show>
    </div>
  );
}

function NumberConstraints(props: { config: () => FieldConfigState; onChange: (next: FieldConfigState) => void }) {
  const locale = useLocale();
  const t = () => gridsFieldMessages.resolve([locale()]).t;
  const cfg = () => props.config();
  const update = (patch: FieldConfigState) => props.onChange({ ...cfg(), ...patch });

  const min = () => (typeof cfg().min === "number" || typeof cfg().min === "string" ? String(cfg().min) : "");
  const max = () => (typeof cfg().max === "number" || typeof cfg().max === "string" ? String(cfg().max) : "");
  const precision = () => (typeof cfg().precision === "number" ? String(cfg().precision) : "");
  const decimalPlaces = () => (typeof cfg().decimalPlaces === "number" ? String(cfg().decimalPlaces) : "");
  const unit = () => (typeof cfg().unit === "string" ? (cfg().unit as string) : "");
  const unitPosition = () => (cfg().unitPosition === "prefix" ? "prefix" : "suffix");
  const integerOnly = () => Boolean(cfg().integerOnly);

  const onBound = (key: "min" | "max", v: string) => {
    const t = v.trim();
    if (t === "") return update({ [key]: undefined });
    update({ [key]: t });
  };
  const onInt = (key: "precision" | "decimalPlaces", v: string, minValue: number, maxValue: number) => {
    const t = v.trim();
    if (t === "") return update({ [key]: undefined });
    const n = Number(t);
    if (!Number.isInteger(n) || n < minValue || n > maxValue) return;
    update({ [key]: n, ...(key === "decimalPlaces" ? { integerOnly: n === 0 ? true : undefined } : {}) });
  };

  return (
    <div class="grid grid-cols-2 gap-3">
      <TextInput
        label={t().minimum}
        description={t().noMinimum}
        value={min}
        onValueChange={(v) => onBound("min", v)}
        placeholder={t().exampleValue({ value: "0" })}
      />
      <TextInput
        label={t().maximum}
        description={t().noMaximum}
        value={max}
        onValueChange={(v) => onBound("max", v)}
        placeholder={t().exampleValue({ value: "100" })}
      />
      <TextInput
        label={t().precision}
        description={t().precisionDescription}
        value={precision}
        onValueChange={(v) => onInt("precision", v, 1, 38)}
        placeholder={t().exampleValue({ value: "16" })}
      />
      <TextInput
        label={t().decimalPlaces}
        description={t().decimalPlacesDescription}
        value={decimalPlaces}
        onValueChange={(v) => onInt("decimalPlaces", v, 0, 20)}
        placeholder={t().exampleValue({ value: "2" })}
      />
      <TextInput
        label={t().unit}
        description={t().unitDescription}
        value={unit}
        onValueChange={(v) => update({ unit: v.trim() === "" ? undefined : v.trim() })}
        placeholder={t().exampleValue({ value: "EUR" })}
      />
      <Select
        label={t().unitPosition}
        value={unitPosition}
        onValueChange={(v) => update({ unitPosition: v })}
        options={[
          { id: "suffix", label: t().afterValue },
          { id: "prefix", label: t().beforeValue },
        ]}
      />
      <div class="col-span-2">
        <CheckboxCard
          label={t().integerOnly}
          description={t().integerOnlyDescription}
          icon="ti ti-number"
          value={integerOnly}
          onValueChange={(checked) => update({ integerOnly: checked || undefined, decimalPlaces: checked ? 0 : undefined })}
        />
      </div>
    </div>
  );
}

function DateConstraints(props: { config: () => FieldConfigState; onChange: (next: FieldConfigState) => void }) {
  const locale = useLocale();
  const t = () => gridsFieldMessages.resolve([locale()]).t;
  const cfg = () => props.config();
  const update = (patch: FieldConfigState) => props.onChange({ ...cfg(), ...patch });

  const min = () => (typeof cfg().min === "string" ? (cfg().min as string) : "");
  const max = () => (typeof cfg().max === "string" ? (cfg().max as string) : "");

  return (
    <div class="grid grid-cols-2 gap-3">
      <div class="col-span-2">
        <CheckboxCard
          label={t().includeTime}
          description={t().includeTimeDescription}
          icon="ti ti-clock"
          value={() => Boolean(cfg().includeTime)}
          onValueChange={(checked) => update({ includeTime: checked || undefined })}
        />
      </div>
      <TextInput
        label={t().minDate}
        description={t().noMinimum}
        value={min}
        onValueChange={(v) => update({ min: v.trim() === "" ? undefined : v.trim() })}
        placeholder={t().exampleValue({ value: "2020-01-01" })}
      />
      <TextInput
        label={t().maxDate}
        description={t().noMaximum}
        value={max}
        onValueChange={(v) => update({ max: v.trim() === "" ? undefined : v.trim() })}
        placeholder={t().exampleValue({ value: "2099-12-31" })}
      />
    </div>
  );
}

// -- select options manager (inline, no nested modal) ------------------------

const DEFAULT_COLORS = ["#3b82f6", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#ec4899", "#14b8a6", "#f97316"];

const slugify = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || `opt-${Math.random().toString(36).slice(2, 7)}`;

type SelectOption = { id: string; label: string; color?: string; description?: string };

function SelectConstraints(props: { config: () => FieldConfigState; onChange: (next: FieldConfigState) => void }) {
  const locale = useLocale();
  const t = () => gridsFieldMessages.resolve([locale()]).t;
  const cfg = () => props.config();
  const multiple = () => cfg().multiple === true;
  const options = () => (Array.isArray(cfg().options) ? (cfg().options as SelectOption[]) : []);

  const writeOptions = (next: SelectOption[]) => props.onChange({ ...cfg(), options: next });

  const addOption = () => {
    const idx = options().length;
    const color = DEFAULT_COLORS[idx % DEFAULT_COLORS.length];
    writeOptions([...options(), { id: `option-${idx + 1}`, label: t().option({ number: idx + 1 }), color }]);
  };

  const updateOption = (i: number, patch: Partial<SelectOption>) => {
    writeOptions(options().map((o, idx) => (idx === i ? { ...o, ...patch } : o)));
  };

  const removeOption = (i: number) => writeOptions(options().filter((_, idx) => idx !== i));

  const onLabelChange = (i: number, label: string) => {
    const opt = options()[i];
    if (!opt) return;
    const previousIdFromLabel = slugify(opt.label);
    if (opt.id === previousIdFromLabel || opt.id.startsWith("option-")) {
      updateOption(i, { label, id: slugify(label) });
    } else {
      updateOption(i, { label });
    }
  };

  return (
    <div class="flex flex-col gap-3">
      <Select
        label={t().mode}
        value={() => (multiple() ? "multiple" : "single")}
        onValueChange={(v) =>
          props.onChange({
            ...cfg(),
            multiple: v === "multiple",
            minSelected: v === "multiple" ? cfg().minSelected : undefined,
            maxSelected: v === "multiple" ? cfg().maxSelected : undefined,
          })
        }
        options={[
          { id: "single", label: t().singleChoice, description: t().singleChoiceDescription },
          { id: "multiple", label: t().multipleChoices, description: t().multipleChoicesDescription },
        ]}
      />
      <div class="flex items-center justify-between">
        <span class="text-xs text-secondary">{t().options}</span>
        <Button variant="success" size="sm" type="button" onClick={addOption}>
          <i class="ti ti-plus" /> {t().addOption}
        </Button>
      </div>
      <Show when={options().length > 0} fallback={<p class="text-xs text-dimmed py-1">{t().noOptions}</p>}>
        <div class="flex flex-col gap-2">
          {/* Column headers — sit above the input cells. The leading w-7
              spacer matches the colour swatch column so "Label" and
              "Value" line up with the inputs below. */}
          <div class="flex items-center gap-2 text-[11px] text-dimmed">
            <span class="w-7 shrink-0" />
            <span class="min-w-44 flex-1">{t().label}</span>
            <span class="min-w-56 flex-1">{t().description}</span>
            <span class="w-40 shrink-0">{t().value}</span>
            <span class="w-5 shrink-0" />
          </div>
          {/* Index (not For) — keys by position. Each keystroke writes
              a fresh options array with new object identities, which a
              reference-keyed For interprets as "row replaced", remounting
              the inputs and stealing focus mid-typing. Index keeps the
              row stable; only the bound accessors update. */}
          <Index each={options()}>
            {(opt, i) => (
              <div class="flex items-center gap-2">
                <ColorInput
                  compact
                  aria-label={t().optionColor({ number: i + 1 })}
                  value={() => opt().color ?? "#3b82f6"}
                  onValueChange={(c) => updateOption(i, { color: c })}
                />
                <div class="flex-1">
                  <TextInput
                    aria-label={t().optionLabel({ number: i + 1 })}
                    placeholder={t().label}
                    icon="ti ti-tag"
                    value={() => opt().label}
                    onValueChange={(v) => onLabelChange(i, v)}
                  />
                </div>
                <div class="flex-1">
                  <TextInput
                    aria-label={t().optionDescription({ number: i + 1 })}
                    placeholder={t().description}
                    icon="ti ti-info-circle"
                    value={() => opt().description ?? ""}
                    onValueChange={(v) => updateOption(i, { description: v.trim() ? v : undefined })}
                    clearable
                  />
                </div>
                <div class="w-40 shrink-0">
                  <TextInput
                    aria-label={t().optionValue({ number: i + 1 })}
                    placeholder={t().value}
                    icon="ti ti-id"
                    value={() => opt().id}
                    onValueChange={(v) => updateOption(i, { id: v })}
                  />
                </div>
                <IconButton
                  variant="ghost"
                  size="xs"
                  class="shrink-0 text-dimmed hover:text-red-500"
                  onClick={() => removeOption(i)}
                  label={t().removeOption}
                >
                  <i class="ti ti-x" />
                </IconButton>
              </div>
            )}
          </Index>
        </div>
      </Show>
      <Show when={multiple()}>
        <div class="grid grid-cols-2 gap-3 pt-2">
          <NumberField
            label={t().minSelected}
            value={() => (typeof cfg().minSelected === "number" ? String(cfg().minSelected) : "")}
            min={0}
            onInput={(v) => {
              const n = v.trim() === "" ? undefined : Number(v);
              if (n === undefined || (Number.isInteger(n) && n >= 0)) {
                props.onChange({ ...cfg(), minSelected: n });
              }
            }}
          />
          <NumberField
            label={t().maxSelected}
            value={() => (typeof cfg().maxSelected === "number" ? String(cfg().maxSelected) : "")}
            min={1}
            onInput={(v) => {
              const n = v.trim() === "" ? undefined : Number(v);
              if (n === undefined || (Number.isInteger(n) && n >= 1)) {
                props.onChange({ ...cfg(), maxSelected: n });
              }
            }}
          />
        </div>
      </Show>
    </div>
  );
}

const ID_STRATEGY_OPTIONS = [
  {
    id: "sequence",
    label: "Sequence",
    icon: "ti ti-sort-ascending-numbers",
    description: "Sequential, e.g. INV-0001. Best for internal numbers.",
  },
  {
    id: "date_sequence",
    label: "Date sequence",
    icon: "ti ti-calendar-stats",
    description: "Date scoped, e.g. ORD-2026-0001. Best for ordering.",
  },
  {
    id: "short_code",
    label: "Short code",
    icon: "ti ti-password",
    description: "Short random, e.g. KIT-7K3Q9. Best for labels.",
  },
  {
    id: "random_code",
    label: "Random code",
    icon: "ti ti-dice",
    description: "Grouped random, e.g. AB7K-P9Q2. Best for sharing.",
  },
  {
    id: "uuid",
    label: "UUID",
    icon: "ti ti-braces",
    description: "Globally unique, e.g. 550e8400... Not human readable.",
  },
  {
    id: "uuidv7",
    label: "UUIDv7",
    icon: "ti ti-clock-code",
    description: "Time sortable, e.g. 019e7a2b... Good for APIs.",
  },
  {
    id: "ulid",
    label: "ULID",
    icon: "ti ti-sort-descending-numbers",
    description: "Time sortable, e.g. 01KTFTMH0E... Good for APIs.",
  },
];

function IdConstraints(props: { config: () => FieldConfigState; onChange: (next: FieldConfigState) => void }) {
  const locale = useLocale();
  const t = () => gridsFieldMessages.resolve([locale()]).t;
  const cfg = () => props.config();
  const update = (patch: FieldConfigState) => props.onChange({ ...cfg(), ...patch });
  const strategy = () => (typeof cfg().strategy === "string" ? (cfg().strategy as string) : "sequence");
  const prefix = () => (typeof cfg().prefix === "string" ? (cfg().prefix as string) : "");
  const padding = () => (typeof cfg().padding === "number" ? String(cfg().padding) : "4");
  const period = () => (typeof cfg().period === "string" ? (cfg().period as string) : "year");
  const assignment = () => (cfg().assignment === "finalization" ? "finalization" : "creation");
  const length = () => (typeof cfg().length === "number" ? String(cfg().length) : "5");
  const groups = () => (typeof cfg().groups === "number" ? String(cfg().groups) : "2");
  const segmentLength = () => (typeof cfg().segmentLength === "number" ? String(cfg().segmentLength) : "4");

  const PrefixInput = () => (
    <TextInput
      label={t().prefix}
      description={t().prefixDescription}
      value={prefix}
      onValueChange={(v) => update({ prefix: v === "" ? undefined : v })}
      placeholder={t().prefixExample}
    />
  );

  const PaddingInput = () => (
    <NumberField
      label={t().padding}
      description={t().paddingDescription}
      value={padding}
      min={1}
      max={16}
      onInput={(v) => {
        const n = Number(v);
        if (Number.isInteger(n) && n >= 1 && n <= 16) update({ padding: n });
      }}
    />
  );

  return (
    <div class="flex flex-col gap-3">
      <Select
        label={t().idType}
        description={t().idTypeDescription}
        value={strategy}
        onValueChange={(v) => {
          if (v === "sequence") props.onChange({ strategy: v, prefix: prefix(), padding: 4, assignment: assignment() });
          else if (v === "date_sequence")
            props.onChange({ strategy: v, prefix: prefix(), padding: 4, period: "year", assignment: assignment() });
          else if (v === "short_code") props.onChange({ strategy: v, prefix: prefix(), length: 5 });
          else if (v === "random_code") props.onChange({ strategy: v, prefix: prefix(), groups: 2, segmentLength: 4 });
          else props.onChange({ strategy: v, prefix: prefix() });
        }}
        options={ID_STRATEGY_OPTIONS.map((option) => ({
          ...option,
          label:
            option.id === "sequence"
              ? t().sequence
              : option.id === "date_sequence"
                ? t().dateSequence
                : option.id === "short_code"
                  ? t().shortCode
                  : option.id === "random_code"
                    ? t().randomCode
                    : option.label,
          description:
            option.id === "sequence"
              ? t().sequenceDescription
              : option.id === "date_sequence"
                ? t().dateSequenceDescription
                : option.id === "short_code"
                  ? t().shortCodeDescription
                  : option.id === "random_code"
                    ? t().randomCodeDescription
                    : option.id === "uuid"
                      ? t().uuidDescription
                      : option.id === "uuidv7"
                        ? t().uuidv7Description
                        : t().ulidDescription,
        }))}
      />
      <Show when={strategy() === "sequence" || strategy() === "date_sequence"}>
        <Select
          label={t().assign}
          description={t().assignDescription}
          value={assignment}
          onValueChange={(value) => update({ assignment: value })}
          options={[
            { id: "creation", label: t().onCreation },
            { id: "finalization", label: t().onFinalization },
          ]}
        />
      </Show>
      <Show when={strategy() === "sequence"}>
        <div class="grid grid-cols-2 gap-3">
          <PrefixInput />
          <PaddingInput />
        </div>
      </Show>
      <Show when={strategy() === "date_sequence"}>
        <div class="grid grid-cols-2 gap-3">
          <PrefixInput />
          <PaddingInput />
        </div>
        <Select
          label={t().reset}
          description={t().resetDescription}
          value={period}
          onValueChange={(v) => update({ period: v })}
          options={[
            { id: "year", label: t().yearly, description: "LOAN-2026-0001", icon: "ti ti-calendar" },
            { id: "month", label: t().monthly, description: "LOAN-202606-0001", icon: "ti ti-calendar-month" },
            { id: "day", label: t().daily, description: "LOAN-20260607-0001", icon: "ti ti-calendar-event" },
          ]}
        />
      </Show>
      <Show when={strategy() === "short_code"}>
        <div class="grid grid-cols-2 gap-3">
          <PrefixInput />
          <NumberField
            label={t().codeLength}
            description={t().codeLengthDescription}
            value={length}
            min={4}
            max={12}
            onInput={(v) => {
              const n = Number(v);
              if (Number.isInteger(n) && n >= 4 && n <= 12) update({ length: n });
            }}
          />
        </div>
      </Show>
      <Show when={strategy() === "random_code"}>
        <PrefixInput />
        <div class="grid grid-cols-2 gap-3">
          <NumberField
            label={t().groups}
            description={t().groupsDescription}
            value={groups}
            min={2}
            max={4}
            onInput={(v) => {
              const n = Number(v);
              if (Number.isInteger(n) && n >= 2 && n <= 4) update({ groups: n });
            }}
          />
          <NumberField
            label={t().charsPerGroup}
            description={t().charsPerGroupDescription}
            value={segmentLength}
            min={3}
            max={6}
            onInput={(v) => {
              const n = Number(v);
              if (Number.isInteger(n) && n >= 3 && n <= 6) update({ segmentLength: n });
            }}
          />
        </div>
      </Show>
      <Show when={strategy() === "sequence" || strategy() === "date_sequence"}>
        <NoticeCard tone="info" role="status" title={t().uniqueNumber} detail={t().uniqueNumberDescription} />
      </Show>
      <Show when={strategy() === "uuid" || strategy() === "uuidv7" || strategy() === "ulid"}>
        <PrefixInput />
      </Show>
    </div>
  );
}

function RelationConstraints(props: {
  config: () => FieldConfigState;
  onChange: (next: FieldConfigState) => void;
  currentTableId: string;
  otherTables: Array<{ id: string; name: string }>;
  fieldsByTable: Record<string, Field[]>;
}) {
  const locale = useLocale();
  const t = () => gridsFieldMessages.resolve([locale()]).t;
  const cfg = () => props.config();
  const update = (patch: FieldConfigState) => props.onChange({ ...cfg(), ...patch });

  const targetTableId = () => (typeof cfg().targetTableId === "string" ? (cfg().targetTableId as string) : "");
  const cardinality = () => (cfg().cardinality === "single" ? "single" : "multiple");

  return (
    <div class="flex flex-col gap-3">
      <Show when={props.otherTables.length > 0} fallback={<p class="text-xs text-amber-600 dark:text-amber-400">{t().noTables}</p>}>
        <Select
          label={t().targetTable}
          value={targetTableId}
          onValueChange={(v) => update({ targetTableId: v })}
          options={props.otherTables.map((t) => ({
            id: t.id,
            label: t.name,
            description: t.id === props.currentTableId ? gridsFieldMessages.resolve([locale()]).t.currentTable : undefined,
          }))}
          placeholder={t().pickTable}
          required
        />
      </Show>
      <Select
        label={t().cardinality}
        value={cardinality}
        onValueChange={(v) => update({ cardinality: v })}
        options={[
          { id: "single", label: t().oneRelation },
          { id: "multiple", label: t().manyRelations },
        ]}
      />
    </div>
  );
}

function LookupRollupConstraints(props: {
  config: () => FieldConfigState;
  onChange: (next: FieldConfigState) => void;
  isRollup: boolean;
  currentTableId: string;
  fieldsByTable: Record<string, Field[]>;
}) {
  const locale = useLocale();
  const t = () => gridsFieldMessages.resolve([locale()]).t;
  const cfg = () => props.config();
  const update = (patch: FieldConfigState) => props.onChange({ ...cfg(), ...patch });

  const relationFieldId = () => (typeof cfg().relationFieldId === "string" ? (cfg().relationFieldId as string) : "");
  const targetFieldId = () => (typeof cfg().targetFieldId === "string" ? (cfg().targetFieldId as string) : "");

  // Relation fields available on THIS table — the lookup/rollup follows
  // one of them to reach the target table.
  const relationFields = () => (props.fieldsByTable[props.currentTableId] ?? []).filter((f) => f.type === "relation" && !f.deletedAt);

  // Resolve the picked relation's target table from its config blob.
  // Empty until the user actually selects a relation field — drives
  // the cascade behaviour for the target-field picker below.
  const selectedRelation = () => relationFields().find((f) => f.id === relationFieldId());
  const targetTableId = () => (selectedRelation()?.config as { targetTableId?: string } | undefined)?.targetTableId;

  // Target-table fields, filtered by operation. Lookup can display most
  // direct values, including formula. Rollup only offers flat fields the
  // SQL aggregation path can handle.
  const targetFields = () => {
    const id = targetTableId();
    if (!id) return [];
    const blocked = props.isRollup ? NON_ROLLUP_TARGET_TYPES : NON_LOOKUP_TARGET_TYPES;
    return (props.fieldsByTable[id] ?? []).filter((f) => !f.deletedAt && !blocked.has(f.type));
  };

  return (
    <div class="flex flex-col gap-3">
      <Show
        when={relationFields().length > 0}
        fallback={
          <p class="text-xs text-amber-600 dark:text-amber-400">
            {t().noRelationFields({ kind: props.isRollup ? t().typeLabel({ type: "rollup" }) : t().typeLabel({ type: "lookup" }) })}
          </p>
        }
      >
        <Select
          label={t().relationField}
          description={t().relationFieldDescription}
          value={relationFieldId}
          // Reset targetFieldId when the relation changes — its old
          // value would point at fields on the previous target table.
          onValueChange={(v) => update({ relationFieldId: v || undefined, targetFieldId: undefined })}
          options={relationFields().map((f) => ({ id: f.id, label: f.name }))}
          placeholder={t().pickRelation}
          required
        />
      </Show>

      <Show when={selectedRelation() && !targetTableId()}>
        <p class="text-xs text-amber-600 dark:text-amber-400">{t().relationWithoutTarget}</p>
      </Show>

      <Show when={targetTableId() && targetFields().length > 0}>
        <Select
          label={t().targetField}
          description={props.isRollup ? t().rollupTargetDescription : t().lookupTargetDescription}
          value={targetFieldId}
          onValueChange={(v) => update({ targetFieldId: v || undefined })}
          options={targetFields().map((f) => ({ id: f.id, label: f.name }))}
          placeholder={t().pickField}
          required
        />
      </Show>

      <Show when={props.isRollup}>
        <Select
          label={t().aggregate}
          value={() => (typeof cfg().agg === "string" ? (cfg().agg as string) : "count")}
          onValueChange={(v) => update({ agg: v })}
          options={[
            { id: "count", label: "count" },
            { id: "sum", label: "sum" },
            { id: "avg", label: "avg" },
            { id: "min", label: "min" },
            { id: "max", label: "max" },
          ]}
        />
      </Show>
    </div>
  );
}

function FileConstraints(props: { config: () => FieldConfigState; onChange: (next: FieldConfigState) => void }) {
  const locale = useLocale();
  const t = () => gridsFieldMessages.resolve([locale()]).t;
  const cfg = () => props.config();
  const update = (patch: FieldConfigState) => props.onChange({ ...cfg(), ...patch });
  const maxFiles = () => (typeof cfg().maxFiles === "number" ? String(cfg().maxFiles) : "10");
  const accept = () => (Array.isArray(cfg().accept) ? (cfg().accept as string[]).join(", ") : "");
  const setAccept = (items: string[]) => update({ accept: items.length > 0 ? items : undefined });
  const appendAccept = (items: string[]) => {
    const current = Array.isArray(cfg().accept) ? (cfg().accept as string[]) : [];
    setAccept([...new Set([...current, ...items])]);
  };

  return (
    <div class="grid grid-cols-1 gap-3">
      <NumberField
        label={t().maxFiles}
        value={maxFiles}
        min={1}
        max={100}
        onInput={(v) => {
          const n = Number(v);
          if (Number.isInteger(n) && n >= 1 && n <= 100) update({ maxFiles: n });
        }}
      />
      <TextInput
        label={t().acceptedFiles}
        description={t().acceptedFilesDescription}
        value={accept}
        onValueChange={(v) => {
          const items = v
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean);
          setAccept(items);
        }}
        placeholder="image/png, application/pdf, .txt"
      />
      <div class="flex flex-wrap gap-1.5">
        <For
          each={FILE_ACCEPT_PRESETS.map((preset) => ({
            ...preset,
            label:
              preset.label === "Images"
                ? t().images
                : preset.label === "Photos"
                  ? t().photos
                  : preset.label === "PDF"
                    ? t().pdf
                    : preset.label === "Spreadsheets"
                      ? t().spreadsheets
                      : preset.label === "Documents"
                        ? t().documents
                        : preset.label === "Text"
                          ? t().textFiles
                          : t().archives,
          }))}
        >
          {(preset) => (
            <Button variant="secondary" size="sm" type="button" onClick={() => appendAccept(preset.values)}>
              {preset.label}
            </Button>
          )}
        </For>
      </div>
      <p class="text-xs text-dimmed leading-snug">{t().globalFileLimit}</p>
    </div>
  );
}

function FormulaConstraints(props: {
  config: () => FieldConfigState;
  onChange: (next: FieldConfigState) => void;
  fields: Field[];
  currentTableId: string;
  currentFieldId?: string;
  baseId?: string;
  tableId?: string;
}) {
  const cfg = () => props.config();
  const expr = () => (typeof cfg().expression === "string" ? (cfg().expression as string) : "");
  return (
    <FormulaExpressionEditor
      value={expr}
      onInput={(value) => props.onChange({ ...cfg(), expression: value })}
      fields={props.fields}
      currentTableId={props.currentTableId}
      currentFieldId={props.currentFieldId}
      baseId={props.baseId}
      tableId={props.tableId}
    />
  );
}

type HtmlTemplatePreviewResponse = {
  ok: boolean;
  diagnostics: Array<{ severity: "error" | "info"; message: string }>;
  rows: Array<{ recordId: string; html: string }>;
};

function HtmlTemplateConstraints(props: {
  config: () => FieldConfigState;
  onChange: (next: FieldConfigState) => void;
  fields: Field[];
  currentFieldId?: string;
  currentTableId: string;
}) {
  const locale = useLocale();
  const t = () => gridsFieldMessages.resolve([locale()]).t;
  const cfg = () => props.config();
  const template = () => (typeof cfg().template === "string" ? (cfg().template as string) : "");
  const css = () => (typeof cfg().css === "string" ? (cfg().css as string) : "");
  const update = (patch: FieldConfigState) => props.onChange({ ...cfg(), ...patch });
  const variables = (): TemplateVariable[] => [
    { name: "record.id", kind: "string", description: t().publicRecordId },
    { name: "record.tableId", kind: "string", description: t().publicTableId },
    { name: "record.version", kind: "number" },
    ...props.fields
      .filter((field) => field.id !== props.currentFieldId && field.type !== "html_template" && !field.deletedAt)
      .map((field) => ({
        name: `record.data.${field.id}`,
        kind: (["number", "percent", "duration", "rollup"].includes(field.type) ? "number" : "string") as TemplateVariable["kind"],
        description: `${field.name} · ${t().typeLabel({ type: field.type })}`,
      })),
    { name: "table.id", kind: "string" },
    { name: "table.name", kind: "string" },
    { name: "app.name", kind: "string" },
    { name: "app.url", kind: "url" },
    { name: "business.legalName", kind: "string" },
    { name: "business.address", kind: "string" },
    { name: "date.iso", kind: "string" },
    { name: "date.yyyyMMdd", kind: "string" },
  ];
  const [preview, setPreview] = createSignal<HtmlTemplatePreviewResponse | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [selectedRecordId, setSelectedRecordId] = createSignal<string | null>(null);
  let token = 0;
  let previewAbort: AbortController | undefined;
  const loadPreview = async (next: { template: string; css: string }) => {
    if (!props.currentFieldId) return;
    const currentToken = ++token;
    previewAbort?.abort();
    const abort = new AbortController();
    previewAbort = abort;
    setLoading(true);
    try {
      const response = await apiClient["html-template-fields"]["by-table"][":tableId"].check.$post(
        {
          param: { tableId: props.currentTableId },
          json: { ...next, currentFieldId: props.currentFieldId },
        },
        { init: { signal: abort.signal } },
      );
      if (!response.ok) throw new Error(await errorMessage(response, t().previewHtmlFailed));
      const data: HtmlTemplatePreviewResponse = await response.json();
      if (currentToken === token) {
        setPreview(data);
        if (!selectedRecordId() || !data.rows.some((row) => row.recordId === selectedRecordId())) {
          setSelectedRecordId(data.rows[0]?.recordId ?? null);
        }
      }
    } catch {
      if (currentToken === token) {
        setPreview({
          ok: false,
          diagnostics: [{ severity: "error", message: t().previewHtmlFailed }],
          rows: [],
        });
        setSelectedRecordId(null);
      }
    } finally {
      if (currentToken === token) {
        previewAbort = undefined;
        setLoading(false);
      }
    }
  };
  const debounced = timed.debounce(loadPreview, 300);
  createEffect(() => debounced.debouncedFn({ template: template(), css: css() }));
  onCleanup(() => {
    token += 1;
    debounced.cancel();
    previewAbort?.abort();
  });
  const selected = () => preview()?.rows.find((row) => row.recordId === selectedRecordId()) ?? preview()?.rows[0];

  return (
    <div class="flex flex-col gap-3" aria-busy={loading()}>
      <TemplateEditor
        value={template()}
        onValueChange={(value) => update({ template: value })}
        variables={variables()}
        lines={12}
        aria-label={t().htmlTemplate}
        placeholder={"<p>{{ record.data.FIELD_ID }}</p>"}
      />
      <TextInput
        label={t().cssOptional}
        description={t().cssDescription}
        value={css}
        onValueChange={(value) => update({ css: value })}
        multiline
        lines={6}
        placeholder="p { color: #18181b; }"
      />
      <div class="flex items-center justify-between gap-2 text-xs">
        <span class="font-medium text-secondary">{t().latestPreview}</span>
        <Show when={loading()}>
          <span class="text-dimmed" role="status" aria-live="polite">
            <i class="ti ti-loader-2 animate-spin" /> {t().rendering}
          </span>
        </Show>
      </div>
      <Show when={!loading() && preview()?.diagnostics.length}>
        <NoticeCard tone={preview()?.ok ? "info" : "danger"} icon={false} role={preview()?.ok ? "status" : "alert"}>
          <For each={preview()?.diagnostics}>{(diagnostic) => <div>{diagnostic.message}</div>}</For>
        </NoticeCard>
      </Show>
      <Show when={(preview()?.rows.length ?? 0) > 1}>
        <div class="flex flex-wrap gap-1.5">
          <For each={preview()?.rows}>
            {(row) => (
              <Button
                variant={row.recordId === selectedRecordId() ? "primary" : "secondary"}
                size="sm"
                type="button"
                aria-pressed={row.recordId === selectedRecordId()}
                onClick={() => setSelectedRecordId(row.recordId)}
              >
                {row.recordId}
              </Button>
            )}
          </For>
        </div>
      </Show>
      <Show when={!loading() && selected()}>
        {(row) => <TemplatePreview html={row().html} title={t().htmlPreviewTitle({ id: row().recordId })} class="min-h-64" />}
      </Show>
      <Show when={!loading() && preview()?.ok && preview()?.diagnostics.length === 0 && preview()?.rows.length === 0}>
        <p class="text-xs text-dimmed">{t().noPreviewRecords}</p>
      </Show>
      <p class="text-xs text-dimmed">{t().escapedValues}</p>
    </div>
  );
}

// =============================================================================
// Tiny shared input helper
// =============================================================================

/**
 * Adapts the string values used by field configuration to the platform
 * NumberInput's numeric value without duplicating conversion at each call site.
 */
function NumberField(props: {
  label: string;
  description?: string;
  value: () => string;
  onInput: (v: string) => void;
  min?: number;
  max?: number;
}) {
  const numericValue = () => {
    const raw = props.value();
    if (raw === "" || raw === undefined) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  };
  return (
    <NumberInput
      label={props.label}
      description={props.description}
      value={numericValue}
      onValueChange={(v) => props.onInput(Number.isFinite(v) ? String(v) : "")}
      min={props.min}
      max={props.max}
    />
  );
}
