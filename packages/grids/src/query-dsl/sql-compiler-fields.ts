import { sql } from "bun";
import { outputSqlTypeForField, storageOf } from "../service/field-storage";
import {
  compileFormulaFieldToSql,
  compileFormulaSourceToSql,
  type FormulaSqlExpression,
  type FormulaSqlFieldResolver,
  type FormulaSqlType,
} from "../service/formula-sql-compiler";
import { compileObjectListProjection } from "../service/object-list-projection";
import type { Field } from "../service/types";
import type { DslJoinedColumn } from "./resolver";
import type { DslSqlCompileOptions, DslSqlOutputColumn } from "./sql-compiler-types";

export const aliveFields = (fields: Field[]): Field[] => fields.filter((field) => !field.deletedAt).sort((a, b) => a.position - b.position);

export const fieldById = (fields: Field[], fieldId: string): Field | null =>
  fields.find((field) => field.id === fieldId && !field.deletedAt) ?? null;

export const isImplicitlySelectableField = (field: Field): boolean => {
  const kind = storageOf(field).kind;
  if (kind === "unknown") return false;
  if (kind === "computed") return field.type === "formula" || field.type === "lookup" || field.type === "rollup";
  return true;
};

export const outputTypeFor = (field: Field): DslSqlOutputColumn["sqlType"] => outputSqlTypeForField(field);

const compileFormulaFieldProjection = (params: {
  field: Field;
  fields: Field[];
  recordAlias: string;
  timeZone?: string;
  computedFieldSql?: Map<string, FormulaSqlExpression>;
  resolveField?: FormulaSqlFieldResolver;
}): { ok: true; projection: unknown; sqlType: FormulaSqlType } | { ok: false; error: string } => {
  const expression = (params.field.config as { expression?: unknown }).expression;
  if (typeof expression !== "string" || expression.trim().length === 0) {
    return { ok: false, error: `formula field "${params.field.name}" has no expression` };
  }
  const compiled = compileFormulaFieldToSql(params.field, {
    fields: params.fields,
    recordAlias: params.recordAlias,
    dateConfig: params.timeZone ? { timeZone: params.timeZone } : undefined,
    computedFieldSql: params.computedFieldSql,
    resolveField: params.resolveField,
  });
  if (!compiled.ok) return { ok: false, error: `formula field "${params.field.name}": ${compiled.error}` };
  return { ok: true, projection: compiled.expression.sql, sqlType: compiled.expression.type };
};

const relationTargetTableId = (field: Field): string | null => {
  if (field.type !== "relation") return null;
  return (field.config as { targetTableId?: string }).targetTableId ?? null;
};

export const relationTargetIsReadable = (field: Field, readableTableIds?: readonly string[]): boolean => {
  const targetTableId = relationTargetTableId(field);
  if (!targetTableId || !readableTableIds) return true;
  return readableTableIds.includes(targetTableId);
};

const computedTargetIsReadable = (field: Field, fields: Field[], readableTableIds?: readonly string[]): boolean => {
  if (!readableTableIds || (field.type !== "lookup" && field.type !== "rollup")) return true;
  const relationFieldId = (field.config as { relationFieldId?: string }).relationFieldId;
  const relationField = relationFieldId ? fields.find((candidate) => candidate.id === relationFieldId && !candidate.deletedAt) : null;
  return Boolean(relationField && relationTargetIsReadable(relationField, readableTableIds));
};

export const computedFieldSqlForScope = (
  options: Pick<DslSqlCompileOptions, "computedFieldSql" | "computedFieldSqlByJoinAlias">,
  joinAlias?: string,
): Map<string, FormulaSqlExpression> | undefined =>
  joinAlias ? options.computedFieldSqlByJoinAlias?.get(joinAlias) : options.computedFieldSql;

