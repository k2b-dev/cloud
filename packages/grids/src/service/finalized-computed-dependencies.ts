import { sql } from "bun";
import { collectFieldRefs, parseFormula } from "../formula/parser";
import { normalizeRefKey } from "../ref-syntax";
import type { SqlClient } from "./audit";
import { listByTable } from "./field-read";
import { MAX_FORMULA_INLINE_DEPTH } from "./formula-sql-compiler";
import { liveRecordParentJoinSql } from "./parent-checks";
import { assertSqlIdentifier } from "./sql-ident";
import type { Field } from "./types";

/** Capture provenance alongside values, including the original dependencies of
 * already finalized targets. NULL means unknown, not an empty dependency set. */
export const buildFinalizedComputedDependencies = async (fields: Field[], client: SqlClient): Promise<Map<string, unknown>> => {
  const tables = new Map<string, Promise<Field[]>>();
  if (fields[0]) tables.set(fields[0].tableId, Promise.resolve(fields));
  const tableFields = (id: string) => {
    let result = tables.get(id);
    if (!result) {
      result = listByTable(id, false, client);
      tables.set(id, result);
    }
    return result;
  };
  const dependencies = async (field: Field, siblings: Field[], alias: string, stack: ReadonlySet<string>): Promise<{ sql: unknown }> => {
    // Bun SQL fragments are thenables: keep them inside an object so the async
    // traversal never executes an expression as a standalone query.
    if (field.type !== "formula" && field.type !== "lookup" && field.type !== "rollup") return { sql: sql`'[]'::jsonb` };
    if (stack.has(field.id) || stack.size >= MAX_FORMULA_INLINE_DEPTH) return { sql: sql`NULL::jsonb` };
    const next = new Set([...stack, field.id]);
    const row = sql.unsafe(assertSqlIdentifier(alias));
    let live: unknown = sql`'[]'::jsonb`;
    if (field.type === "formula") {
      const parsed = typeof field.config.expression === "string" ? parseFormula(field.config.expression) : null;
      if (!parsed?.ok) return { sql: sql`NULL::jsonb` };
      for (const ref of collectFieldRefs(parsed.ast)) {
        const dependency = siblings.find(
          (candidate) =>
            !candidate.deletedAt && [candidate.shortId, candidate.name].some((key) => normalizeRefKey(key) === normalizeRefKey(ref)),
        );
        // Record metadata has no external table dependency. Unknown formula
        // references are rejected by the value compiler before finalization.
        if (dependency) live = sql`${live} || ${(await dependencies(dependency, siblings, alias, next)).sql}`;
      }
    } else {
      const relation = siblings.find((candidate) => candidate.id === field.config.relationFieldId && candidate.type === "relation");
      const tableId = relation?.config.targetTableId;
      if (typeof tableId !== "string") return { sql: sql`NULL::jsonb` };
      live = sql`${[tableId]}::jsonb`;
      if (!(field.type === "rollup" && field.config.agg === "count")) {
        const targets = await tableFields(tableId);
        const targetField = targets.find((candidate) => candidate.id === field.config.targetFieldId && !candidate.deletedAt);
        if (!targetField) return { sql: sql`NULL::jsonb` };
        const targetAlias = `${alias}_dep`;
        const target = sql.unsafe(targetAlias);
        const required = (await dependencies(targetField, targets, targetAlias, next)).sql;
        // Including every matching target is conservative for a first-value
        // lookup, and keeps permission changes from changing which value wins.
        const inherited = sql`(SELECT CASE WHEN required.items @> '[null]'::jsonb THEN NULL::jsonb
          ELSE jsonb_path_query_array(COALESCE(required.items, '[]'::jsonb), '$[*][*]') END
          FROM (SELECT jsonb_agg(DISTINCT ${required}) AS items
            FROM grids.record_links links
            JOIN grids.records ${target} ON ${target}.id = links.to_record_id
            ${liveRecordParentJoinSql(targetAlias, `${targetAlias}_table`, `${targetAlias}_base`)}
            WHERE links.from_record_id = ${row}.id AND links.from_field_id = ${relation!.id}::uuid
              AND ${target}.table_id = ${tableId}::uuid AND ${target}.deleted_at IS NULL) required)`;
        live = sql`${live} || ${inherited}`;
      }
    }
    return {
      sql: sql`CASE WHEN ${row}.finalized_at IS NOT NULL THEN ${row}.finalized_computed_dependencies->${field.id} ELSE ${live} END`,
    };
  };
  const result = new Map<string, unknown>();
  for (const field of fields) {
    if (!field.deletedAt && ["formula", "lookup", "rollup", "object_list"].includes(field.type)) {
      result.set(field.id, (await dependencies(field, fields, "r", new Set())).sql);
    }
  }
  return result;
};
