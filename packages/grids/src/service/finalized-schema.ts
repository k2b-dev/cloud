import { toPgUuidArray } from "@k2b/cloud/services";
import { err, fail, ok, type Result } from "@k2b/stdlib";
import type { SqlClient } from "./audit";
import { buildComputedProjections, computedOutputToFormulaType } from "./computed-projections";
import { getGridsCrudMessages } from "./crud-messages";
import { lockFederatedSchemaTables } from "./federated-tables";
import { listByTable } from "./field-read";
import { compileFormulaFieldToSql } from "./formula-sql-compiler";

/** Relations stay within a Base. Lock that schema before checking dependent result types.
 * Finalization holds a shared parent-table lock, so it cannot race this check. */
export const lockFinalizedSchema = async (client: SqlClient, tableId: string): Promise<void> => {
  const tables = await client<Array<{ id: string }>>`
    SELECT id::text FROM grids.tables
    WHERE base_id = (SELECT base_id FROM grids.tables WHERE id = ${tableId}::uuid)
    ORDER BY id
  `;
  const ids = tables.map((table) => table.id);
  await lockFederatedSchemaTables(ids, client);
  await client`SELECT id FROM grids.tables WHERE id = ANY(${toPgUuidArray(ids)}::uuid[]) ORDER BY id FOR UPDATE`;
};

/** Check the prospective schema inside the writer's transaction; failures roll it back. */
export const assertFinalizedResultTypes = async (client: SqlClient, changedTableId: string, locale?: string): Promise<Result<void>> => {
  const [changedMeaning] = await client<Array<{ name: string }>>`
    WITH finalized_schemas AS MATERIALIZED (
      SELECT DISTINCT schema.fields FROM grids.records record
      JOIN grids.record_revisions revision ON revision.id = record.final_revision_id
      JOIN grids.table_schema_revisions schema ON schema.id = revision.schema_revision_id
      WHERE record.finalized_at IS NOT NULL AND record.table_id = ${changedTableId}::uuid
    )
    SELECT current.name FROM finalized_schemas schema
    CROSS JOIN LATERAL jsonb_array_elements(schema.fields) previous
    JOIN grids.fields current ON current.id::text = previous->>'id' AND current.deleted_at IS NULL
    WHERE current.table_id = ${changedTableId}::uuid
      AND (
        (current.type = 'number' AND current.config->>'unit' IS DISTINCT FROM previous->'config'->>'unit')
        OR (current.type = 'percent' AND COALESCE(current.config->>'range', 'percent') IS DISTINCT FROM COALESCE(previous->'config'->>'range', 'percent'))
        OR (current.type = 'date' AND COALESCE(current.config->>'includeTime', 'false') IS DISTINCT FROM COALESCE(previous->'config'->>'includeTime', 'false'))
      )
    LIMIT 1
  `;
  if (changedMeaning) return fail(err.conflict(getGridsCrudMessages(locale).finalizedFieldMeaningChanged({ field: changedMeaning.name })));
  const captured = await client<Array<{ table_id: string; field_id: string; result_type: string }>>`
    SELECT DISTINCT record.table_id::text, captured.key AS field_id, captured.value AS result_type
    FROM grids.records record
    JOIN grids.tables parent ON parent.id = record.table_id
    CROSS JOIN LATERAL jsonb_each_text(COALESCE(record.finalized_computed_types, '{}'::jsonb)) captured
    WHERE record.finalized_at IS NOT NULL
      AND parent.base_id = (SELECT base_id FROM grids.tables WHERE id = ${changedTableId}::uuid)
  `;
  for (const tableId of new Set(captured.map((row) => row.table_id))) {
    const fields = await listByTable(tableId, false, client);
    const projections = await buildComputedProjections(fields, { client });
    const computedFieldSql = new Map(
      projections.map((projection) => [
        projection.fieldId,
        { sql: projection.expr, type: computedOutputToFormulaType(projection.outputType) },
      ]),
    );
    for (const row of captured.filter((item) => item.table_id === tableId)) {
      const field = fields.find((item) => item.id === row.field_id);
      // Deleted fields remain available in the immutable schema revision.
      if (!field) continue;
      const formula = field.type === "formula" ? compileFormulaFieldToSql(field, { fields, computedFieldSql }) : null;
      const projection = projections.find((item) => item.fieldId === field.id);
      const actual = formula
        ? formula.ok
          ? formula.expression.type
          : null
        : field.type === "object_list" || projection?.outputType === "json"
          ? "json"
          : computedFieldSql.get(field.id)?.type;
      if (actual !== row.result_type)
        return fail(err.conflict(getGridsCrudMessages(locale).finalizedResultTypeChanged({ field: field.name })));
    }
  }
  return ok();
};
