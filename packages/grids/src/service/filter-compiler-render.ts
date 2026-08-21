import { sql } from "bun";
import type { CompiledClause } from "./filter-compiler";

type PredicateClause = Extract<CompiledClause, { kind: "predicate" }>;
type PredicateProjection = {
  rawJson: any;
  rawText: any;
  text: any;
  numeric: any;
  date: any;
  dateOnly: any;
  bool: any;
};
type RenderOptions = { recordAlias?: string; relationSource?: "links" | "recordData" };

const escapeLikePattern = (value: string): string => value.replace(/([\\%_])/g, "\\$1");
const recordData = (recordAlias: string): any => sql`${sql.unsafe(recordAlias)}.data`;
const recordId = (recordAlias: string): any => sql`${sql.unsafe(recordAlias)}.id`;

const predicateProjection = (predicate: PredicateClause, options: RenderOptions = {}): PredicateProjection => {
  const timeZone = predicate.timeZone ?? "UTC";
  const data = recordData(options.recordAlias ?? "r");
  const rawJson = sql`${data}->${predicate.fieldId}`;
  const rawText = sql`${data}->>${predicate.fieldId}`;
  return {
    rawJson,
    rawText,
    text: predicate.caseInsensitive ? sql`LOWER(${rawText})` : rawText,
    numeric: sql`grids.canonical_numeric(${rawText})`,
    date: predicate.dateIncludeTime ? sql`grids.canonical_timestamptz(${rawText})` : sql`grids.canonical_date(${rawText})`,
    dateOnly: predicate.dateIncludeTime
      ? sql`(grids.canonical_timestamptz(${rawText}) AT TIME ZONE ${timeZone})::date`
      : sql`grids.canonical_date(${rawText})`,
    bool: sql`grids.canonical_boolean(${rawText})`,
  };
};

const predicateValue = (predicate: PredicateClause): unknown =>
  typeof predicate.value === "string" && predicate.caseInsensitive ? predicate.value.toLowerCase() : predicate.value;

const renderTextPredicate = (predicate: PredicateClause, projection: PredicateProjection): any => {
  const value = predicateValue(predicate);
  switch (predicate.op) {
    case "equals":
      return sql`${projection.text} = ${value}`;
    case "notEquals":
      return sql`${projection.text} <> ${value}`;
    case "contains":
      return sql`${projection.text} LIKE ${`%${escapeLikePattern(String(value ?? ""))}%`} ESCAPE '\\'`;
    case "notContains":
      return sql`${projection.text} NOT LIKE ${`%${escapeLikePattern(String(value ?? ""))}%`} ESCAPE '\\'`;
    case "startsWith":
      return sql`${projection.text} LIKE ${`${escapeLikePattern(String(value ?? ""))}%`} ESCAPE '\\'`;
    case "endsWith":
      return sql`${projection.text} LIKE ${`%${escapeLikePattern(String(value ?? ""))}`} ESCAPE '\\'`;
    case "regex":
      return sql`${projection.text} ~ ${String(value ?? "")}`;
    case "isEmpty":
      return sql`(${projection.rawText} IS NULL OR ${projection.rawText} = '')`;
    case "isNotEmpty":
      return sql`(${projection.rawText} IS NOT NULL AND ${projection.rawText} <> '')`;
    default:
      return sql`FALSE`;
  }
};

const renderNumberPredicate = (predicate: PredicateClause, projection: PredicateProjection): any => {
  switch (predicate.op) {
    case "=":
      return sql`${projection.numeric} = ${predicate.value}`;
    case "!=":
      return sql`${projection.numeric} <> ${predicate.value}`;
    case "<":
      return sql`${projection.numeric} < ${predicate.value}`;
    case "<=":
      return sql`${projection.numeric} <= ${predicate.value}`;
    case ">":
      return sql`${projection.numeric} > ${predicate.value}`;
    case ">=":
      return sql`${projection.numeric} >= ${predicate.value}`;
    case "between": {
      const value = predicate.value as [unknown, unknown] | undefined;
      return sql`${projection.numeric} BETWEEN ${value?.[0]} AND ${value?.[1]}`;
    }
    case "isEmpty":
      return sql`${projection.rawText} IS NULL`;
    case "isNotEmpty":
      return sql`${projection.rawText} IS NOT NULL`;
    default:
      return sql`FALSE`;
  }
};

