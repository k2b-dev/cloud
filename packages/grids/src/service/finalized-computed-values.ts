import { type DateContext, err, fail, ok, type Result } from "@k2b/stdlib";
import { sql } from "bun";
import { validateObjectList } from "../field-types/object-list";
import type { SqlClient } from "./audit";
import { buildComputedProjections, normalizeProjectionValue } from "./computed-projections";
import { getGridsCrudMessages } from "./crud-messages";
import { compileFormulaFieldToSql, type FormulaSqlExpression, type FormulaSqlType } from "./formula-sql-compiler";
import { joinFormulaSql } from "./formula-sql-values";
import { mapRecordRow } from "./record-persistence";
import type { Field } from "./types";

export type ComputedValueSnapshot = {
  values: Record<string, unknown>;
  types: Record<string, FormulaSqlType | "json">;
};

export const calculationApprovalSnapshot = (fields: Field[], computed: ComputedValueSnapshot) => ({
  ...computed,
  // Bind definitions as well as values: a changed formula may coincidentally have the same result.
  schema: fields.filter((field) => !field.deletedAt).map(({ id, name, type, config, required }) => ({ id, name, type, config, required })),
});

export const sameCalculationSnapshot = async (client: SqlClient, previous: unknown, current: unknown): Promise<boolean> => {
  const [row] = await client<Array<{ equal: boolean }>>`SELECT ${previous ?? null}::jsonb IS NOT DISTINCT FROM ${current}::jsonb AS equal`;
  return row?.equal === true;
};

const outputType = (type: string): FormulaSqlType | "json" => {
  if (type === "numeric" || type === "decimal" || type === "int") return "numeric";
  if (type === "timestamptz") return "datetime";
  if (type === "date" || type === "boolean" || type === "json") return type;
  return "text";
};

const capturedExpression = (id: string, type: FormulaSqlType | "json"): FormulaSqlExpression => {
  const text = sql`r.data->>${id}`;
  return {
    type: type === "json" ? "unknown" : type,
    sql:
      type === "numeric"
        ? sql`(${text})::numeric`
        : type === "boolean"
          ? sql`(${text})::boolean`
          : type === "date"
            ? sql`(${text})::date`
            : type === "datetime"
              ? sql`(${text})::timestamptz`
              : type === "json"
                ? sql`r.data->${id}`
                : text,
  };
};

/** Reuses the GQL compiler, including error flags, against one captured input row. */
export const evaluateFinalizationFormulas = async (
  client: SqlClient,
  fields: Field[],
  row: Record<string, unknown>,
  data: Record<string, unknown>,
  related: ComputedValueSnapshot,
  options: { now: Date; dateConfig?: DateContext; locale?: string },
): Promise<Result<ComputedValueSnapshot>> => {
  const messages = getGridsCrudMessages(options.locale);
  const computedFieldSql = new Map(Object.entries(related.types).map(([id, type]) => [id, capturedExpression(id, type)]));
  const expressions: Array<{ field: Field; expression: FormulaSqlExpression }> = [];
  for (const field of fields) {
    if (field.deletedAt || field.type !== "formula") continue;
    const compiled = compileFormulaFieldToSql(field, { fields, computedFieldSql, now: options.now, dateConfig: options.dateConfig });
    if (!compiled.ok) return fail(err.badInput(messages.finalizationCalculationInvalid({ field: field.name })));
    expressions.push({ field, expression: compiled.expression });
  }
  const snapshot: ComputedValueSnapshot = { values: { ...related.values }, types: { ...related.types } };
  if (!expressions.length) return ok(snapshot);
  const fragments = expressions.flatMap(({ expression }, index) => [
    sql`${expression.sql} AS ${sql.unsafe(`v${index}`)}`,
    sql`${expression.errorSql ?? sql`false`} AS ${sql.unsafe(`e${index}`)}`,
  ]);
  // No second read of mutable relation targets between formula evaluations.
  const [result] = await client<Array<Record<string, unknown>>>`
    SELECT ${joinFormulaSql(fragments, sql`, `)}
    FROM (SELECT
      ${data}::jsonb AS data, NULL::timestamptz AS finalized_at,
      ${row.created_at}::timestamptz AS created_at, ${row.updated_at}::timestamptz AS updated_at,
      ${row.deleted_at}::timestamptz AS deleted_at,
      ${row.created_by}::uuid AS created_by, ${row.updated_by}::uuid AS updated_by
    ) r
  `;
  if (!result) throw new Error("Finalization formula evaluation returned no row");
  for (const [index, { field, expression }] of expressions.entries()) {
    if (result[`e${index}`] === true) return fail(err.badInput(messages.finalizationCalculationInvalid({ field: field.name })));
    const raw = result[`v${index}`];
    const type = expression.type;
    snapshot.types[field.id] = type;
    snapshot.values[field.id] =
      raw == null
        ? null
        : normalizeProjectionValue(
            type === "numeric" ? "decimal" : type === "datetime" ? "timestamptz" : type === "unknown" ? "text" : type,
            raw,
          );
    if (field.required && snapshot.values[field.id] == null) {
      return fail(err.badInput(messages.finalizationCalculationInvalid({ field: field.name })));
    }
  }
  return ok(snapshot);
};