export const fieldProjection = (
  field: Field,
  recordAlias: string,
  options?: {
    fields?: Field[];
    timeZone?: string;
    readableTableIds?: readonly string[];
    computedFieldSql?: Map<string, FormulaSqlExpression>;
    resolveField?: FormulaSqlFieldResolver;
  },
): { ok: true; projection: unknown; sqlType?: FormulaSqlType } | { ok: false; error: string } => {
  if (field.type === "object_list") {
    const compiled = compileObjectListProjection(field, recordAlias, {
      dateConfig: options?.timeZone ? { timeZone: options.timeZone } : undefined,
    });
    return compiled.ok ? { ok: true, projection: compiled.expression.sql } : compiled;
  }
  if (field.type === "formula") {
    return compileFormulaFieldProjection({
      field,
      fields: options?.fields ?? [field],
      recordAlias,
      timeZone: options?.timeZone,
      computedFieldSql: options?.computedFieldSql,
      resolveField: options?.resolveField,
    });
  }
  if (field.type === "lookup" || field.type === "rollup") {
    if (!computedTargetIsReadable(field, options?.fields ?? [field], options?.readableTableIds)) {
      return { ok: false, error: `${field.type} field "${field.name}" target table is not available` };
    }
    const computed = options?.computedFieldSql?.get(field.id);
    if (computed) return { ok: true, projection: computed.sql, sqlType: computed.type };
    return { ok: false, error: `field "${field.name}" (type "${field.type}") is not available in this query` };
  }
  if (!relationTargetIsReadable(field, options?.readableTableIds)) {
    return { ok: false, error: `relation field "${field.name}" target table is not available` };
  }
  const descriptor = storageOf(field);
  const projected = descriptor.project(field, recordAlias);
  if (projected) return { ok: true, projection: projected };
  if (descriptor.kind === "relationLink") {
    return {
      ok: true,
      projection: sql`(
        SELECT COALESCE(jsonb_agg(rl.to_record_id::text ORDER BY rl.position), '[]'::jsonb)
        FROM grids.record_links rl
        WHERE rl.from_record_id = ${sql.unsafe(recordAlias)}.id
          AND rl.from_field_id = ${field.id}::uuid
      )`,
    };
  }
  if (descriptor.kind === "json" || descriptor.kind === "jsonbArray") {
    return { ok: true, projection: sql`${sql.unsafe(recordAlias)}.data->${field.id}` };
  }
  return { ok: false, error: `field "${field.name}" (type "${field.type}") cannot be selected by GQL yet` };
};

const safeColumnAlias = (index: number): string => `q_col_${index}`;

export const compileBaseFieldColumn = (params: {
  field: Field;
  fields: Field[];
  label?: string;
  recordAlias: string;
  index: number;
  tableId: string;
  timeZone?: string;
  readableTableIds?: readonly string[];
  computedFieldSql?: Map<string, FormulaSqlExpression>;
  resolveField?: FormulaSqlFieldResolver;
}): { ok: true; fragment: unknown; column: DslSqlOutputColumn; projection: unknown } | { ok: false; error: string } => {
  if (params.field.type === "html_template") {
    const key = safeColumnAlias(params.index);
    const projection = sql`NULL::text`;
    return {
      ok: true,
      fragment: sql`${projection} AS ${sql.unsafe(key)}`,
      projection,
      column: {
        key,
        label: params.label ?? params.field.name,
        tableId: params.tableId,
        fieldId: params.field.id,
        type: params.field.type,
        sqlType: "text",
      },
    };
  }
  const projection = fieldProjection(params.field, params.recordAlias, {
    fields: params.fields,
    timeZone: params.timeZone,
    readableTableIds: params.readableTableIds,
    computedFieldSql: params.computedFieldSql,
    resolveField: params.resolveField,
  });
  if (!projection.ok) return projection;
  const key = safeColumnAlias(params.index);
  return {
    ok: true,
    fragment: sql`${projection.projection} AS ${sql.unsafe(key)}`,
    projection: projection.projection,
    column: {
      key,
      label: params.label ?? params.field.name,
      tableId: params.tableId,
      fieldId: params.field.id,
      type: params.field.type,
      sqlType: projection.sqlType ?? outputTypeFor(params.field),
    },
  };
};

