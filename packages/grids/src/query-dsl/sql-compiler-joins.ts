import { sql } from "bun";
import type { DslResolvedRelationJoin } from "./resolver";
import type { DslSqlCompileOptions } from "./sql-compiler-types";

export const dslJoinRecordAlias = (index: number): string => `jq${index}`;

const joinLinkAlias = (index: number): string => `jql${index}`;

const boundedPositiveInt = (value: number | undefined, fallback: number, max: number): number =>
  Math.min(Math.max(value ?? fallback, 1), max);

export const compileRelationJoin = (
  join: DslResolvedRelationJoin,
  index: number,
  joinAliases: Map<string, string>,
  options: Pick<DslSqlCompileOptions, "joinFanoutLimit" | "recordSource" | "recordSourcesByTableId"> & {
    correlateTarget?: boolean;
  } = {},
): { ok: true; fragment: unknown; recordAlias: string } | { ok: false; error: string } => {
  const fromAlias = join.fromScope ? joinAliases.get(join.fromScope) : "r";
  if (!fromAlias) return { ok: false, error: `join "${join.alias}" depends on unknown join alias "${join.fromScope}"` };

  const linkAlias = joinLinkAlias(index);
  const recordAlias = dslJoinRecordAlias(index);
  const joinSql = join.mode === "left" ? sql`LEFT JOIN` : sql`JOIN`;
  const fanoutLimit = options.joinFanoutLimit ? boundedPositiveInt(options.joinFanoutLimit, 50, 500) : null;
  const targetSource = options.recordSourcesByTableId?.get(join.tableId);
  const fromSource = join.fromScope ? options.recordSourcesByTableId?.get(join.fromTableId) : options.recordSource;

  if (targetSource?.kind === "federated" && join.direction === "reverse") {
    const mappings = targetSource.relationMappings.filter((mapping) => mapping.targetFieldId === join.relationFieldId);
    if (mappings.length === 0) {
      return { ok: false, error: `reverse join "${join.alias}" uses an unmapped Combined-table relation field` };
    }
    const mappingPredicate = mappings
      .slice(1)
      .reduce(
        (condition, mapping) =>
          sql`${condition} OR (target_record.source_table_id = ${mapping.sourceTableId}::uuid AND target_link.from_field_id = ${mapping.sourceFieldId}::uuid)`,
        sql`(target_record.source_table_id = ${mappings[0]!.sourceTableId}::uuid AND target_link.from_field_id = ${mappings[0]!.sourceFieldId}::uuid)`,
      );
    const targetRows = sql`
      SELECT target_record.*
      FROM grids.record_links target_link
      JOIN ${targetSource.relation} target_record
        ON target_record.id = target_link.from_record_id
      WHERE target_link.to_record_id = ${sql.unsafe(fromAlias)}.id
        AND (${mappingPredicate})
      ORDER BY target_record.id
      ${fanoutLimit ? sql`LIMIT ${fanoutLimit}` : sql``}
    `;
    return {
      ok: true,
      recordAlias,
      fragment: sql`${joinSql} LATERAL (${targetRows}) ${sql.unsafe(recordAlias)} ON TRUE`,
    };
  }

  if (fromSource) {
    if (join.direction === "reverse") {
      // Reverse joins use the target relation field and therefore continue
      // through the regular record_links path below.
    } else {
      const values = sql`CASE
      WHEN jsonb_typeof(${sql.unsafe(fromAlias)}.data->${join.relationFieldId}) = 'array'
      THEN ${sql.unsafe(fromAlias)}.data->${join.relationFieldId}
      ELSE '[]'::jsonb
    END`;
      const valueSource = fanoutLimit
        ? sql`SELECT value FROM jsonb_array_elements_text(${values}) value ORDER BY value LIMIT ${fanoutLimit}`
        : sql`SELECT value FROM jsonb_array_elements_text(${values}) value`;
      const targetRelation = targetSource
        ? sql`${targetSource.relation} ${sql.unsafe(recordAlias)}`
        : sql`grids.records ${sql.unsafe(recordAlias)}`;
      return {
        ok: true,
        recordAlias,
        fragment: sql`
        ${joinSql} LATERAL (${valueSource}) ${sql.unsafe(linkAlias)}(target_id) ON TRUE
        ${joinSql} ${targetRelation}
          ON ${sql.unsafe(recordAlias)}.id = ${sql.unsafe(linkAlias)}.target_id::uuid
         AND ${sql.unsafe(recordAlias)}.table_id = ${join.tableId}::uuid
         AND ${sql.unsafe(recordAlias)}.deleted_at IS NULL
      `,
      };
    }
  }

  if (options.correlateTarget && fanoutLimit && join.direction === "forward" && !targetSource) {
    const targetRows = sql`
      SELECT target_record.*
      FROM grids.record_links target_link
      JOIN grids.records target_record
        ON target_record.id = target_link.to_record_id
       AND target_record.table_id = ${join.tableId}::uuid
       AND target_record.deleted_at IS NULL
      WHERE target_link.from_record_id = ${sql.unsafe(fromAlias)}.id
        AND target_link.from_field_id = ${join.relationFieldId}::uuid
        AND EXISTS (
          SELECT 1
          FROM grids.tables target_table
          JOIN grids.bases target_base
            ON target_base.id = target_table.base_id
           AND target_base.deleted_at IS NULL
          WHERE target_table.id = target_record.table_id
            AND target_table.deleted_at IS NULL
        )
      ORDER BY target_link.to_record_id
      LIMIT ${fanoutLimit}
    `;
    return {
      ok: true,
      recordAlias,
      fragment: sql`${joinSql} LATERAL (${targetRows}) ${sql.unsafe(recordAlias)} ON TRUE`,
    };
  }

  const linkSourceColumn = join.direction === "reverse" ? "from_record_id" : "to_record_id";
  const linkMatchColumn = join.direction === "reverse" ? "to_record_id" : "from_record_id";
  const linkJoin = fanoutLimit
    ? sql`
      ${joinSql} LATERAL (
        SELECT ${sql.unsafe(`_dsl_link.${linkSourceColumn}`)}
        FROM grids.record_links _dsl_link
        WHERE ${sql.unsafe(`_dsl_link.${linkMatchColumn}`)} = ${sql.unsafe(fromAlias)}.id
          AND _dsl_link.from_field_id = ${join.relationFieldId}::uuid
        ORDER BY ${sql.unsafe(`_dsl_link.${linkSourceColumn}`)}
        LIMIT ${fanoutLimit}
      ) ${sql.unsafe(linkAlias)} ON TRUE
    `
    : sql`
      ${joinSql} grids.record_links ${sql.unsafe(linkAlias)}
        ON ${sql.unsafe(`${linkAlias}.${linkMatchColumn}`)} = ${sql.unsafe(fromAlias)}.id
       AND ${sql.unsafe(linkAlias)}.from_field_id = ${join.relationFieldId}::uuid
    `;

  const targetRelation = targetSource
    ? sql`${targetSource.relation} ${sql.unsafe(recordAlias)}`
    : sql`grids.records ${sql.unsafe(recordAlias)}`;
  return {
    ok: true,
    recordAlias,
    fragment: sql`
      ${linkJoin}
      ${joinSql} ${targetRelation}
        ON ${sql.unsafe(recordAlias)}.id = ${sql.unsafe(`${linkAlias}.${linkSourceColumn}`)}
       AND ${sql.unsafe(recordAlias)}.table_id = ${join.tableId}::uuid
       AND ${sql.unsafe(recordAlias)}.deleted_at IS NULL
       AND EXISTS (
         SELECT 1
         FROM grids.tables ${sql.unsafe(`${recordAlias}_t`)}
         JOIN grids.bases ${sql.unsafe(`${recordAlias}_b`)}
           ON ${sql.unsafe(`${recordAlias}_b`)}.id = ${sql.unsafe(`${recordAlias}_t`)}.base_id
          AND ${sql.unsafe(`${recordAlias}_b`)}.deleted_at IS NULL
         WHERE ${sql.unsafe(`${recordAlias}_t`)}.id = ${sql.unsafe(recordAlias)}.table_id
           AND ${sql.unsafe(`${recordAlias}_t`)}.deleted_at IS NULL
       )
    `,
  };
};
