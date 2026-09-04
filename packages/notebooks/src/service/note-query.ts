import { sql } from "bun";
import type { NamedDataProperties, NamedDataValue } from "../lib/named-blocks";
import {
  isQueryField,
  isQueryFilter,
  QUERY_MAX_COLUMNS,
  QUERY_MAX_FILTERS,
  QUERY_MAX_LIMIT,
  type QueryBlock,
  type QueryField,
  type QueryFilter,
  type QueryScalar,
} from "../lib/query-blocks";
import { buildNotebookVisibleAccessCondition } from "./access";
import * as notebooks from "./notebooks";

export type NoteQueryDiagnostic = {
  code: "invalid-query" | "unavailable";
  path?: string;
};

export type NoteQueryItem = {
  id: string;
  href: string;
  title: string;
  values: Record<string, NamedDataValue | null>;
};

export type NoteQueryResult = {
  columns: QueryField[];
  items: NoteQueryItem[];
  total: number;
  limit: number;
  truncated: boolean;
  diagnostics: NoteQueryDiagnostic[];
};

type DbQueryNote = {
  short_id: string;
  notebook_short_id: string;
  title: string;
  created_at: Date | string;
  updated_at: Date | string;
  tags: string[];
  data_properties: NamedDataProperties;
  total: number;
};

type UnknownRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is UnknownRecord => typeof value === "object" && value !== null && !Array.isArray(value);
const hasOnlyKeys = (value: UnknownRecord, keys: string[]): boolean => Object.keys(value).every((key) => keys.includes(key));

const invalid = (path: string): NoteQueryDiagnostic => ({ code: "invalid-query", path });

export const validateNoteQuery = (value: unknown): { query?: QueryBlock; diagnostics: NoteQueryDiagnostic[] } => {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["source", "scope", "match", "where", "sort", "columns", "limit", "line"]) ||
    value.source !== "notes" ||
    !["notebook", "children", "descendants"].includes(String(value.scope)) ||
    !["all", "any"].includes(String(value.match)) ||
    !Array.isArray(value.where) ||
    value.where.length > QUERY_MAX_FILTERS ||
    !Array.isArray(value.columns) ||
    value.columns.length > QUERY_MAX_COLUMNS ||
    !Number.isInteger(value.limit) ||
    Number(value.limit) < 1 ||
    Number(value.limit) > QUERY_MAX_LIMIT ||
    !Number.isInteger(value.line) ||
    Number(value.line) < 1 ||
    !isRecord(value.sort) ||
    !hasOnlyKeys(value.sort, ["field", "direction"]) ||
    !["$title", "$created", "$updated"].includes(String(value.sort.field)) ||
    !["asc", "desc"].includes(String(value.sort.direction))
  ) {
    return { diagnostics: [invalid("query")] };
  }
  if (!value.columns.every(isQueryField) || new Set(value.columns).size !== value.columns.length) {
    return { diagnostics: [invalid("query.columns")] };
  }
  for (const [index, filter] of value.where.entries()) {
    if (!isQueryFilter(filter)) return { diagnostics: [invalid(`query.where.${index}`)] };
  }
  return { query: value as QueryBlock, diagnostics: [] };
};

const emptyResult = (query: QueryBlock, diagnostic: NoteQueryDiagnostic): NoteQueryResult => ({
  columns: query.columns.length > 0 ? query.columns : ["$title"],
  items: [],
  total: 0,
  limit: query.limit,
  truncated: false,
  diagnostics: [diagnostic],
});

const invalidResult = (diagnostics: NoteQueryDiagnostic[]): NoteQueryResult => ({
  columns: ["$title"],
  items: [],
  total: 0,
  limit: 25,
  truncated: false,
  diagnostics,
});

const propertyField = (field: QueryField) => {
  const [block, key] = field.split(".") as [string, string];
  return sql`jsonb_extract_path(n.data_properties, ${block}, ${key})`;
};

