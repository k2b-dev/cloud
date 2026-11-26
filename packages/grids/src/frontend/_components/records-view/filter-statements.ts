/**
 * The filters of a table that the v2 FilterBar can state: one statement per field, declared at run time from the
 * table's fields with `defineListQuery`. Each statement is one filter leaf of the records query and lives in the
 * address as `f-<fieldId>`; every other leaf (another verb, a second leaf on the same field, people) stays in the
 * `filter` JSON parameter and its dialog. Old addresses with only `filter=` keep working: their leaves that fit
 * become statements the next time the page writes its address.
 *
 * k2b-ui gap: list-query has one verb per field, no negation, no empty/not empty and exclusive bounds (lane N);
 * those leaves stay in the dialog until it does.
 */
import { defineListQuery, field, type ListQuery, type ListQueryField, type ListQueryState } from "@k2b/ui/v2/list-query";
import type { PublicField as Field } from "../../../api/public-dto";
import type { RecordQuery } from "../../../contracts";
import type { FilterLeaf } from "../toolbar/FilterPanel";
import { recordsScreenMessages } from "./screen-messages";

export type FilterStatements = { query: ListQuery; fields: readonly Field[] };
type State = ListQueryState;

/** The address parameter of a field's statement. Field ids are short ids, so the name stays readable. */
export const statementKey = (fieldId: string) => `f-${fieldId}`;
const fieldIdOf = (key: string) => key.slice(2);

/**
 * The records address's other parameters, which the declaration leaves alone. `sort` and `q` are names list-query
 * reserves: the bar may drop them while it writes, and the records page writes its whole address right after.
 */
const RECORDS_PARAMS = [
  "filter",
  "meta",
  "groupBy",
  "groupSort",
  "aggregations",
  "columns",
  "trash",
  "qFields",
  "cursor",
  "record",
  "cv",
  "cd",
  "cardSize",
  "edit",
];

const DATE_PRESETS = ["today", "this-week", "this-month"] as const;
const DATE_PRESET_OP: Record<(typeof DATE_PRESETS)[number], string> = {
  today: "today",
  "this-week": "thisWeek",
  "this-month": "thisMonth",
};

type SelectOption = { id: string; label: string };
const selectOptions = (target: Field): SelectOption[] =>
  ((target.config as { options?: SelectOption[] }).options ?? []).filter((option) => option.id && !option.id.includes(","));

export type LookupSource = {
  load: (target: Field, text: string, context: { signal: AbortSignal; limit: number }) => Promise<{ value: string; label: string }[]>;
  /** Names of chosen linked records the page already knows (the query's relation labels). */
  names: () => Record<string, string>;
};

/** The statement field of a table field, or null when the field is only filtered in the dialog. */
const statementField = (target: Field, locale: string, lookup?: LookupSource): ListQueryField | null => {
  const { t } = recordsScreenMessages.resolve([locale]);
  const label = target.name;
  switch (target.type) {
    case "select": {
      const options = selectOptions(target);
      return options.length ? field.choice({ label, options: options.map((option) => ({ value: option.id, label: option.label })) }) : null;
    }
    case "boolean":
      return field.bool({ label, labels: { yes: t.yes, no: t.no } });
    case "number":
    case "percent":
    case "duration":
      return field.numberRange({ label, unit: (target.config as { unit?: string }).unit });
    case "date":
      return field.dateRange({
        label,
        presets: [
          { value: "today", label: t.today },
          { value: "this-week", label: t.thisWeek },
          { value: "this-month", label: t.thisMonth },
        ],
      });
    case "relation": {
      if (!(target.config as { targetTableId?: string }).targetTableId) return null;
      return field.lookup({
        label,
        load: async (text, context) => ({ items: lookup ? await lookup.load(target, text, context) : [] }),
        resolve: async (values) => values.map((value) => ({ value, label: lookup?.names()[value] ?? value })),
      });
    }
    case "text":
    case "longtext":
    case "id":
      return field.text({ label, op: t.contains });
    default:
      return null;
  }
};

/** The statements of a table's filterable fields, in field order. */
export const recordsFilterStatements = (fields: readonly Field[], locale: string, lookup?: LookupSource): FilterStatements => {
  const declared: Record<string, ListQueryField> = {};
  for (const each of [...fields].filter((candidate) => !candidate.deletedAt).sort((a, b) => a.position - b.position)) {
    const statement = statementField(each, locale, lookup);
    if (statement) declared[statementKey(each.id)] = statement;
  }
  const { t } = recordsScreenMessages.resolve([locale]);
  const query = defineListQuery({
    key: "grids.records",
    fields: declared,
    sort: { fixed: { field: "position", direction: "asc", label: t.records } },
    pageParams: RECORDS_PARAMS,
  }) as unknown as ListQuery;
  return { query, fields };
};

const dayShift = (day: string, days: number) => {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};
const numberOf = (value: unknown) =>
  typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;

