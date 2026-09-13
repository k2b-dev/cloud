import type { ComputedColumnSpec } from "../contracts";
import { objectListFormulaColumns, validateObjectList } from "../field-types/object-list";
import { evaluate, renderResult } from "../formula/evaluator";
import type { FormulaRuntimeContext } from "../formula/functions";
import { collectFieldRefs, parseFormula } from "../formula/parser";
import { formulaError } from "../formula/types";
import { normalizeRefKey } from "../ref-syntax";
import type { Field, GridRecord } from "./types";

const formulaSlugMap = (fields: Field[]): Record<string, string> => {
  const slugToId: Record<string, string> = {};
  for (const field of fields) {
    if (field.deletedAt) continue;
    if (field.shortId) {
      slugToId[field.shortId] = field.id;
      slugToId[normalizeRefKey(field.shortId)] = field.id;
    }
    slugToId[normalizeRefKey(field.name)] = field.id;
  }
  return slugToId;
};

const orderFormulasByDeps = (
  formulaFields: Field[],
  slugToId: Record<string, string>,
): {
  ordered: Array<{
    field: Field;
    ast: ReturnType<typeof parseFormula> extends infer R ? (R extends { ok: true; ast: infer A } ? A : never) : never;
  }>;
  cycle: Set<string>;
} => {
  const resolveRef = (ref: string): string => slugToId[ref] ?? slugToId[normalizeRefKey(ref)] ?? ref;
  const compiled = formulaFields
    .map((field) => {
      const expression = (field.config as { expression?: string }).expression;
      if (!expression) return null;
      const parsed = parseFormula(expression);
      if (!parsed.ok) return null;
      const refs = new Set([...collectFieldRefs(parsed.ast)].map(resolveRef));
      return { field, ast: parsed.ast, refs };
    })
    .filter((formula): formula is NonNullable<typeof formula> => formula !== null);

  const formulaIds = new Set(compiled.map((formula) => formula.field.id));
  const byId = new Map(compiled.map((formula) => [formula.field.id, formula]));
  const ordered: typeof compiled = [];
  const visited = new Set<string>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const cycle = new Set<string>();

  // DFS keeps dependency order and marks every member of a back-edge cycle.
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    if (onStack.has(id)) {
      const startIndex = stack.indexOf(id);
      for (let index = startIndex; index < stack.length; index++) cycle.add(stack[index]!);
      return;
    }
    const formula = byId.get(id);
    if (!formula) return;
    stack.push(id);
    onStack.add(id);
    for (const ref of formula.refs) {
      if (formulaIds.has(ref)) visit(ref);
    }
    stack.pop();
    onStack.delete(id);
    visited.add(id);
    ordered.push(formula);
  };
  for (const formula of compiled) visit(formula.field.id);

  return { ordered, cycle };
};

export const enrichRecordsWithFormulas = <T extends Pick<GridRecord, "data" | "fieldErrors"> & { finalizedAt?: string | null }>(
  records: T[],
  fields: Field[],
  options: FormulaRuntimeContext & { skipFormulaFieldIds?: ReadonlySet<string>; useFinalizedFormulaValues?: boolean } = {},
): T[] => {
  const objectLists = fields.filter((field) => !field.deletedAt && field.type === "object_list");
  for (const record of records) {
    if (record.finalizedAt) continue;
    for (const field of objectLists) {
      const calculated = validateObjectList(record.data[field.id], field.config, field.required, { stored: true, context: options });
      if (calculated.ok) {
        record.data[field.id] = calculated.value;
        if (record.fieldErrors) {
          delete record.fieldErrors[field.id];
          if (Object.keys(record.fieldErrors).length === 0) delete record.fieldErrors;
        }
      } else {
        // Retain the editable source value. A diagnostic is not a list value.
        record.fieldErrors = { ...record.fieldErrors, [field.id]: calculated.error };
      }
    }
  }
  const formulaFields = fields.filter(
    (field) => !field.deletedAt && field.type === "formula" && !options.skipFormulaFieldIds?.has(field.id),
  );
  if (formulaFields.length === 0) return records;

  const slugToId = formulaSlugMap(fields);
  const listColumns = objectListFormulaColumns(fields);
  const selectFields = Object.fromEntries(fields.filter((field) => field.type === "select").map((field) => [field.id, field]));
  const { ordered, cycle } = orderFormulasByDeps(formulaFields, slugToId);

  for (const record of records) {
    if (record.finalizedAt && options.useFinalizedFormulaValues !== false) continue;
    // Keep raw evaluator values in scratch so errors propagate before display rendering.
    const scratch: Record<string, unknown> = { ...record.data };
    for (const [id, error] of Object.entries(record.fieldErrors ?? {})) scratch[id] = formulaError(error);
    for (const id of cycle) scratch[id] = formulaError("CYCLE");
    for (const { field, ast } of ordered) {
      if (cycle.has(field.id)) continue;
      scratch[field.id] = evaluate(ast, {
        fields: scratch,
        slugToId,
        listColumns,
        selectFields,
        dateConfig: options.dateConfig,
        now: options.now,
      });
    }
    for (const { field } of ordered) record.data[field.id] = renderResult(scratch[field.id]);
    for (const id of cycle) record.data[id] = renderResult(scratch[id]);
  }
  return records;
};

export const enrichRecordsWithComputedColumns = (
  records: GridRecord[],
  fields: Field[],
  columns: ComputedColumnSpec[] | undefined,
  options: FormulaRuntimeContext & { skipColumnIds?: ReadonlySet<string> } = {},
): GridRecord[] => {
  const computedColumns = (columns ?? []).filter((column) => column.expression.trim().length > 0 && !options.skipColumnIds?.has(column.id));
  if (computedColumns.length === 0 || records.length === 0) return records;

  const slugToId = formulaSlugMap(fields);
  const listColumns = objectListFormulaColumns(fields);
  const selectFields = Object.fromEntries(fields.filter((field) => field.type === "select").map((field) => [field.id, field]));
  const compiled = computedColumns.map((column) => ({ column, parsed: parseFormula(column.expression) }));

  for (const record of records) {
    const scratch: Record<string, unknown> = { ...record.data };
    for (const [id, error] of Object.entries(record.fieldErrors ?? {})) scratch[id] = formulaError(error);
    for (const { column, parsed } of compiled) {
      if (!parsed.ok) {
        record.data[column.id] = renderResult(formulaError("ERROR"));
        continue;
      }
      const value = evaluate(parsed.ast, {
        fields: scratch,
        slugToId,
        listColumns,
        selectFields,
        dateConfig: options.dateConfig,
        now: options.now,
      });
      scratch[column.id] = value;
      record.data[column.id] = renderResult(value);
    }
  }
  return records;
};
