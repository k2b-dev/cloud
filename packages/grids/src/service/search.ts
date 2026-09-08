import { sql } from "bun";
import type { SearchSpec } from "../contracts";
import type { SqlClient } from "./audit";
import { listByTable as listFields } from "./fields";
import { resolveReadableTableIds } from "./relation-access";
import { type ExpansionViewer, relationLabelFields } from "./relations";
import type { Field } from "./types";

type SearchClause = { clause: any };
type RecordSource = { relation: unknown };

const SCALAR_SEARCH_TYPES = new Set(["text", "longtext", "id", "number", "percent", "duration", "date", "boolean"]);

const SELECT_SEARCH_TYPES = new Set(["select"]);

export const escapeSearchLikePattern = (s: string): string => s.replace(/([\\%_])/g, "\\$1");
const dataFor = (alias: string) => sql.unsafe(`${alias}.data`);

/**
 * Searchable fields = fields with a stable SQL-side text or label
 * projection. This drives only the UI scope picker; compileSearchClause
 * remains the authoritative backend implementation.
 */
export const filterSearchableFields = (fields: Field[]): Field[] =>
  fields.filter((f) => !f.deletedAt && (SCALAR_SEARCH_TYPES.has(f.type) || SELECT_SEARCH_TYPES.has(f.type) || f.type === "relation"));

export const optionIdsMatchingSearch = (field: Field, q: string): string[] => {
  const options = (field.config as { options?: Array<{ id: string; label: string }> }).options ?? [];
  const needle = q.toLowerCase();
  return options.filter((o) => o.label.toLowerCase().includes(needle)).map((o) => o.id);
};

const scalarClause = (field: Field, alias: string, pattern: string): any =>
  sql`${dataFor(alias)}->>${field.id} ILIKE ${pattern} ESCAPE '\\'`;

const selectClause = (field: Field, alias: string, q: string): any | null => {
  const ids = optionIdsMatchingSearch(field, q);
  if (ids.length === 0) return null;
  const parts = ids.map((id) => sql`(${dataFor(alias)}->${field.id})::jsonb @> ${[id]}::jsonb`);
  const orClause = parts.reduce((acc, cur) => sql`${acc} OR ${cur}`);
  return sql`(${orClause})`;
};

export const compileDirectFieldSearchClause = (field: Field, alias: string, q: string, pattern: string): any | null => {
  if (SCALAR_SEARCH_TYPES.has(field.type)) return scalarClause(field, alias, pattern);
  if (SELECT_SEARCH_TYPES.has(field.type)) return selectClause(field, alias, q);
  return null;
};

const canReadTargetTable = async (targetTableId: string, viewer?: ExpansionViewer, client?: SqlClient): Promise<boolean> =>
  viewer ? (await resolveReadableTableIds([targetTableId], viewer, client)).has(targetTableId) : true;

const relationSearchFields = (targetFields: Field[]): Field[] => relationLabelFields(targetFields);

const relationClause = async (params: {
  client?: SqlClient;
  field: Field;
  alias: string;
  q: string;
  pattern: string;
  viewer?: ExpansionViewer;
  targetFieldsCache: Map<string, Field[]>;
  targetReadCache: Map<string, boolean>;
  relationSource?: "links" | "recordData";
  recordSourcesByTableId?: Map<string, RecordSource>;
}): Promise<SearchClause | null> => {
  const cfg = params.field.config as { targetTableId?: string };
  if (!cfg.targetTableId) return null;

  let canRead = params.targetReadCache.get(cfg.targetTableId);
  if (canRead === undefined) {
    canRead = await canReadTargetTable(cfg.targetTableId, params.viewer, params.client);
    params.targetReadCache.set(cfg.targetTableId, canRead);
  }
  if (!canRead) return null;

  let targetFields = params.targetFieldsCache.get(cfg.targetTableId);
  if (!targetFields) {
    targetFields = await listFields(cfg.targetTableId, false, params.client);
    params.targetFieldsCache.set(cfg.targetTableId, targetFields);
  }

  const fieldClauses = relationSearchFields(targetFields)
    .map((f) => compileDirectFieldSearchClause(f, "target", params.q, params.pattern))
    .filter((clause): clause is NonNullable<typeof clause> => clause !== null);
  if (fieldClauses.length === 0) return null;
  const targetWhere = fieldClauses.reduce((acc, cur) => sql`${acc} OR ${cur}`);
  const targetSource = params.recordSourcesByTableId?.get(cfg.targetTableId);
  const targetRelation = targetSource ? sql`${targetSource.relation} target` : sql`grids.records target`;

  return params.relationSource === "recordData"
    ? {
        clause: sql`EXISTS (
      SELECT 1
      FROM jsonb_array_elements_text(
        CASE
          WHEN jsonb_typeof(${dataFor(params.alias)}->${params.field.id}) = 'array'
          THEN ${dataFor(params.alias)}->${params.field.id}
          ELSE '[]'::jsonb
        END
      ) relation_id(value)
      JOIN ${targetRelation}
        ON target.id = relation_id.value::uuid
       AND target.table_id = ${cfg.targetTableId}::uuid
       AND target.deleted_at IS NULL
      WHERE ${targetWhere}
    )`,
      }
    : {
        clause: sql`EXISTS (
    SELECT 1
    FROM grids.record_links search_rl
    JOIN ${targetRelation}
      ON target.id = search_rl.to_record_id
     AND target.table_id = ${cfg.targetTableId}::uuid
     AND target.deleted_at IS NULL
    WHERE search_rl.from_record_id = ${sql.unsafe(`${params.alias}.id`)}
      AND search_rl.from_field_id = ${params.field.id}::uuid
      AND (${targetWhere})
    )`,
      };
};

export const compileSearchClause = async (params: {
  client?: SqlClient;
  search?: SearchSpec | null;
  fields: Field[];
  alias?: string;
  viewer?: ExpansionViewer;
  relationSource?: "links" | "recordData";
  recordSourcesByTableId?: Map<string, RecordSource>;
}): Promise<SearchClause> => {
  const q = params.search?.q.trim();
  if (!q) return { clause: sql`TRUE` };

  const alias = params.alias ?? "r";
  const pattern = `%${escapeSearchLikePattern(q)}%`;
  const alive = params.fields.filter((f) => !f.deletedAt);
  const scoped =
    params.search?.fieldIds && params.search.fieldIds.length > 0
      ? alive.filter((f) => params.search!.fieldIds!.includes(f.id))
      : filterSearchableFields(alive);

  const clauses: any[] = [];
  const targetFieldsCache = new Map<string, Field[]>();
  const targetReadCache = new Map<string, boolean>();

  for (const field of scoped) {
    const direct = compileDirectFieldSearchClause(field, alias, q, pattern);
    if (direct) {
      clauses.push(direct);
      continue;
    }
    if (field.type === "relation") {
      const rel = await relationClause({
        client: params.client,
        field,
        alias,
        q,
        pattern,
        viewer: params.viewer,
        targetFieldsCache,
        targetReadCache,
        relationSource: params.relationSource,
        recordSourcesByTableId: params.recordSourcesByTableId,
      });
      if (rel) clauses.push(rel.clause);
    }
  }

  if (clauses.length === 0) return { clause: sql`FALSE` };
  const orClause = clauses.reduce((acc, cur) => sql`${acc} OR ${cur}`);
  return { clause: sql`(${orClause})` };
};
