import { err, fail, ok, type Result } from "@k2b/stdlib";
import { isDateNowDefault } from "../field-defaults";

export { materializeFieldDefault } from "../field-defaults";

import { sql } from "bun";
import { getFieldType, getRecordWritableFieldType } from "../field-types";
import { ObjectListConfigSchema, objectListInputValue } from "../field-types/object-list";
import { collectFieldRefs, parseFormula } from "../formula/parser";
import { normalizeRefKey } from "../ref-syntax";
import { getGridsCrudMessages } from "./crud-messages";
import { compileFormulaAstToSql } from "./formula-sql-compiler";
import { compileObjectListRow } from "./object-list-sql";

export const validateFieldConfig = (type: string, config: Record<string, unknown>, locale?: string): Result<unknown> => {
  const messages = getGridsCrudMessages(locale);
  const fieldType = getFieldType(type);
  if (!fieldType) return fail(err.badInput(messages.unknownFieldType({ type })));
  const parsed = fieldType.configSchema.safeParse(config);
  if (!parsed.success) {
    // Surface the first issue's message so users see WHY the config was
    // rejected (e.g. "decimal places cannot exceed precision") instead of a
    // generic "invalid config".
    const firstIssue = parsed.error.issues[0];
    const detail = firstIssue?.message ?? messages.invalidFieldConfigDetail;
    return fail(err.badInput(messages.invalidFieldConfig({ type, detail })));
  }
  if (type === "object_list") {
    // A list is read through SQL as well as the write validator. Reject
    // unsupported calculations at authoring time, not on the first record read.
    const compiled = compileObjectListRow(parsed.data, "item", (ast, resolveField) =>
      compileFormulaAstToSql(ast, { fields: [], recordAlias: "item", resolveField }),
    );
    if (!compiled.ok) return fail(err.badInput(messages.invalidFieldConfig({ type, detail: compiled.error })));
  }
  return ok(parsed.data);
};

export const validateDefaultValue = (type: string, config: Record<string, unknown>, value: unknown, locale?: string): Result<unknown> => {
  const messages = getGridsCrudMessages(locale);
  if (value === undefined || value === null) return ok(null);
  if (type === "date" && isDateNowDefault(value)) return ok(value);
  if (typeof value === "object" && value !== null && "kind" in value) {
    return fail(err.badInput(messages.invalidDefault));
  }
  const fieldType = getRecordWritableFieldType(type);
  if (!fieldType) return fail(err.badInput(messages.defaultUnsupported({ type })));
  const v = fieldType.validate(value, config, false, { locale });
  if (!v.ok) return fail(err.badInput(messages.invalidDefaultDetail({ detail: v.error })));
  if (type === "object_list") {
    const parsed = ObjectListConfigSchema.safeParse(config);
    if (!parsed.success) return fail(err.badInput(messages.invalidFieldConfigDetail));
    return ok(objectListInputValue(v.value, parsed.data));
  }
  return ok(v.value);
};

/**
 * DB-context validation for relation / lookup / rollup configs. Only
 * the field service knows the source field's table + base, so this
 * lives here rather than in the shape-only per-handler config schema.
 * Target resolution is scoped to the source base so a known table UUID
 * cannot create a cross-base relation or computed-field data leak.
 *
 * Same-base only: target table must share the source field's base.
 * Cross-table consistency: lookup/rollup relationFieldId must be a
 * relation on the source table; targetFieldId must belong to that
 * relation's target table.
 */
export const validateLinkOrComputedConfig = async (
  type: string,
  config: Record<string, unknown>,
  sourceTableId: string,
  locale?: string,
): Promise<Result<void>> => {
  const messages = getGridsCrudMessages(locale);
  if (type === "formula") {
    const expression = (config as { expression?: unknown }).expression;
    if (typeof expression !== "string" || !expression.trim()) return ok();
    const parsed = parseFormula(expression);
    if (!parsed.ok) return ok();
    const rows = await sql<Array<{ id: string; short_id: string; name: string; type: string }>>`
      SELECT id::text, short_id, name, type
      FROM grids.fields
      WHERE table_id = ${sourceTableId}::uuid AND deleted_at IS NULL
    `;
    const htmlRefs = new Set(
      rows
        .filter((field) => field.type === "html_template")
        .flatMap((field) => [field.id, normalizeRefKey(field.short_id), normalizeRefKey(field.name)]),
    );
    if ([...collectFieldRefs(parsed.ast)].some((ref) => htmlRefs.has(ref) || htmlRefs.has(normalizeRefKey(ref)))) {
      return fail(err.badInput(messages.formulaHtmlReference));
    }
    return ok();
  }
  if (type !== "relation" && type !== "lookup" && type !== "rollup") return ok();

  // Resolve source table's base scope once.
  const [sourceTable] = await sql<{ base_id: string }[]>`
    SELECT base_id::text AS base_id FROM grids.tables WHERE id = ${sourceTableId}::uuid AND deleted_at IS NULL
  `;
  if (!sourceTable) return fail(err.badInput(messages.sourceTableNotFound));
  const baseId = sourceTable.base_id;

  if (type === "relation") {
    const cfg = config as { targetTableId?: string };
    if (!cfg.targetTableId) return ok(); // pre-config; field can be created and wired up later.

    const [target] = await sql<{ base_id: string }[]>`
      SELECT base_id::text AS base_id FROM grids.tables
      WHERE id = ${cfg.targetTableId}::uuid AND deleted_at IS NULL
    `;
    if (!target) return fail(err.badInput(messages.relationTargetNotFound));
    if (target.base_id !== baseId) {
      return fail(err.badInput(messages.relationTargetDifferentBase));
    }
    return ok();
  }

  // lookup / rollup
  const cfg = config as { relationFieldId?: string; targetFieldId?: string };
  if (!cfg.relationFieldId || !cfg.targetFieldId) return ok(); // pre-config

  const [relField] = await sql<{ table_id: string; type: string; config: unknown }[]>`
    SELECT table_id::text AS table_id, type, config
    FROM grids.fields WHERE id = ${cfg.relationFieldId}::uuid AND deleted_at IS NULL
  `;
  if (!relField) return fail(err.badInput(messages.relationFieldNotFound));
  if (relField.type !== "relation") {
    return fail(err.badInput(messages.relationFieldWrongType));
  }
  if (relField.table_id !== sourceTableId) {
    return fail(err.badInput(messages.relationFieldWrongTable));
  }
  const relTargetTableId = (relField.config as { targetTableId?: string } | null)?.targetTableId;
  if (!relTargetTableId) {
    return fail(err.badInput(messages.relationTargetMissing));
  }
  const [targetField] = await sql<{ table_id: string; type: string }[]>`
    SELECT table_id::text AS table_id, type FROM grids.fields
    WHERE id = ${cfg.targetFieldId}::uuid AND deleted_at IS NULL
  `;
  if (!targetField) return fail(err.badInput(messages.targetFieldNotFound));
  if (targetField.table_id !== relTargetTableId) {
    return fail(err.badInput(messages.targetFieldWrongTable));
  }
  if (targetField.type === "html_template") {
    return fail(err.badInput(messages.htmlLookupTargetUnsupported));
  }
  return ok();
};
