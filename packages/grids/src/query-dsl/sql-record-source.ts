import { sql } from "bun";
import type { FilterTree } from "../contracts";
import type { SqlClient } from "../service/audit";
import { buildComputedFieldSqlMap, buildFormulaSqlProjections } from "../service/computed-projections";
import { getActive } from "../service/federated-tables";
import { listByTables } from "../service/field-read";
import { storageOf } from "../service/field-storage";
import { listByTable as listFields } from "../service/fields";
import { type CompiledClause, compileFilter, renderClause } from "../service/filter-compiler";
import { get as getTable } from "../service/tables";
import type { Field } from "../service/types";
import type { DslWherePredicate } from "./resolver";
import type { DslSqlFederatedRecordSource, DslSqlRecordSource } from "./sql-compiler-types";

const joinSql = (parts: unknown[], separator: unknown): unknown => {
  if (parts.length === 0) return sql``;
  return parts.slice(1).reduce((result, part) => sql`${result}${separator}${part}`, parts[0]!);
};

type PushdownInput = {
  filter?: FilterTree;
  wherePredicate?: DslWherePredicate;
  timeZone?: string;
  includeDeleted?: boolean;
  deletedOnly?: boolean;
};

type TranslatedClause = { clause: CompiledClause; exact: boolean } | null;

const translateClause = (clause: CompiledClause, sourceFieldByTargetId: Map<string, Field>): TranslatedClause => {
  switch (clause.kind) {
    case "true":
    case "false":
      return { clause, exact: true };
    case "predicate": {
      const sourceField = sourceFieldByTargetId.get(clause.fieldId);
      if (!sourceField) return null;
      const descriptor = storageOf(sourceField);
      if (descriptor.kind === "relationLink" || descriptor.kind === "computed" || descriptor.kind === "jsonbArray") return null;
      return {
        clause: {
          ...clause,
          fieldId: sourceField.id,
          fieldType: sourceField.type,
        },
        exact: true,
      };
    }
    case "and": {
      const translated = clause.parts.map((part) => translateClause(part, sourceFieldByTargetId));
      const parts = translated.flatMap((part) => (part ? [part.clause] : []));
      if (parts.length === 0) return null;
      return { clause: { kind: "and", parts }, exact: translated.every((part) => part?.exact === true) };
    }
    case "or": {
      const translated = clause.parts.map((part) => translateClause(part, sourceFieldByTargetId));
      if (translated.some((part) => part?.exact !== true)) return null;
      return { clause: { kind: "or", parts: translated.map((part) => part!.clause) }, exact: true };
    }
    case "not": {
      const translated = translateClause(clause.inner, sourceFieldByTargetId);
      return translated?.exact ? { clause: { kind: "not", inner: translated.clause }, exact: true } : null;
    }
  }
};

const compileWherePushdown = (
  predicate: DslWherePredicate,
  targetFields: Field[],
  sourceFieldByTargetId: Map<string, Field>,
  timeZone?: string,
): TranslatedClause => {
  switch (predicate.kind) {
    case "filter":
    case "tree": {
      const compiled = compileFilter(predicate.kind === "tree" ? predicate.tree : predicate.leaf, targetFields, { timeZone });
      return compiled.ok ? translateClause(compiled.clause, sourceFieldByTargetId) : null;
    }
    case "and": {
      const translated = predicate.parts.map((part) => compileWherePushdown(part, targetFields, sourceFieldByTargetId, timeZone));
      const parts = translated.flatMap((part) => (part ? [part.clause] : []));
      if (parts.length === 0) return null;
      return { clause: { kind: "and", parts }, exact: translated.every((part) => part?.exact === true) };
    }
    case "or": {
      const translated = predicate.parts.map((part) => compileWherePushdown(part, targetFields, sourceFieldByTargetId, timeZone));
      if (translated.some((part) => part?.exact !== true)) return null;
      return { clause: { kind: "or", parts: translated.map((part) => part!.clause) }, exact: true };
    }
    case "not": {
      const translated = compileWherePushdown(predicate.part, targetFields, sourceFieldByTargetId, timeZone);
      return translated?.exact ? { clause: { kind: "not", inner: translated.clause }, exact: true } : null;
    }
    case "formula":
    case "recordMeta":
    case "publicRecordIds":
    case "publicRelationIds":
      return null;
  }
};