/** The statement value a leaf states, or undefined when the leaf needs the dialog. */
const valueOfLeaf = (target: Field, leaf: FilterLeaf): unknown => {
  switch (target.type) {
    case "select":
      if (leaf.op === "is" && typeof leaf.value === "string") return [leaf.value];
      if (leaf.op === "isAnyOf" && Array.isArray(leaf.value) && leaf.value.every((each) => typeof each === "string")) return leaf.value;
      return undefined;
    case "boolean":
      return leaf.op === "=" && typeof leaf.value === "boolean" ? leaf.value : undefined;
    case "number":
    case "percent":
    case "duration": {
      if (leaf.op === "between" && Array.isArray(leaf.value)) {
        const [min, max] = leaf.value.map(numberOf);
        return Number.isFinite(min) && Number.isFinite(max) && (min as number) <= (max as number) ? { min, max } : undefined;
      }
      const value = numberOf(leaf.value);
      if (!Number.isFinite(value)) return undefined;
      return leaf.op === ">=" ? { min: value } : leaf.op === "<=" ? { max: value } : undefined;
    }
    case "date": {
      const preset = (Object.entries(DATE_PRESET_OP) as [string, string][]).find(([, op]) => op === leaf.op)?.[0];
      if (preset) return { kind: "preset", preset };
      const day = (value: unknown) => (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined);
      if (leaf.op === "between" && Array.isArray(leaf.value)) {
        const [from, to] = leaf.value.map(day);
        return from && to && from <= to ? { kind: "range", from, to } : undefined;
      }
      if (leaf.op === "after" && day(leaf.value)) return { kind: "range", from: dayShift(day(leaf.value) as string, 1) };
      if (leaf.op === "before" && day(leaf.value)) return { kind: "range", to: dayShift(day(leaf.value) as string, -1) };
      return undefined;
    }
    case "relation":
      return leaf.op === "containsAny" && Array.isArray(leaf.value) && leaf.value.every((each) => typeof each === "string")
        ? leaf.value
        : undefined;
    case "text":
    case "longtext":
    case "id":
      return leaf.op === "contains" && typeof leaf.value === "string" && leaf.value ? leaf.value : undefined;
    default:
      return undefined;
  }
};

/** The leaf a statement value stands for. */
const leafOfValue = (target: Field, value: unknown): FilterLeaf | null => {
  if (value === undefined) return null;
  switch (target.type) {
    case "select":
      return { fieldId: target.id, op: "isAnyOf", value };
    case "boolean":
      return { fieldId: target.id, op: "=", value };
    case "number":
    case "percent":
    case "duration": {
      const { min, max } = value as { min?: number; max?: number };
      if (min !== undefined && max !== undefined) return { fieldId: target.id, op: "between", value: [min, max] };
      return min !== undefined ? { fieldId: target.id, op: ">=", value: min } : { fieldId: target.id, op: "<=", value: max };
    }
    case "date": {
      const period = value as { kind: "preset"; preset: (typeof DATE_PRESETS)[number] } | { kind: "range"; from?: string; to?: string };
      if (period.kind === "preset") return { fieldId: target.id, op: DATE_PRESET_OP[period.preset] };
      if (period.from && period.to) return { fieldId: target.id, op: "between", value: [period.from, period.to] };
      return period.from
        ? { fieldId: target.id, op: "after", value: dayShift(period.from, -1) }
        : { fieldId: target.id, op: "before", value: dayShift(period.to as string, 1) };
    }
    case "relation":
      return { fieldId: target.id, op: "containsAny", value };
    default:
      return { fieldId: target.id, op: "contains", value };
  }
};

/** The leaves of an AND filter, or none for any other shape (which then stays whole in the dialog). */
export const filterLeaves = (filter: RecordQuery["filter"]): FilterLeaf[] | null => {
  if (!filter) return [];
  const node = filter as { op?: string; filters?: unknown[] };
  if (node.op !== "AND" || !Array.isArray(node.filters)) return null;
  return node.filters.every((leaf) => typeof leaf === "object" && leaf !== null && "fieldId" in leaf && "op" in leaf)
    ? (node.filters as FilterLeaf[])
    : null;
};

/** Splits a filter into the statements the bar shows and the leaves the dialog keeps. */
export const splitFilter = (statements: FilterStatements, filter: RecordQuery["filter"]): { state: State; rest: FilterLeaf[] | null } => {
  const leaves = filterLeaves(filter);
  let state = statements.query.reset();
  if (leaves === null) return { state, rest: null };
  const rest: FilterLeaf[] = [];
  const taken = new Set<string>();
  for (const leaf of leaves) {
    const key = statementKey(leaf.fieldId);
    const target = statements.fields.find((each) => each.id === leaf.fieldId);
    const value = target && key in statements.query.fields && !taken.has(key) ? valueOfLeaf(target, leaf) : undefined;
    const next = value === undefined ? undefined : statements.query.set(state, key as never, value as never);
    if (next) {
      state = next;
      taken.add(key);
    } else rest.push(leaf);
  }
  return { state, rest };
};

/** Joins the bar's statements and the dialog's leaves into the query's filter. */
export const joinFilter = (statements: FilterStatements, state: State, rest: FilterLeaf[]): RecordQuery["filter"] => {
  const leaves = Object.entries(state.filters as Record<string, unknown>).flatMap(([key, value]) => {
    const target = statements.fields.find((each) => each.id === fieldIdOf(key));
    const leaf = target ? leafOfValue(target, value) : null;
    return leaf ? [leaf] : [];
  });
  const all = [...leaves, ...rest];
  return all.length ? ({ op: "AND", filters: all } as RecordQuery["filter"]) : undefined;
};

/** The statements an address holds, as leaves; used beside the address's `filter` JSON. */
export const statementLeaves = (statements: FilterStatements, params: URLSearchParams): FilterLeaf[] => {
  const filter = joinFilter(statements, statements.query.parse(params).state, []);
  return filterLeaves(filter) ?? [];
};