type DateComparison = "=" | "<>" | "<" | "<=" | ">" | ">=";

const renderDateComparison = (predicate: PredicateClause, projection: PredicateProjection, op: DateComparison): any => {
  const value = predicate.dateIncludeTime ? sql`${predicate.value}::timestamptz` : sql`${predicate.value}::date`;
  switch (op) {
    case "=":
      return sql`${projection.date} = ${value}`;
    case "<>":
      return sql`${projection.date} <> ${value}`;
    case "<":
      return sql`${projection.date} < ${value}`;
    case "<=":
      return sql`${projection.date} <= ${value}`;
    case ">":
      return sql`${projection.date} > ${value}`;
    case ">=":
      return sql`${projection.date} >= ${value}`;
  }
};

const renderDatePredicate = (predicate: PredicateClause, projection: PredicateProjection): any => {
  const timeZone = predicate.timeZone ?? "UTC";
  const localToday = sql`(CURRENT_TIMESTAMP AT TIME ZONE ${timeZone})::date`;
  const localNow = sql`CURRENT_TIMESTAMP AT TIME ZONE ${timeZone}`;
  const localDate = predicate.dateIncludeTime ? sql`${projection.date} AT TIME ZONE ${timeZone}` : sql`${projection.date}::timestamp`;
  switch (predicate.op) {
    case "=":
      return renderDateComparison(predicate, projection, "=");
    case "notEquals":
      return renderDateComparison(predicate, projection, "<>");
    case "before":
      return renderDateComparison(predicate, projection, "<");
    case "onOrBefore":
      return renderDateComparison(predicate, projection, "<=");
    case "after":
      return renderDateComparison(predicate, projection, ">");
    case "onOrAfter":
      return renderDateComparison(predicate, projection, ">=");
    case "between": {
      const value = predicate.value as [unknown, unknown] | undefined;
      return predicate.dateIncludeTime
        ? sql`${projection.date} BETWEEN ${value?.[0]}::timestamptz AND ${value?.[1]}::timestamptz`
        : sql`${projection.date} BETWEEN ${value?.[0]}::date AND ${value?.[1]}::date`;
    }
    case "today":
      return sql`${projection.dateOnly} = ${localToday}`;
    case "thisWeek":
      return sql`date_trunc('week', ${localDate}) = date_trunc('week', ${localNow})`;
    case "thisMonth":
      return sql`date_trunc('month', ${localDate}) = date_trunc('month', ${localNow})`;
    case "lastNDays": {
      const days = Number(predicate.value ?? 0);
      return sql`(${projection.dateOnly} >= ${localToday} - ${days}::int * INTERVAL '1 day' AND ${projection.dateOnly} <= ${localToday})`;
    }
    case "isEmpty":
      return sql`${projection.rawText} IS NULL`;
    case "isNotEmpty":
      return sql`${projection.rawText} IS NOT NULL`;
    default:
      return sql`FALSE`;
  }
};

const renderBooleanPredicate = (predicate: PredicateClause, projection: PredicateProjection): any => {
  switch (predicate.op) {
    case "=":
      return sql`${projection.bool} = ${Boolean(predicate.value)}`;
    case "isEmpty":
      return sql`${projection.rawText} IS NULL`;
    case "isNotEmpty":
      return sql`${projection.rawText} IS NOT NULL`;
    default:
      return sql`FALSE`;
  }
};

const selectContains = (projection: PredicateProjection, value: unknown): any => sql`(${projection.rawJson})::jsonb @> ${[value]}::jsonb`;

