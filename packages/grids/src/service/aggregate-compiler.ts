import { sql } from "bun";
import { type AggregateKind, aggregateOutputKey, isFieldAggregatable } from "./aggregate-capabilities";
import { storageOf } from "./field-storage";
import type { Field } from "./types";

type AggKind = AggregateKind;

/** "*" is a virtual field id meaning "the row itself". Only `count` is
 *  defined for it (`COUNT(*)`); any other agg returns a compile error. */
export type AggregateRequest = { fieldId: string | "*"; agg: AggKind };
type AggregateColumn = {
  /** Result key: `${fieldId}__${agg}` — stable for the renderer to extract. */
  key: string;
  /** SELECT-list fragment, ready to be embedded in the SELECT clause. */
  expr: any;
};

/** SQL fragment that extracts a numeric value for the given field.
 *  Delegates to the shared storage descriptor; corrupt JSONB
 *  is rejected by the canonical storage migration before direct casts activate. */
const numericProjection = (field: Field): any => {
  const expr = storageOf(field).project(field, "r");
  return expr ?? sql`NULL::numeric`;
};

const dateProjection = (field: Field): any => storageOf(field).project(field, "r") ?? sql`NULL::date`;

const existsProjection = (field: Field): { ref: any; system: boolean } => {
  const storage = storageOf(field);
  if (storage.kind === "system") return { ref: storage.project(field, "r"), system: true };
  return { ref: sql`r.data->>${field.id}`, system: false };
};

type CompileAggResult = { ok: true; columns: AggregateColumn[] } | { ok: false; error: string };
type CompileAggregateResult = { ok: true; column: AggregateColumn } | { ok: false; error: string };

const aggregateExpression = (field: Field, agg: AggKind): any => {
  const storage = storageOf(field);
  const exists = existsProjection(field);

  switch (agg) {
    case "count":
      return exists.system
        ? sql`COUNT(${exists.ref}) FILTER (WHERE ${exists.ref} IS NOT NULL)`
        : sql`COUNT(${exists.ref}) FILTER (WHERE ${exists.ref} IS NOT NULL AND ${exists.ref} <> '')`;
    case "countEmpty":
      return exists.system
        ? sql`COUNT(*) FILTER (WHERE ${exists.ref} IS NULL)`
        : sql`COUNT(*) FILTER (WHERE ${exists.ref} IS NULL OR ${exists.ref} = '')`;
    case "countUnique":
      return exists.system
        ? sql`COUNT(DISTINCT ${exists.ref}) FILTER (WHERE ${exists.ref} IS NOT NULL)`
        : sql`COUNT(DISTINCT ${exists.ref}) FILTER (WHERE ${exists.ref} IS NOT NULL AND ${exists.ref} <> '')`;
    case "sum":
      return sql`SUM(${numericProjection(field)})`;
    case "avg":
      return sql`AVG(${numericProjection(field)})`;
    case "median":
      return sql`PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ${numericProjection(field)})`;
    case "min":
    case "max": {
      const fn = agg === "min" ? sql`MIN` : sql`MAX`;
      if (storage.kind === "numeric") return sql`${fn}(${numericProjection(field)})`;
      if (storage.kind === "date" || storage.kind === "datetime") return sql`${fn}(${dateProjection(field)})`;
      return sql`${fn}(${exists.ref})`;
    }
    case "earliest":
    case "latest": {
      const fn = agg === "earliest" ? sql`MIN` : sql`MAX`;
      return sql`${fn}(${dateProjection(field)})`;
    }
  }
};

const compileAggregate = (request: AggregateRequest, fieldsById: Map<string, Field>): CompileAggregateResult => {
  if (request.fieldId === "*") {
    if (request.agg !== "count") {
      return { ok: false, error: `agg "${request.agg}" requires a field; only count works on "*"` };
    }
    return { ok: true, column: { key: aggregateOutputKey("*", "count"), expr: sql`COUNT(*)` } };
  }

  const field = fieldsById.get(request.fieldId);
  if (!field) return { ok: false, error: "unknown field" };
  if (field.deletedAt) return { ok: false, error: `field "${field.name}" is deleted` };
  if (!isFieldAggregatable(field, request.agg)) {
    return { ok: false, error: `agg "${request.agg}" not compatible with field type "${field.type}"` };
  }

  return {
    ok: true,
    column: { key: aggregateOutputKey(field.id, request.agg), expr: aggregateExpression(field, request.agg) },
  };
};

/**
 * Builds a SELECT-list of aggregate expressions over the records table's
 * JSONB column. Caller composes them with the same WHERE clause used for
 * the records list, so footer aggregates respect filter/permission scope.
 *
 * Storage notes: we cast text→numeric/date once per row at aggregate time.
 * For hot footer aggregates the field can be opt-in indexed (`indexed=true`)
 * so Postgres uses the expression index for these casts.
 */
export const compileAggregates = (requests: AggregateRequest[], fields: Field[]): CompileAggResult => {
  const fieldsById = new Map(fields.map((f) => [f.id, f]));
  const columns: AggregateColumn[] = [];
  // Reject duplicate (fieldId, agg) requests instead of silently
  // emitting two SELECT columns with the same JSONB key (the second
  // wins in jsonb_build_object). Group-compiler already dedupes by
  // alias; aggregate-compiler now matches that behaviour.
  const seen = new Set<string>();

  for (const req of requests) {
    const dupKey = aggregateOutputKey(req.fieldId, req.agg);
    if (seen.has(dupKey)) {
      return { ok: false, error: `duplicate aggregate "${req.agg}" on the same field` };
    }
    seen.add(dupKey);
    const compiled = compileAggregate(req, fieldsById);
    if (!compiled.ok) return compiled;
    columns.push(compiled.column);
  }

  return { ok: true, columns };
};
