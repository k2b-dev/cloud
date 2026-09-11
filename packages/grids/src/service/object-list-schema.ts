import { err, fail, ok, type Result } from "@k2b/stdlib";
import { ObjectListConfigSchema, validateObjectList } from "../field-types/object-list";
import type { SqlClient } from "./audit";
import { getGridsCrudMessages } from "./crud-messages";
import type { Field } from "./types";

/** Called under the table's schema lock. Never silently rewrite existing list values. */
export const validateObjectListSchemaChange = async (
  client: SqlClient,
  field: Field,
  config: Record<string, unknown>,
  required: boolean,
  locale?: string,
): Promise<Result<void>> => {
  if (field.type !== "object_list") return ok();
  const messages = getGridsCrudMessages(locale);
  const next = ObjectListConfigSchema.safeParse(config);
  if (!next.success) return fail(err.badInput(messages.invalidFieldConfigDetail));
  const [current] = await client<Array<{ config: unknown }>>`SELECT config FROM grids.fields WHERE id = ${field.id}::uuid`;
  const previous = ObjectListConfigSchema.safeParse(current?.config);
  if (!previous.success) return fail(err.badInput(messages.invalidFieldConfigDetail));
  const changedTypes = previous.data.fields.filter((column) => {
    const replacement = next.data.fields.find((item) => item.id === column.id);
    return replacement && replacement.type !== column.type;
  });
  const changedMeaning = previous.data.fields.filter((column) => {
    const replacement = next.data.fields.find((item) => item.id === column.id);
    if (!replacement) return true;
    return (
      (column.type === "number" && column.config.unit !== replacement.config.unit) ||
      (column.type === "percent" && (column.config.range ?? "percent") !== (replacement.config.range ?? "percent")) ||
      (column.type === "date" && Boolean(column.config.includeTime) !== Boolean(replacement.config.includeTime))
    );
  });
  // Finalized cells are already calculated values. Reuse the same scalar
  // validators, but never evaluate the replacement formulas against them.
  const finalizedValueConfig = {
    ...next.data,
    fields: next.data.fields.map((column) => ({ ...column, formula: undefined })),
  };
  let after: string | null = null;
  for (;;) {
    // Include deleted records: restoring one must not reinterpret its stored data.
    const records: Array<{ id: string; value: unknown; finalized: boolean }> = await client`
      SELECT id::text, data->${field.id} AS value, finalized_at IS NOT NULL AS finalized
      FROM grids.records
      WHERE table_id = ${field.tableId}::uuid AND (${after}::uuid IS NULL OR id > ${after}::uuid)
      ORDER BY id LIMIT 100
    `;
    if (records.length === 0) return ok();
    for (const record of records) {
      const validation = validateObjectList(record.value, record.finalized ? finalizedValueConfig : next.data, required, {
        stored: true,
        context: { locale },
      });
      if (!validation.ok)
        return fail(err.conflict(messages.objectListSchemaInvalidatesValues({ field: field.name, detail: validation.error })));
      if (Array.isArray(record.value)) {
        for (const column of [...changedTypes, ...(record.finalized ? changedMeaning : [])]) {
          if (
            record.value.some(
              (row: unknown) => typeof row === "object" && row !== null && column.id in row && Reflect.get(row, column.id) != null,
            )
          ) {
            return fail(err.conflict(messages.objectListColumnMeaningChanged({ field: column.name })));
          }
        }
      }
    }
    after = records.at(-1)!.id;
  }
};
