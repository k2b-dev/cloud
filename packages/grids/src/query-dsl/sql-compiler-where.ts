import { sql } from "bun";
import { compileFilter, renderClause } from "../service/filter-compiler";
import { compileFormulaPredicateAstToSql, type FormulaSqlExpression, type FormulaSqlFieldResolver } from "../service/formula-sql-compiler";
import { requireValidCalculationSql } from "../service/formula-sql-values";
import { compileRecordMetaFilter } from "../service/record-metadata";
import type { Field } from "../service/types";
import type { DslWherePredicate } from "./resolver";
import type { DslSqlRecordSource } from "./sql-compiler-types";

type PredicateCompileOptions = {
  recordAlias?: string;
  joinAliases?: Map<string, string>;
  fieldsByTableId?: Record<string, Field[]>;
  recordSourcesByTableId?: Map<string, DslSqlRecordSource>;
  timeZone?: string;
  computedFieldSql?: Map<string, FormulaSqlExpression>;
  resolveField?: FormulaSqlFieldResolver;
  relationSource?: "links" | "recordData";
};

type PredicateCompileResult = { ok: true; sql: unknown } | { ok: false; error: string };

const publicRelationMatch = (
  node: Extract<DslWherePredicate, { kind: "publicRelationIds" }>,
  shortIds: readonly string[],
  relationSource: PredicateCompileOptions["relationSource"],
  recordAlias: string,
): unknown => {
  const target = sql`target_record.table_id = ${node.targetTableId}::uuid
    AND target_record.deleted_at IS NULL
    AND target_record.short_id = ANY(${sql.array([...shortIds], "TEXT")})`;
  if (relationSource === "recordData") {
    return sql`EXISTS (
      SELECT 1 FROM grids.records target_record
      WHERE ${target}
        AND CASE
          WHEN jsonb_typeof(${sql.unsafe(recordAlias)}.data->${node.fieldId}) = 'array' THEN ${sql.unsafe(recordAlias)}.data->${node.fieldId}
          ELSE '[]'::jsonb
        END @> jsonb_build_array(target_record.id::text)
    )`;
  }
  return sql`EXISTS (
    SELECT 1
    FROM grids.record_links relation_link
    JOIN grids.records target_record ON target_record.id = relation_link.to_record_id
    WHERE relation_link.from_record_id = ${sql.unsafe(recordAlias)}.id
      AND relation_link.from_field_id = ${node.fieldId}::uuid
      AND ${target}
  )`;
};

const joinPredicateParts = (parts: unknown[], separator: unknown): unknown => {
  if (parts.length === 0) return sql``;
  return parts.slice(1).reduce((acc, part) => sql`${acc}${separator}${part}`, parts[0]!);
};

export const compileWherePredicate = (
  node: DslWherePredicate,
  fields: Field[],
  options: PredicateCompileOptions,
): PredicateCompileResult => {
  switch (node.kind) {
    case "filePresence": {
      if (options.relationSource === "recordData") return { ok: false, error: "file presence predicates require a stored table" };
      const present = sql`EXISTS (SELECT 1 FROM grids.file_attachments attachment
        WHERE attachment.record_id = ${sql.unsafe(options.recordAlias ?? "r")}.id
          AND attachment.field_id = ${node.fieldId}::uuid)`;
      return { ok: true, sql: node.empty ? sql`NOT (${present})` : present };
    }
    case "scoped": {
      const recordAlias = options.joinAliases?.get(node.joinAlias);
      const scopedFields = options.fieldsByTableId?.[node.tableId];
      if (!recordAlias || !scopedFields) return { ok: false, error: `unknown predicate scope "${node.joinAlias}"` };
      return compileWherePredicate(node.predicate, scopedFields, {
        ...options,
        recordAlias,
        relationSource: options.recordSourcesByTableId?.has(node.tableId) ? "recordData" : "links",
      });
    }
    case "and":
    case "or": {
      const parts: unknown[] = [];
      for (const part of node.parts) {
        const compiled = compileWherePredicate(part, fields, options);
        if (!compiled.ok) return compiled;
        parts.push(sql`(${compiled.sql})`);
      }
      if (parts.length === 0) return { ok: true, sql: node.kind === "and" ? sql`TRUE` : sql`FALSE` };
      return { ok: true, sql: joinPredicateParts(parts, node.kind === "and" ? sql` AND ` : sql` OR `) };
    }
    case "not": {
      const compiled = compileWherePredicate(node.part, fields, options);
      if (!compiled.ok) return compiled;
      return { ok: true, sql: sql`(NOT (${compiled.sql}))` };
    }
    case "filter":
    case "tree": {
      const compiled = compileFilter(node.kind === "tree" ? node.tree : node.leaf, fields, { timeZone: options.timeZone });
      if (!compiled.ok) return { ok: false, error: compiled.error };
      return { ok: true, sql: renderClause(compiled.clause, { recordAlias: options.recordAlias, relationSource: options.relationSource }) };
    }
    case "recordMeta":
      return { ok: true, sql: compileRecordMetaFilter(node.meta) };
    case "publicRecordIds":
      return { ok: true, sql: sql`r.short_id = ANY(${sql.array(node.ids, "TEXT")})` };
    case "publicRelationIds": {
      if (node.ids.length === 0) return { ok: true, sql: node.mode === "none" ? sql`TRUE` : sql`FALSE` };
      if (node.mode === "all") {
        return {
          ok: true,
          sql: joinPredicateParts(
            node.ids.map((id) => sql`(${publicRelationMatch(node, [id], options.relationSource, options.recordAlias ?? "r")})`),
            sql` AND `,
          ),
        };
      }
      const match = publicRelationMatch(node, node.ids, options.relationSource, options.recordAlias ?? "r");
      return { ok: true, sql: node.mode === "none" ? sql`NOT (${match})` : match };
    }
    case "formula": {
      const compiled = compileFormulaPredicateAstToSql(node.expression, {
        documentMetadata: true,
        fields,
        recordAlias: "r",
        dateConfig: options.timeZone ? { timeZone: options.timeZone } : undefined,
        computedFieldSql: options.computedFieldSql,
        resolveField: options.resolveField,
      });
      if (!compiled.ok) return { ok: false, error: compiled.error };
      return { ok: true, sql: requireValidCalculationSql(compiled.expression) };
    }
  }
};