const branchPushdown = (params: { input?: PushdownInput; targetFields: Field[]; sourceFieldByTargetId: Map<string, Field> }): unknown => {
  if (!params.input) return sql`TRUE`;
  const clauses: CompiledClause[] = [];
  if (params.input.filter) {
    const compiled = compileFilter(params.input.filter, params.targetFields, { timeZone: params.input.timeZone });
    if (compiled.ok) {
      const translated = translateClause(compiled.clause, params.sourceFieldByTargetId);
      if (translated) clauses.push(translated.clause);
    }
  }
  if (params.input.wherePredicate) {
    const translated = compileWherePushdown(
      params.input.wherePredicate,
      params.targetFields,
      params.sourceFieldByTargetId,
      params.input.timeZone,
    );
    if (translated) clauses.push(translated.clause);
  }
  const fieldClause =
    clauses.length === 0
      ? sql`TRUE`
      : renderClause(clauses.length === 1 ? clauses[0]! : { kind: "and", parts: clauses }, { recordAlias: "source_record" });
  const deletedClause = params.input.deletedOnly
    ? sql`source_record.deleted_at IS NOT NULL`
    : params.input.includeDeleted
      ? sql`TRUE`
      : sql`source_record.deleted_at IS NULL`;
  return sql`${deletedClause} AND ${fieldClause}`;
};

const mappedSelectValue = (field: Field, config: Record<string, unknown>, recordAlias: string): unknown => {
  const raw = sql`${sql.unsafe(recordAlias)}.data->${field.id}`;
  const optionMap = (config.optionMap ?? {}) as Record<string, unknown>;
  const cases = Object.entries(optionMap).flatMap(([sourceId, targetId]) =>
    typeof targetId === "string" ? [sql`WHEN option.value = ${sourceId} THEN ${targetId}`] : [],
  );
  const mapped = cases.length > 0 ? sql`CASE ${joinSql(cases, sql` `)} ELSE NULL END` : sql`NULL::text`;
  return sql`CASE
    WHEN ${raw} IS NULL OR jsonb_typeof(${raw}) <> 'array' THEN NULL::jsonb
    ELSE (
      SELECT COALESCE(jsonb_agg(to_jsonb(mapped.value) ORDER BY mapped.position), '[]'::jsonb)
      FROM (
        SELECT ${mapped} AS value, option.position
        FROM jsonb_array_elements_text(${raw}) WITH ORDINALITY AS option(value, position)
      ) mapped
      WHERE mapped.value IS NOT NULL
    )
  END`;
};

const sourceFieldJson = (
  field: Field,
  config: Record<string, unknown>,
  recordAlias: string,
  computed: Map<string, { sql: unknown }>,
): unknown => {
  const descriptor = storageOf(field);
  if (field.type === "select") return mappedSelectValue(field, config, recordAlias);
  if (descriptor.kind === "relationLink") {
    return sql`(
      SELECT COALESCE(jsonb_agg(to_jsonb(link.to_record_id::text) ORDER BY link.position), '[]'::jsonb)
      FROM grids.record_links link
      WHERE link.from_record_id = ${sql.unsafe(recordAlias)}.id
        AND link.from_field_id = ${field.id}::uuid
    )`;
  }
  if (descriptor.kind === "json" || descriptor.kind === "jsonbArray") {
    return sql`${sql.unsafe(recordAlias)}.data->${field.id}`;
  }
  if (field.type === "lookup" || field.type === "rollup") {
    const projection = computed.get(field.id)?.sql;
    return projection ? sql`to_jsonb(${projection})` : sql`NULL::jsonb`;
  }
  const projection = descriptor.project(field, recordAlias);
  return projection ? sql`to_jsonb(${projection})` : sql`${sql.unsafe(recordAlias)}.data->${field.id}`;
};

const branchForSource = async (params: {
  client?: SqlClient;
  targetTableId: string;
  sourceTableId: string;
  sourceFields: Field[];
  targetFields: Map<string, Field>;
  mappings: Array<{ targetFieldId: string; sourceFieldId: string; config: Record<string, unknown> }>;
  pushdown?: PushdownInput;
}): Promise<{ relation: unknown }> => {
  const sourceFieldsById = new Map(params.sourceFields.map((field) => [field.id, field]));
  const computed = await buildComputedFieldSqlMap(params.sourceFields, { recordAlias: "source_record", client: params.client });
  for (const projection of buildFormulaSqlProjections(params.sourceFields, { recordAlias: "source_record" })) {
    if (projection.expr) computed.set(projection.fieldId, { sql: projection.expr, type: "unknown" });
  }
  const pairs: unknown[] = [];
  const sourceFieldByTargetId = new Map<string, Field>();

  for (const mapping of params.mappings) {
    const target = params.targetFields.get(mapping.targetFieldId);
    const source = sourceFieldsById.get(mapping.sourceFieldId);
    if (!target || !source || source.deletedAt) {
      throw new Error("combined table publication contains an invalid field mapping");
    }
    if (["text", "numeric", "boolean", "date", "datetime"].includes(storageOf(source).kind)) {
      sourceFieldByTargetId.set(mapping.targetFieldId, source);
    }
    pairs.push(sql`${target.id}::text, ${sourceFieldJson(source, mapping.config, "source_record", computed)}`);
  }

  const data = pairs.length > 0 ? sql`jsonb_build_object(${joinSql(pairs, sql`, `)})` : sql`'{}'::jsonb`;
  const pushdown = branchPushdown({
    input: params.pushdown,
    targetFields: [...params.targetFields.values()],
    sourceFieldByTargetId,
  });
  return {
    relation: sql`
      SELECT source_record.id,
             ${params.targetTableId}::uuid AS table_id,
             ${params.sourceTableId}::uuid AS source_table_id,
             source_table.base_id AS source_base_id,
             ${data} AS data,
             source_record.version,
             source_record.finalized_at,
             source_record.finalized_by,
             source_record.deleted_at,
             source_record.created_by,
             source_record.updated_by,
             source_record.created_at,
             source_record.updated_at
      FROM grids.records source_record
      JOIN grids.tables source_table
        ON source_table.id = source_record.table_id
       AND source_table.id = ${params.sourceTableId}::uuid
       AND source_table.kind = 'stored'
       AND source_table.deleted_at IS NULL
      JOIN grids.bases source_base
        ON source_base.id = source_table.base_id
       AND source_base.deleted_at IS NULL
      WHERE ${pushdown}
    `,
  };
};

