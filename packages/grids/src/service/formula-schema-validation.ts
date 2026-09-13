import { err, fail, ok, type Result } from "@k2b/stdlib";
import { collectFieldRefs, parseFormula } from "../formula/parser";
import { normalizeRefKey } from "../ref-syntax";
import type { SqlClient } from "./audit";
import { authoringText } from "./authoring-messages";
import { buildComputedProjections, computedOutputToFormulaType } from "./computed-projections";
import { mapFieldRow } from "./field-read";
import { compileFormulaFieldToSql } from "./formula-sql-compiler";

/** Run under the schema lock, after renames and before committing the change. */
export const assertFormulaSchema = async (
  client: SqlClient,
  tableId: string,
  changedFieldId: string,
  locale?: string,
): Promise<Result<void>> => {
  const rows = await client<Record<string, unknown>[]>`SELECT * FROM grids.fields WHERE table_id = ${tableId}::uuid AND deleted_at IS NULL`;
  const fields = rows.map(mapFieldRow);
  const refs = new Map(
    fields.flatMap((field) => [field.id, field.shortId, field.name].map((ref) => [normalizeRefKey(ref), field.id] as const)),
  );
  const affected = new Set([changedFieldId]);
  const formulas = fields.filter(
    (field) => field.type === "formula" && typeof field.config.expression === "string" && field.config.expression.trim(),
  );
  for (let previous = -1; previous !== affected.size; ) {
    previous = affected.size;
    for (const field of formulas) {
      const parsed = parseFormula(String(field.config.expression));
      if (parsed.ok && [...collectFieldRefs(parsed.ast)].some((ref) => affected.has(refs.get(normalizeRefKey(ref)) ?? ref)))
        affected.add(field.id);
    }
  }
  const targets = formulas.filter((field) => affected.has(field.id));
  if (!targets.length) return ok();
  const projections = await buildComputedProjections(fields, { client });
  const computedFieldSql = new Map(
    projections.map((p) => [p.fieldId, { sql: p.expr, type: computedOutputToFormulaType(p.outputType), errorSql: p.errorSql }]),
  );
  for (const field of targets) {
    const result = compileFormulaFieldToSql(field, { fields, computedFieldSql });
    if (!result.ok) return fail(err.badInput(authoringText(locale).formulaUnsupported({ detail: `${field.name}: ${result.error}` })));
  }
  return ok();
};