const renderSingleSelectPredicate = (predicate: PredicateClause, projection: PredicateProjection): any => {
  const selected = sql`${projection.rawJson}->>0`;
  switch (predicate.op) {
    case "is":
      return sql`${selected} = ${predicate.value}`;
    case "isNot":
      return sql`${selected} IS DISTINCT FROM ${predicate.value}`;
    case "isAnyOf": {
      const items = (predicate.value as string[]) ?? [];
      if (items.length === 0) return sql`FALSE`;
      return sql`(${items.map((item) => sql`${selected} = ${item}`).reduce((acc, part) => sql`${acc} OR ${part}`)})`;
    }
    case "isNoneOf": {
      const items = (predicate.value as string[]) ?? [];
      if (items.length === 0) return sql`TRUE`;
      return sql`(${items.map((item) => sql`${selected} IS DISTINCT FROM ${item}`).reduce((acc, part) => sql`${acc} AND ${part}`)})`;
    }
    case "isEmpty":
      return sql`${selected} IS NULL`;
    case "isNotEmpty":
      return sql`${selected} IS NOT NULL`;
    default:
      return sql`FALSE`;
  }
};

const renderMultiSelectPredicate = (predicate: PredicateClause, projection: PredicateProjection): any => {
  switch (predicate.op) {
    case "is":
      return selectContains(projection, predicate.value);
    case "isNot":
      return sql`(
        ${projection.rawText} IS NULL
        OR jsonb_typeof(${projection.rawJson}) <> 'array'
        OR NOT (${selectContains(projection, predicate.value)})
      )`;
    case "isAnyOf": {
      const items = (predicate.value as string[]) ?? [];
      if (items.length === 0) return sql`FALSE`;
      return sql`(${items.map((item) => selectContains(projection, item)).reduce((acc, part) => sql`${acc} OR ${part}`)})`;
    }
    case "isNoneOf": {
      const items = (predicate.value as string[]) ?? [];
      if (items.length === 0) return sql`TRUE`;
      const none = items.map((item) => sql`NOT (${selectContains(projection, item)})`).reduce((acc, part) => sql`${acc} AND ${part}`);
      return sql`(
        ${projection.rawText} IS NULL
        OR jsonb_typeof(${projection.rawJson}) <> 'array'
        OR (${none})
      )`;
    }
    case "isEmpty":
      return sql`(
        ${projection.rawText} IS NULL
        OR jsonb_typeof(${projection.rawJson}) <> 'array'
        OR jsonb_array_length(${projection.rawJson}) = 0
      )`;
    case "isNotEmpty":
      return sql`(
        ${projection.rawText} IS NOT NULL
        AND jsonb_typeof(${projection.rawJson}) = 'array'
        AND jsonb_array_length(${projection.rawJson}) > 0
      )`;
    default:
      return sql`FALSE`;
  }
};

const renderSelectPredicate = (predicate: PredicateClause, projection: PredicateProjection): any =>
  predicate.selectMultiple ? renderMultiSelectPredicate(predicate, projection) : renderSingleSelectPredicate(predicate, projection);

const principalContains = (values: any, id: string): any =>
  sql`(
    ${values} @> ${[{ type: "user", id }]}::jsonb
    OR ${values} @> ${[{ type: "group", id }]}::jsonb
  )`;

const renderPrincipalPredicate = (predicate: PredicateClause, projection: PredicateProjection): any => {
  const values = sql`CASE WHEN jsonb_typeof(${projection.rawJson}) = 'array' THEN ${projection.rawJson} ELSE '[]'::jsonb END`;
  const items = (predicate.value as string[]) ?? [];
  const containsAny =
    items.length === 0 ? sql`FALSE` : items.map((item) => principalContains(values, item)).reduce((acc, part) => sql`${acc} OR ${part}`);
  switch (predicate.op) {
    case "containsAny":
      return sql`(${containsAny})`;
    case "notContainsAny":
      return sql`NOT (${containsAny})`;
    case "isEmpty":
      return sql`jsonb_array_length(${values}) = 0`;
    case "isNotEmpty":
      return sql`jsonb_array_length(${values}) > 0`;
    default:
      return sql`FALSE`;
  }
};