/**
 * Runs the publication guard as its own statement, immediately before reading a
 * combined relation.
 *
 * The relation embeds the same `grids.assert_federated_revision` call, but that
 * copy only fires when the query returns rows: Postgres prunes a subplan whose
 * output cannot contribute, and a raising function is no barrier to that. So a
 * revoked publication over an empty result set produced no rows and no error,
 * which callers cannot tell apart from "this table is empty". Placement inside
 * the SELECT cannot fix it — a materialized CTE, a plain subquery, a scalar
 * subquery, a sentinel row, a lateral dependency and an `OFFSET 0` barrier were
 * all measured, and every one of them stays silent on an empty result.
 *
 * Call this before every read of `source.relation`. It raises P0001, which the
 * DSL consumers already translate into a "publication changed; reload" conflict.
 */
export const assertFederatedPublication = async (
  source: Extract<DslSqlRecordSource, { kind: "federated" }>,
  client: SqlClient = sql,
): Promise<void> => {
  await client`
    SELECT grids.assert_federated_revision(
      ${source.tableId}::uuid,
      ${source.revisionId}::uuid,
      ${source.revisionToken}::text,
      ${source.sourceTableIds.length}::int
    )
  `;
};

export const buildDslSqlRecordSource = async (
  tableId: string,
  fieldsByTableId: Record<string, Field[]>,
  pushdown?: PushdownInput,
  client: SqlClient = sql,
): Promise<DslSqlFederatedRecordSource | null> => {
  const table = await getTable(tableId, { client });
  if (!table || table.kind !== "federated") return null;

  const active = await getActive(tableId, undefined, client);
  if (!active.ok) throw new Error(active.error.message);
  const revision = active.data;
  const targetFields = new Map((fieldsByTableId[tableId] ?? (await listFields(tableId, false, client))).map((field) => [field.id, field]));
  const mappingsBySource = new Map<string, typeof revision.mappings>();
  for (const mapping of revision.mappings) {
    const items = mappingsBySource.get(mapping.sourceTableId) ?? [];
    items.push(mapping);
    mappingsBySource.set(mapping.sourceTableId, items);
  }
  const sourceFieldsByTableId = await listByTables(
    revision.sources.map((source) => source.sourceTableId),
    client,
  );

  const branches = await Promise.all(
    revision.sources.map((source) =>
      branchForSource({
        client,
        targetTableId: tableId,
        sourceTableId: source.sourceTableId,
        sourceFields: sourceFieldsByTableId.get(source.sourceTableId) ?? [],
        targetFields,
        mappings: (mappingsBySource.get(source.sourceTableId) ?? []).map((mapping) => ({
          targetFieldId: mapping.targetFieldId,
          sourceFieldId: mapping.sourceFieldId,
          config: mapping.config,
        })),
        pushdown,
      }),
    ),
  );
  const union = joinSql(
    branches.map((branch) => branch.relation),
    sql` UNION ALL `,
  );

  return {
    kind: "federated",
    tableId,
    revision: revision.revision,
    revisionId: revision.id,
    revisionToken: revision.revisionToken,
    sourceTableIds: revision.sources.map((source) => source.sourceTableId),
    relationMappings: revision.mappings.flatMap((mapping) =>
      targetFields.get(mapping.targetFieldId)?.type === "relation"
        ? [
            {
              targetFieldId: mapping.targetFieldId,
              sourceTableId: mapping.sourceTableId,
              sourceFieldId: mapping.sourceFieldId,
            },
          ]
        : [],
    ),
    relation: sql`(
      WITH publication AS MATERIALIZED (
        SELECT grids.assert_federated_revision(
          ${tableId}::uuid,
          ${revision.id}::uuid,
          ${revision.revisionToken}::text,
          ${revision.sources.length}::int
        ) AS valid
      )
      SELECT combined_rows.*
      FROM publication
      LEFT JOIN LATERAL (${union}) combined_rows ON TRUE
      WHERE publication.valid
        AND combined_rows.id IS NOT NULL
    )`,
  };
};
