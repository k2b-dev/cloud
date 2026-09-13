import { err, fail, ok, type Result } from "@k2b/stdlib";
import { ObjectListConfigSchema } from "../field-types/object-list";
import { canonicalizeFormulaOptions, type FormulaSelect } from "../formula/select-binding";
import { normalizeRefKey } from "../ref-syntax";
import type { SqlClient } from "./audit";
import { authoringText } from "./authoring-messages";
import { mapFieldRow } from "./field-read";
import type { Field } from "./types";

export const bindAuthoredFormula = (
  source: string,
  fields: ReadonlyArray<{ shortId: string; name: string; type: string; config: Field["config"] }>,
  locale?: string,
) => {
  const refs = new Map<string, FormulaSelect>();
  for (const field of fields) {
    if (field.type !== "select") continue;
    const select: FormulaSelect = { name: field.name, config: field.config };
    refs.set(normalizeRefKey(field.shortId), select);
    refs.set(normalizeRefKey(field.name), select);
  }
  return canonicalizeFormulaOptions(source, (ref) => refs.get(normalizeRefKey(ref)), locale);
};

/** Called only for the field being authored, under its table's schema lock. */
export const bindAuthoredField = async (client: SqlClient, field: Field, locale?: string): Promise<Result<Field>> => {
  if (field.type === "formula" && typeof field.config.expression === "string") {
    const rows = await client<
      Record<string, unknown>[]
    >`SELECT * FROM grids.fields WHERE table_id = ${field.tableId}::uuid AND deleted_at IS NULL`;
    const fields = rows.map(mapFieldRow).filter((item) => item.id !== field.id);
    const bound = bindAuthoredFormula(field.config.expression, [...fields, field], locale);
    if (!bound.ok) return fail(err.badInput(authoringText(locale).formulaUnsupported({ detail: bound.error })));
    return ok({ ...field, config: { ...field.config, expression: bound.source } });
  }
  if (field.type === "object_list") {
    const parsed = ObjectListConfigSchema.safeParse(field.config);
    if (!parsed.success) return fail(err.badInput(parsed.error.message));
    const fields = parsed.data.fields.map((column) => ({ ...column, shortId: column.id }));
    for (const column of parsed.data.fields) {
      if (!column.formula?.expression) continue;
      const bound = bindAuthoredFormula(column.formula.expression, fields, locale);
      if (!bound.ok) return fail(err.badInput(authoringText(locale).formulaUnsupported({ detail: bound.error })));
      column.formula.expression = bound.source;
    }
    const validated = ObjectListConfigSchema.safeParse(parsed.data);
    if (!validated.success) return fail(err.badInput(validated.error.message));
    return ok({ ...field, config: validated.data });
  }
  return ok(field);
};