const normalizeFilterValue = (filter: QueryFilter): QueryScalar | QueryScalar[] | undefined => {
  if (filter.value === undefined || filter.field !== "$tags") return filter.value;
  const normalizeTag = (value: QueryScalar): QueryScalar => (typeof value === "string" ? value.replace(/^#/, "").toLowerCase() : value);
  return Array.isArray(filter.value) ? filter.value.map(normalizeTag) : normalizeTag(filter.value);
};

const boundJson = (value: QueryScalar | QueryScalar[]) => sql`((${JSON.stringify(value)}::text)::jsonb)`;

const filterCondition = (filter: QueryFilter) => {
  const value = normalizeFilterValue(filter);
  if (filter.field === "$title") {
    switch (filter.op) {
      case "eq":
        return sql`n.title = ${value}`;
      case "ne":
        return sql`n.title <> ${value}`;
      case "in":
        return sql`to_jsonb(n.title) IN (SELECT item FROM jsonb_array_elements(${boundJson(value as QueryScalar[])}) item)`;
      case "not-in":
        return sql`to_jsonb(n.title) NOT IN (SELECT item FROM jsonb_array_elements(${boundJson(value as QueryScalar[])}) item)`;
      case "contains":
        return sql`STRPOS(LOWER(n.title), LOWER(${value}::text)) > 0`;
      case "starts-with":
        return sql`STARTS_WITH(LOWER(n.title), LOWER(${value}::text))`;
      default:
        return sql`false`;
    }
  }
  if (filter.field === "$created" || filter.field === "$updated") {
    const field = filter.field === "$created" ? sql`n.created_at` : sql`n.updated_at`;
    switch (filter.op) {
      case "eq":
        return sql`${field} = ${value}::timestamptz`;
      case "ne":
        return sql`${field} <> ${value}::timestamptz`;
      case "in":
        return sql`
          to_jsonb(${field}) IN (
            SELECT to_jsonb(wanted.value::timestamptz)
            FROM jsonb_array_elements_text(${boundJson(value as QueryScalar[])}) wanted(value)
          )
        `;
      case "not-in":
        return sql`
          to_jsonb(${field}) NOT IN (
            SELECT to_jsonb(wanted.value::timestamptz)
            FROM jsonb_array_elements_text(${boundJson(value as QueryScalar[])}) wanted(value)
          )
        `;
      default:
        return sql`false`;
    }
  }
  if (filter.field === "$tags") {
    const normalized = value as string | string[];
    switch (filter.op) {
      case "exists":
        return sql`EXISTS (SELECT 1 FROM notebooks.note_tags tag WHERE tag.note_id = n.id)`;
      case "missing":
        return sql`NOT EXISTS (SELECT 1 FROM notebooks.note_tags tag WHERE tag.note_id = n.id)`;
      case "contains":
        return sql`EXISTS (SELECT 1 FROM notebooks.note_tags tag WHERE tag.note_id = n.id AND tag.tag = ${normalized})`;
      case "contains-any":
        return sql`
          EXISTS (
            SELECT 1 FROM notebooks.note_tags tag
            WHERE tag.note_id = n.id
              AND tag.tag IN (SELECT jsonb_array_elements_text(${boundJson(normalized as QueryScalar[])}))
          )
        `;
      case "contains-all":
        return sql`
          NOT EXISTS (
            SELECT wanted.tag
            FROM jsonb_array_elements_text(${boundJson(normalized as QueryScalar[])}) wanted(tag)
            WHERE NOT EXISTS (
              SELECT 1 FROM notebooks.note_tags tag
              WHERE tag.note_id = n.id AND tag.tag = wanted.tag
            )
          )
        `;
      default:
        return sql`false`;
    }
  }
  const field = propertyField(filter.field);
  const jsonValue = boundJson(value as QueryScalar | QueryScalar[]);
  switch (filter.op) {
    case "eq":
      return sql`${field} = ${jsonValue}`;
    case "ne":
      return sql`${field} IS NOT NULL AND ${field} <> ${jsonValue}`;
    case "in":
      return sql`
        ${field} IS NOT NULL
        AND jsonb_typeof(${field}) <> 'array'
        AND EXISTS (
          SELECT 1 FROM jsonb_array_elements(${jsonValue}) wanted(value)
          WHERE wanted.value = ${field}
        )
      `;
    case "not-in":
      return sql`
        ${field} IS NOT NULL
        AND jsonb_typeof(${field}) <> 'array'
        AND NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(${jsonValue}) wanted(value)
          WHERE wanted.value = ${field}
        )
      `;
    case "exists":
      return sql`${field} IS NOT NULL`;
    case "missing":
      return sql`${field} IS NULL`;
    case "contains":
      return sql`
        CASE WHEN jsonb_typeof(${field}) = 'string'
          THEN STRPOS(LOWER(${field} #>> '{}'), LOWER(${value}::text)) > 0
          ELSE false
        END
      `;
    case "starts-with":
      return sql`
        CASE WHEN jsonb_typeof(${field}) = 'string'
          THEN STARTS_WITH(LOWER(${field} #>> '{}'), LOWER(${value}::text))
          ELSE false
        END
      `;
    case "gt":
      return sql`
        CASE WHEN jsonb_typeof(${field}) = 'number'
          THEN (${field} #>> '{}')::numeric > ${value}::numeric
          ELSE false
        END
      `;
    case "gte":
      return sql`
        CASE WHEN jsonb_typeof(${field}) = 'number'
          THEN (${field} #>> '{}')::numeric >= ${value}::numeric
          ELSE false
        END
      `;
    case "lt":
      return sql`
        CASE WHEN jsonb_typeof(${field}) = 'number'
          THEN (${field} #>> '{}')::numeric < ${value}::numeric
          ELSE false
        END
      `;
    case "lte":
      return sql`
        CASE WHEN jsonb_typeof(${field}) = 'number'
          THEN (${field} #>> '{}')::numeric <= ${value}::numeric
          ELSE false
        END
      `;
    case "contains-any":
      return sql`
        CASE WHEN jsonb_typeof(${field}) = 'array'
          THEN EXISTS (
            SELECT 1
            FROM jsonb_array_elements(${field}) actual(value)
            JOIN jsonb_array_elements(${jsonValue}) wanted(value) USING (value)
          )
          ELSE false
        END
      `;
    case "contains-all":
      return sql`
        CASE WHEN jsonb_typeof(${field}) = 'array'
          THEN NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(${jsonValue}) wanted(value)
            WHERE NOT EXISTS (
              SELECT 1 FROM jsonb_array_elements(${field}) actual(value)
              WHERE actual.value = wanted.value
            )
          )
          ELSE false
        END
      `;
  }
};

const combineConditions = (filters: QueryFilter[], match: "all" | "any") => {
  if (filters.length === 0) return sql`true`;
  const conditions = filters.map(filterCondition);
  return conditions
    .slice(1)
    .reduce((combined, condition) => sql`${combined} ${match === "all" ? sql`AND` : sql`OR`} ${condition}`, conditions[0]!);
};

const scopeCondition = (params: { notebookId: string; noteId: string; scope: QueryBlock["scope"] }) => {
  switch (params.scope) {
    case "notebook":
      return sql`true`;
    case "children":
      return sql`n.parent_id = ${params.noteId}::uuid`;
    case "descendants":
      return sql`
        n.id IN (
          WITH RECURSIVE descendants AS (
            SELECT child.id
            FROM notebooks.notes child
            WHERE child.notebook_id = ${params.notebookId}::uuid
              AND child.parent_id = ${params.noteId}::uuid
              AND child.id <> ${params.noteId}::uuid
            UNION
            SELECT child.id
            FROM notebooks.notes child
            JOIN descendants parent ON child.parent_id = parent.id
            WHERE child.notebook_id = ${params.notebookId}::uuid
              AND child.id <> ${params.noteId}::uuid
          )
          SELECT id FROM descendants
        )
      `;
  }
};

const sortRows = (field: QueryBlock["sort"]["field"], direction: QueryBlock["sort"]["direction"]) => {
  if (field === "$title") {
    return direction === "asc"
      ? sql`LOWER(n.title) COLLATE "C" ASC, n.title COLLATE "C" ASC, n.id ASC`
      : sql`LOWER(n.title) COLLATE "C" DESC, n.title COLLATE "C" DESC, n.id ASC`;
  }
  const column = field === "$created" ? sql`n.created_at` : sql`n.updated_at`;
  return direction === "asc" ? sql`${column} ASC, n.id ASC` : sql`${column} DESC, n.id ASC`;
};

const iso = (value: Date | string): string => (value instanceof Date ? value.toISOString() : new Date(value).toISOString());

const selectedValue = (row: DbQueryNote, field: QueryField): NamedDataValue | null => {
  switch (field) {
    case "$title":
      return row.title;
    case "$created":
      return iso(row.created_at);
    case "$updated":
      return iso(row.updated_at);
    case "$tags":
      return row.tags;
    default: {
      const [block, key] = field.split(".") as [string, string];
      if (!Object.hasOwn(row.data_properties, block)) return null;
      const properties = row.data_properties[block]!;
      return Object.hasOwn(properties, key) ? properties[key]! : null;
    }
  }
};

/**
 * Resolve one normalized query inside a notebook. API and capability callers
 * remain responsible for deriving service-account binding from the credential;
 * the resolver independently rechecks the resulting notebook ACL in SQL.
 */
export const resolveNoteQuery = async (params: {
  notebookId: string;
  noteId: string;
  query: unknown;
  userId: string | null;
  serviceAccountId?: string | null;
  boundNotebookId?: string | null;
  /** Only trusted server callers may supply the platform-admin override. */
  bypassAccess?: boolean;
}): Promise<NoteQueryResult> => {
  const validation = validateNoteQuery(params.query);
  if (!validation.query) return invalidResult(validation.diagnostics);
  const query = validation.query;
  if (params.serviceAccountId && !params.boundNotebookId) return emptyResult(query, { code: "unavailable" });
  if (params.boundNotebookId && params.boundNotebookId !== params.notebookId) return emptyResult(query, { code: "unavailable" });
  const canRead =
    params.bypassAccess ||
    (await notebooks.canAccess({
      notebookId: params.notebookId,
      userId: params.userId,
      serviceAccountId: params.serviceAccountId,
      requiredLevel: "read",
    }));
  if (!canRead) return emptyResult(query, { code: "unavailable" });

  const [context] = await sql<{ exists: boolean }[]>`
    SELECT EXISTS(
      SELECT 1 FROM notebooks.notes
      WHERE id = ${params.noteId}::uuid
        AND notebook_id = ${params.notebookId}::uuid
    ) AS exists
  `;
  if (!context?.exists) return emptyResult(query, { code: "unavailable" });

  const principalMatch = buildNotebookVisibleAccessCondition({
    userId: params.userId,
    serviceAccountId: params.serviceAccountId,
  });
  const boundNotebookId = params.boundNotebookId ?? null;
  const scope = scopeCondition({ notebookId: params.notebookId, noteId: params.noteId, scope: query.scope });
  const predicates = combineConditions(query.where, query.match);
  const visibleMatches = sql`
    FROM notebooks.notes n
    JOIN notebooks.notebooks nb ON nb.id = n.notebook_id
    WHERE n.notebook_id = ${params.notebookId}::uuid
      AND (${boundNotebookId}::uuid IS NULL OR n.notebook_id = ${boundNotebookId}::uuid)
      AND (${params.bypassAccess === true} OR EXISTS (
        SELECT 1
        FROM notebooks.notebook_access na
        JOIN auth.access a ON a.id = na.access_id
        WHERE na.notebook_id = n.notebook_id
          AND ${principalMatch}
      ))
      AND ${scope}
      AND (${predicates})
  `;

  const rows = await sql<DbQueryNote[]>`
    SELECT
      n.short_id,
      nb.short_id AS notebook_short_id,
      n.title,
      n.created_at,
      n.updated_at,
      COALESCE(
        ARRAY(SELECT nt.tag FROM notebooks.note_tags nt WHERE nt.note_id = n.id ORDER BY nt.tag),
        ARRAY[]::text[]
      ) AS tags,
      n.data_properties,
      COUNT(*) OVER()::int AS total
    ${visibleMatches}
    ORDER BY ${sortRows(query.sort.field, query.sort.direction)}
    LIMIT ${query.limit}
  `;

  const columns = query.columns.length > 0 ? query.columns : (["$title"] as QueryField[]);
  const total = rows[0]?.total ?? 0;
  return {
    columns,
    items: rows.map((row) => ({
      id: row.short_id,
      href: `/app/notebooks/${row.notebook_short_id}/notes/${row.short_id}`,
      title: row.title,
      values: Object.fromEntries(columns.map((column) => [column, selectedValue(row, column)])),
    })),
    total,
    limit: query.limit,
    truncated: total > rows.length,
    diagnostics: [],
  };
};
