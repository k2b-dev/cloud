import { sql } from "bun";
import type { RecordMetaSortKey, SortSpec } from "../contracts";
import { type ProjectionKind, storageOf } from "./field-storage";
import { compileDslKeyset, type DslKeysetColumn, type DslKeysetType } from "./keyset-compiler";
import type { Field } from "./types";

type RecordSortSpec = {
  source: "record";
  key: RecordMetaSortKey;
  direction: "asc" | "desc";
  nullsFirst?: boolean;
};

type CompiledSort = {
  orderBy: unknown;
  cursorWhere: unknown | null;
  /** Stable sort identifiers, excluding the implicit record-id tiebreaker. */
  fieldIds: string[];
  /** SELECT-list extras, including the leading comma, owned by the keyset compiler. */
  cursorSelect: unknown;
  /** Reads the typed cursor projections and the record id from a SQL result row. */
  encodeCursorFromRow: (row: Record<string, unknown>) => string;
};

const cursorTypeFor = (kind: ProjectionKind): DslKeysetType | null => {
  switch (kind) {
    case "numeric":
    case "date":
    case "datetime":
    case "boolean":
    case "text":
      return kind;
    case "system":
      return "text";
    default:
      return null;
  }
};

const projectionForField = (field: Field): { expression: unknown; type: DslKeysetType } | null => {
  const desc = storageOf(field);
  if (!desc.sortable) return null;
  const expression = desc.project(field, "r");
  if (!expression) return null;
  const type = desc.kind === "system" && field.type.endsWith("_at") ? "datetime" : cursorTypeFor(desc.kind);
  return type ? { expression, type } : null;
};

const isRecordSort = (spec: SortSpec): spec is RecordSortSpec => spec.source === "record";

const recordProjectionFor = (key: RecordMetaSortKey): unknown | null => {
  switch (key) {
    case "createdAt":
      return sql`r.created_at`;
    case "updatedAt":
      return sql`r.updated_at`;
    case "deletedAt":
      return sql`r.deleted_at`;
    default:
      return null;
  }
};

/**
 * Resolves structured record sorts through field storage, then uses the same
 * typed, null-aware keyset ordering as GQL. The record-id tiebreaker follows
 * the first sort direction, or ascending order when no sort is configured.
 */
export const compileSort = (
  specs: SortSpec[],
  fields: Field[],
  cursor: { values: unknown[]; id: string } | null,
): { ok: true; result: CompiledSort } | { ok: false; error: string } => {
  const fieldsById = new Map(fields.map((field) => [field.id, field]));
  const columns: DslKeysetColumn[] = [];
  for (const spec of specs) {
    if (isRecordSort(spec)) {
      const expression = recordProjectionFor(spec.key);
      if (!expression) return { ok: false, error: "unknown record sort field" };
      columns.push({ expression, type: "datetime", direction: spec.direction, nullsFirst: spec.nullsFirst });
      continue;
    }
    const field = fieldsById.get(spec.fieldId);
    if (!field) return { ok: false, error: "unknown sort field" };
    if (field.deletedAt) return { ok: false, error: `sort field "${field.name}" is deleted` };
    const projection = projectionForField(field);
    if (!projection) return { ok: false, error: `field "${field.name}" (type "${field.type}") is not sortable` };
    columns.push({ ...projection, direction: spec.direction, nullsFirst: spec.nullsFirst });
  }
  columns.push({ expression: sql`r.id`, type: "uuid", direction: specs[0]?.direction ?? "asc" });
  const keyset = compileDslKeyset(columns, cursor ? [...cursor.values, cursor.id] : null);
  if (!keyset.ok) return keyset;

  return {
    ok: true,
    result: {
      orderBy: keyset.orderBy,
      cursorWhere: cursor ? keyset.where : null,
      fieldIds: specs.map((spec) => (isRecordSort(spec) ? `record:${spec.key}` : spec.fieldId)),
      cursorSelect: sql`, ${keyset.select}`,
      encodeCursorFromRow: (row) => JSON.stringify({ v: keyset.valuesFromRow(row).slice(0, specs.length), i: row.id }),
    },
  };
};

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const decodeCursor = (token: string, expectedLength?: number): { values: unknown[]; id: string } | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(token);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || !("i" in parsed) || !("v" in parsed)) return null;
  if (typeof parsed.i !== "string" || !UUID_REGEX.test(parsed.i)) return null;
  if (!Array.isArray(parsed.v)) return null;
  if (expectedLength !== undefined && parsed.v.length !== expectedLength) return null;
  return { values: parsed.v, id: parsed.i };
};
