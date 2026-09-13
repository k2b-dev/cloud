import { err, fail, ok, type Result } from "@k2b/stdlib";
import { ViewUiSettingsSchema } from "../contracts";
import { collectFieldRefs, parseFormula } from "../formula/parser";
import { normalizeRefKey } from "../ref-syntax";
import type { SqlClient } from "./audit";
import { authoringText } from "./authoring-messages";
import { buildComputedProjections, computedOutputToFormulaType } from "./computed-projections";
import { mapFieldRow } from "./field-read";
import { compileFormulaFieldToSql, compileFormulaSourceToSql } from "./formula-sql-compiler";

/** Run under the schema lock, after renames and before committing the change. */
export const assertFormulaSchema = async (
  client: SqlClient,
  tableId: string,
  changedFieldId: string,
  locale?: string,
): Promise<Result<void>> => {
  const rows = await client<Record<string, unknown>[]>`
    SELECT f.* FROM grids.fields f JOIN grids.tables t ON t.id = f.table_id
    WHERE t.base_id = (SELECT base_id FROM grids.tables WHERE id = ${tableId}::uuid)
      AND t.deleted_at IS NULL AND f.deleted_at IS NULL
  `;
  const allFields = rows.map(mapFieldRow);
  const refs = new Map(
    allFields.flatMap((field) =>
      [field.id, field.shortId, field.name].map((ref) => [`${field.tableId}:${normalizeRefKey(ref)}`, field.id] as const),
    ),
  );
  const depends = (source: string, ownerTableId: string) => {
    const parsed = parseFormula(source);
    return (
      parsed.ok && [...collectFieldRefs(parsed.ast)].some((ref) => affected.has(refs.get(`${ownerTableId}:${normalizeRefKey(ref)}`) ?? ref))
    );
  };
  const affected = new Set([changedFieldId]);
  const formulas = allFields.filter(
    (field) => field.type === "formula" && typeof field.config.expression === "string" && field.config.expression.trim(),
  );
  for (let previous = -1; previous !== affected.size; ) {
    previous = affected.size;
    for (const field of formulas) {
      if (depends(String(field.config.expression), field.tableId)) affected.add(field.id);
    }
    for (const field of allFields)
      if (
        (field.type === "lookup" || field.type === "rollup") &&
        [field.config.targetFieldId, field.config.relationFieldId].some((ref) => typeof ref === "string" && affected.has(ref))
      )
        affected.add(field.id);
  }
  for (const ownerTableId of new Set(allFields.filter((field) => affected.has(field.id)).map((field) => field.tableId))) {
    const fields = allFields.filter((field) => field.tableId === ownerTableId);
    const targets = formulas.filter((field) => field.tableId === ownerTableId && affected.has(field.id));
    const projections = await buildComputedProjections(fields, { client });
    const computedFieldSql = new Map(
      projections.map((p) => [p.fieldId, { sql: p.expr, type: computedOutputToFormulaType(p.outputType), errorSql: p.errorSql }]),
    );
    for (const field of targets) {
      const result = compileFormulaFieldToSql(field, { fields, computedFieldSql, dateConfig: { locale } });
      if (!result.ok) return fail(err.badInput(authoringText(locale).formulaUnsupported({ detail: `${field.name}: ${result.error}` })));
    }
    const views = await client<
      Array<{ name: string; ui: unknown }>
    >`SELECT name, ui FROM grids.views WHERE table_id = ${ownerTableId}::uuid AND deleted_at IS NULL`;
    for (const view of views) {
      const ui = ViewUiSettingsSchema.safeParse(view.ui);
      if (!ui.success) continue;
      for (const column of ui.data.columns ?? []) {
        if (!("expression" in column) || !depends(column.expression, ownerTableId)) continue;
        const result = compileFormulaSourceToSql(column.expression, {
          fields,
          computedFieldSql,
          dateConfig: { locale },
          documentMetadata: true,
        });
        if (!result.ok)
          return fail(
            err.badInput(authoringText(locale).formulaUnsupported({ detail: `${view.name} / ${column.label}: ${result.error}` })),
          );
      }
    }
  }
  return ok();
};