export const captureFinalizationInputs = async (
  client: SqlClient,
  tableId: string,
  recordId: string,
  fields: Field[],
  locale?: string,
  options: { now?: Date; dateConfig?: DateContext } = {},
): Promise<Result<{ row: Record<string, unknown>; data: Record<string, unknown>; related: ComputedValueSnapshot }>> => {
  const messages = getGridsCrudMessages(locale);
  // Relations already require the same Base. Recheck stored metadata before copying values.
  const [invalid] = await client<Array<{ invalid: boolean }>>`
    SELECT true AS invalid FROM grids.fields relation
    JOIN grids.tables source ON source.id = relation.table_id
    LEFT JOIN grids.tables target ON target.id::text = relation.config->>'targetTableId' AND target.deleted_at IS NULL
    WHERE source.id = ${tableId}::uuid AND relation.type = 'relation' AND relation.deleted_at IS NULL
      AND EXISTS (SELECT 1 FROM grids.fields derived WHERE derived.table_id = source.id AND derived.deleted_at IS NULL
        AND derived.type IN ('lookup', 'rollup') AND derived.config->>'relationFieldId' = relation.id::text)
      AND (target.id IS NULL OR source.base_id <> target.base_id)
    LIMIT 1
  `;
  if (invalid) return fail(err.badInput(messages.finalizationCalculationScope));
  const scope = await client<Array<{ id: string }>>`
    SELECT id::text FROM grids.tables
    WHERE base_id = (SELECT base_id FROM grids.tables WHERE id = ${tableId}::uuid) AND deleted_at IS NULL
  `;
  const projections = await buildComputedProjections(fields, {
    client,
    ...options,
    authorizedTableIds: new Set(scope.map((table) => table.id)),
  });
  for (const field of fields) {
    if (!field.deletedAt && (field.type === "lookup" || field.type === "rollup") && !projections.some((p) => p.fieldId === field.id)) {
      return fail(err.badInput(messages.finalizationCalculationInvalid({ field: field.name })));
    }
  }
  const fragments = projections.length
    ? sql`, ${joinFormulaSql(
        projections.flatMap((p, index) => [p.fragment, sql`${p.errorSql ?? sql`false`} AS ${sql.unsafe(`ce${index}`)}`]),
        sql`, `,
      )}`
    : sql``;
  const [row] = await client<Array<Record<string, unknown>>>`
    SELECT r.*${fragments} FROM grids.records r WHERE r.id = ${recordId}::uuid AND r.table_id = ${tableId}::uuid
  `;
  if (!row) return fail(err.notFound(messages.record));
  const data = { ...mapRecordRow(row).data };
  const related: ComputedValueSnapshot = { values: {}, types: {} };
  for (const field of fields) {
    if (field.deletedAt || field.type !== "object_list") continue;
    const value = validateObjectList(data[field.id], field.config, field.required, { stored: true, context: options });
    if (!value.ok) return fail(err.badInput(messages.finalizationCalculationInvalid({ field: field.name })));
    related.values[field.id] = value.value;
    related.types[field.id] = "json";
  }
  for (const [index, projection] of projections.entries()) {
    if (row[`ce${index}`] === true) {
      const field = fields.find((item) => item.id === projection.fieldId)!;
      return fail(err.badInput(messages.finalizationCalculationInvalid({ field: field.name })));
    }
    const raw = row[projection.alias];
    related.values[projection.fieldId] = raw == null ? null : normalizeProjectionValue(projection.outputType, raw);
    related.types[projection.fieldId] = outputType(projection.outputType);
  }
  return ok({ row, data: { ...data, ...related.values }, related });
};