const renderRelationPredicate = (predicate: PredicateClause, options: RenderOptions = {}): any => {
  const recordAlias = options.recordAlias ?? "r";
  if (options.relationSource === "recordData") {
    const rawJson = sql`${recordData(recordAlias)}->${predicate.fieldId}`;
    const values = sql`CASE WHEN jsonb_typeof(${rawJson}) = 'array' THEN ${rawJson} ELSE '[]'::jsonb END`;
    const items = (predicate.value as string[]) ?? [];
    const containsAny =
      items.length === 0
        ? sql`FALSE`
        : items.map((item) => sql`${values} @> ${[item]}::jsonb`).reduce((acc, part) => sql`${acc} OR ${part}`);
    switch (predicate.op) {
      case "containsAny":
        return sql`(${containsAny})`;
      case "notContainsAny":
        return sql`NOT (${containsAny})`;
      case "isEmpty":
        return sql`jsonb_array_length(${values}) = 0`;
      case "isNotEmpty":
        return sql`jsonb_array_length(${values}) > 0`;
      default:
        return sql`FALSE`;
    }
  }

  const sourceRecordId = recordId(recordAlias);
  switch (predicate.op) {
    case "containsAny":
      return sql`EXISTS (
        SELECT 1 FROM grids.record_links rl
        WHERE rl.from_record_id = ${sourceRecordId}
          AND rl.from_field_id = ${predicate.fieldId}::uuid
          AND rl.to_record_id = ANY(${sql.array((predicate.value as string[]) ?? [], "UUID")})
      )`;
    case "notContainsAny":
      return sql`NOT EXISTS (
        SELECT 1 FROM grids.record_links rl
        WHERE rl.from_record_id = ${sourceRecordId}
          AND rl.from_field_id = ${predicate.fieldId}::uuid
          AND rl.to_record_id = ANY(${sql.array((predicate.value as string[]) ?? [], "UUID")})
      )`;
    case "isEmpty":
      return sql`NOT EXISTS (
        SELECT 1 FROM grids.record_links rl
        WHERE rl.from_record_id = ${sourceRecordId}
          AND rl.from_field_id = ${predicate.fieldId}::uuid
      )`;
    case "isNotEmpty":
      return sql`EXISTS (
        SELECT 1 FROM grids.record_links rl
        WHERE rl.from_record_id = ${sourceRecordId}
          AND rl.from_field_id = ${predicate.fieldId}::uuid
      )`;
    default:
      return sql`FALSE`;
  }
};

const renderPredicate = (predicate: PredicateClause, options: RenderOptions = {}): any => {
  const projection = predicateProjection(predicate, options);
  switch (predicate.fieldType) {
    case "text":
    case "id":
    case "longtext":
      return renderTextPredicate(predicate, projection);
    case "number":
    case "percent":
    case "duration":
      return renderNumberPredicate(predicate, projection);
    case "date":
      return renderDatePredicate(predicate, projection);
    case "boolean":
      return renderBooleanPredicate(predicate, projection);
    case "select":
      return renderSelectPredicate(predicate, projection);
    case "relation":
      return renderRelationPredicate(predicate, options);
    case "principal":
      return renderPrincipalPredicate(predicate, projection);
    default:
      return sql`FALSE`;
  }
};

export const renderClause = (clause: CompiledClause, options: RenderOptions = {}): any => {
  switch (clause.kind) {
    case "true":
      return sql`TRUE`;
    case "false":
      return sql`FALSE`;
    case "not":
      return sql`NOT (${renderClause(clause.inner, options)})`;
    case "and":
    case "or": {
      if (clause.parts.length === 0) return clause.kind === "and" ? sql`TRUE` : sql`FALSE`;
      const separator = clause.kind === "and" ? sql` AND ` : sql` OR `;
      const joined = clause.parts
        .map((part) => sql`(${renderClause(part, options)})`)
        .reduce((acc, part) => sql`${acc}${separator}${part}`);
      return sql`(${joined})`;
    }
    case "predicate":
      return renderPredicate(clause, options);
  }
};