export const compileFormulaColumn = (params: {
  expression: string;
  label: string;
  fields: Field[];
  recordAlias: string;
  index: number;
  timeZone?: string;
  computedFieldSql?: Map<string, FormulaSqlExpression>;
  resolveField?: FormulaSqlFieldResolver;
}): { ok: true; fragment: unknown; column: DslSqlOutputColumn; projection: unknown } | { ok: false; error: string } => {
  const compiled = compileFormulaSourceToSql(params.expression, {
    fields: params.fields,
    recordAlias: params.recordAlias,
    dateConfig: params.timeZone ? { timeZone: params.timeZone } : undefined,
    computedFieldSql: params.computedFieldSql,
    resolveField: params.resolveField,
    scopedRefs: Boolean(params.resolveField),
  });
  if (!compiled.ok) return { ok: false, error: compiled.error };
  const key = safeColumnAlias(params.index);
  return {
    ok: true,
    fragment: sql`${compiled.expression.sql} AS ${sql.unsafe(key)}`,
    projection: compiled.expression.sql,
    column: {
      key,
      label: params.label,
      tableId: "",
      type: "formula",
      sqlType: compiled.expression.type,
    },
  };
};

export const compileJoinedColumn = (params: {
  joinedColumn: DslJoinedColumn;
  fieldsByTableId: Record<string, Field[]>;
  recordAlias: string;
  index: number;
  timeZone?: string;
  readableTableIds?: readonly string[];
  computedFieldSql?: Map<string, FormulaSqlExpression>;
}): { ok: true; fragment: unknown; column: DslSqlOutputColumn; projection: unknown } | { ok: false; error: string } => {
  const fields = aliveFields(params.fieldsByTableId[params.joinedColumn.tableId] ?? []);
  const field = fieldById(fields, params.joinedColumn.fieldId);
  if (!field) return { ok: false, error: `joined field ${params.joinedColumn.fieldId} is not available` };
  const projection = fieldProjection(field, params.recordAlias, {
    fields,
    timeZone: params.timeZone,
    readableTableIds: params.readableTableIds,
    computedFieldSql: params.computedFieldSql,
  });
  if (!projection.ok) return projection;
  const key = safeColumnAlias(params.index);
  return {
    ok: true,
    fragment: sql`${projection.projection} AS ${sql.unsafe(key)}`,
    projection: projection.projection,
    column: {
      key,
      label: params.joinedColumn.label ?? `${params.joinedColumn.joinAlias}.${field.name}`,
      tableId: params.joinedColumn.tableId,
      fieldId: field.id,
      joinAlias: params.joinedColumn.joinAlias,
      type: field.type,
      sqlType: projection.sqlType ?? outputTypeFor(field),
    },
  };
};

export const sortProjectionForField = (
  field: Field,
  recordAlias = "r",
  options?: { fields?: Field[]; timeZone?: string; computedFieldSql?: Map<string, FormulaSqlExpression> },
): { ok: true; projection: unknown; sqlType: FormulaSqlType } | { ok: false; error: string } => {
  if (field.type === "formula") {
    const projection = compileFormulaFieldProjection({
      field,
      fields: options?.fields ?? [field],
      recordAlias,
      timeZone: options?.timeZone,
      computedFieldSql: options?.computedFieldSql,
    });
    if (!projection.ok) return projection;
    return { ok: true, projection: projection.projection, sqlType: projection.sqlType };
  }
  if (field.type === "lookup" || field.type === "rollup") {
    const computed = options?.computedFieldSql?.get(field.id);
    if (computed) return { ok: true, projection: computed.sql, sqlType: computed.type };
    return { ok: false, error: `field "${field.name}" (type "${field.type}") is not available for sorting` };
  }
  const descriptor = storageOf(field);
  if (!descriptor.sortable) return { ok: false, error: `field "${field.name}" (type "${field.type}") is not sortable` };
  const projection = descriptor.project(field, recordAlias);
  if (!projection) return { ok: false, error: `field "${field.name}" (type "${field.type}") is not sortable` };
  const sqlType = outputTypeFor(field);
  return { ok: true, projection, sqlType: sqlType === "json" ? "unknown" : sqlType };
};
