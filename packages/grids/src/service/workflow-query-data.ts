import { err, fail, ok, type Result } from "@k2b/stdlib";
import { sql } from "bun";
import { DslQueryExecuteBodySchema } from "../contracts";
import { canonicalizeDslQuery } from "../query-dsl/canonical";
import type { DslQueryContextInput } from "../query-dsl/parameters";
import { parseGridsQueryDsl } from "../query-dsl/parser";
import { dslQueryReferencedFieldIds } from "../query-dsl/plan-dependencies";
import { previewDslQuery } from "../query-dsl/preview";
import type { DslResolvedSqlQueryPlan, DslResolverContext } from "../query-dsl/resolver";
import { collectDslPlanTableIds, needsDslViewCatalog } from "../query-dsl/source-plan";
import { MAX_WORKFLOW_QUERY_ROWS, type WorkflowQueryCapture, WorkflowQueryPayloadSchema } from "../workflows/query-contracts";
import type { SqlClient } from "./audit";
import { canonicalDocumentJson, canonicalJson, MAX_DOCUMENT_PROFILE_INPUT_BYTES } from "./document-json";
import { documentServiceText } from "./document-messages";
import { toPublicGqlResponse } from "./gql-public-result";
import { buildTrustedGqlResolverContext } from "./gql-resolver-context";
import { projectPublicIds } from "./public-resource-ids";

export type WorkflowQueryBinding = { source: string; schemaHash: string };

const queryDependencies = (plan: DslResolvedSqlQueryPlan, context: DslResolverContext) => {
  const byId = new Map(
    Object.values(context.fieldsByTableId)
      .flat()
      .map((field) => [field.id, field]),
  );
  const fieldIds = dslQueryReferencedFieldIds(plan, context.fieldsByTableId);
  const tableIds = new Set(collectDslPlanTableIds(plan, context.fieldsByTableId));
  for (const id of fieldIds) {
    const field = byId.get(id);
    if (!field) continue;
    tableIds.add(field.tableId);
    // Raw relation IDs still require access to their target. Search can also
    // depend on that target's presentable fields and their computed values.
    if (field.type === "relation" && typeof field.config.targetTableId === "string") {
      tableIds.add(field.config.targetTableId);
    }
  }
  // Search uses presentation fields. Pin their metadata conservatively rather
  // than silently changing search semantics when presentable fields change.
  const usesSearch = Boolean(plan.query.search || (plan.sqlSearch?.length ?? 0) > 0);
  if (usesSearch) {
    for (const tableId of tableIds) for (const field of context.fieldsByTableId[tableId] ?? []) fieldIds.add(field.id);
  }
  const fields = [...fieldIds].sort().flatMap((id) => {
    const field = byId.get(id);
    if (!field) return [];
    // Option labels are current presentation, not a new scalar type. Literal
    // predicates are rebound to stable option IDs, and runtime validation still
    // rejects removed options. Search does depend on these labels.
    const config =
      field.type === "select" && !usesSearch
        ? Object.fromEntries(Object.entries(field.config).filter(([key]) => key !== "options" && key !== "defaultValue"))
        : field.config;
    return [
      {
        id,
        tableId: field.tableId,
        type: field.type,
        config,
        ...(usesSearch ? { presentable: field.presentable } : {}),
      },
    ];
  });
  return { fields, tableIds: [...tableIds].sort() };
};

/** Bind once at publication; the source keeps parameters, never their values. */
export const bindWorkflowQueryData = (
  source: string,
  context: DslResolverContext,
  values: DslQueryContextInput,
  locale?: string,
  options: { parameterTypesOnly?: boolean } = {},
): Result<{ binding: WorkflowQueryBinding; plan: DslResolvedSqlQueryPlan; tableIds: string[] }> => {
  const t = documentServiceText(locale);
  const validSource = DslQueryExecuteBodySchema.shape.query.safeParse(source);
  if (!validSource.success) return fail(err.badInput(t.sourceInvalid));
  const parsed = parseGridsQueryDsl(validSource.data);
  if (!parsed.ok) return fail(err.badInput(t.sourceInvalid));
  // Live View definitions cannot be a stable workflow input. V1 binds inline
  // table sources; a future View input must pin its actual definition first.
  if (!parsed.ast.source || needsDslViewCatalog(parsed.ast)) return fail(err.badInput(t.workflowQueryInlineRequired));
  const canonical = canonicalizeDslQuery(parsed.ast, context, values, options);
  if (!canonical.ok) return fail(err.badInput(t.sourceInvalid));
  const dependencies = queryDependencies(canonical.plan, context);
  const schemaHash = canonicalJson({ source: canonical.source, ...dependencies }, locale).sha256;
  return ok({
    binding: { source: canonical.source, schemaHash },
    plan: canonical.plan,
    tableIds: dependencies.tableIds,
  });
};

/** Capture only. The transactional workflow step must persist this payload and
 * its small journal reference together. Never return these rows in the journal. */
export const captureWorkflowQueryData = async (input: {
  baseId: string;
  binding: WorkflowQueryBinding;
  values: DslQueryContextInput;
  timeZone: string;
  locale?: string;
  signal?: AbortSignal;
  canReadTable: (tableId: string, client: SqlClient) => Promise<boolean>;
}): Promise<Result<WorkflowQueryCapture>> => {
  const t = documentServiceText(input.locale);
  return sql.begin(async (client) => {
    await client`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`;
    input.signal?.throwIfAborted();
    const parsed = parseGridsQueryDsl(input.binding.source);
    if (!parsed.ok) return fail(err.badInput(t.sourceInvalid));
    const context = await buildTrustedGqlResolverContext({
      baseId: input.baseId,
      ast: parsed.ast,
      purpose: "workflow-query",
      client,
    });
    const bound = bindWorkflowQueryData(input.binding.source, context, input.values, input.locale);
    if (!bound.ok) return bound;
    if (bound.data.binding.schemaHash !== input.binding.schemaHash) return fail(err.conflict(t.workflowQuerySchemaChanged));
    const authorizedTableIds = new Set<string>();
    for (const tableId of bound.data.tableIds) {
      if (!(await input.canReadTable(tableId, client))) return fail(err.forbidden(t.workflowQueryAccessDenied));
      authorizedTableIds.add(tableId);
    }
    // Frozen computations may retain dependencies absent from today's schema.
    // Additional tables are individually checked, never implicitly granted.
    for (const table of context.tables ?? []) {
      if (!authorizedTableIds.has(table.id) && (await input.canReadTable(table.id, client))) authorizedTableIds.add(table.id);
    }
    const result = await previewDslQuery(bound.data.plan, {
      client,
      locale: input.locale,
      fieldsByTableId: context.fieldsByTableId,
      timeZone: input.timeZone,
      authorizedTableIds,
      primaryTableAuthorized: true,
      labelRelationValues: false,
      maxRows: MAX_WORKFLOW_QUERY_ROWS,
      pageSize: MAX_WORKFLOW_QUERY_ROWS,
      maxResultBytes: MAX_DOCUMENT_PROFILE_INPUT_BYTES,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (!result.ok) return result;
    if (result.data.truncated || result.data.page?.nextCursor) return fail(err.badInput(t.workflowQueryIncomplete));
    const projected = await toPublicGqlResponse(result.data, {
      projectIds: (type, ids) => projectPublicIds(type, ids, client),
    });
    if (!projected.ok) return fail(err.internal(t.sourceExecutionFailed));
    input.signal?.throwIfAborted();
    const capturedAt = new Date().toISOString();
    let payload: ReturnType<typeof canonicalDocumentJson>;
    try {
      payload = canonicalDocumentJson(
        {
          version: 1,
          columns: projected.columns.map(({ key, label, type, sqlType }) => ({ key, label, type, sqlType })),
          rows: projected.rows.map((row) => row.values),
          rowOrigins: projected.rows.map((row) => ({
            recordId: row.recordId ?? null,
            tableId: row.tableId ?? null,
            ...(row.recordMeta ? { version: row.recordMeta.version } : {}),
          })),
          rowCount: projected.rows.length,
          capturedAt,
          complete: true,
          selectionLimit: bound.data.plan.query.limit ?? null,
          source: input.binding.source,
          schemaHash: input.binding.schemaHash,
          context: input.values,
          tableIds: bound.data.tableIds,
        },
        input.locale,
      );
    } catch {
      return fail(err.badInput(t.tableOutputDataInvalid));
    }
    const checked = WorkflowQueryPayloadSchema.safeParse(payload.value);
    if (!checked.success) return fail(err.badInput(t.tableOutputDataInvalid));
    return ok({ payload: checked.data, sha256: payload.sha256, rowCount: projected.rows.length, capturedAt });
  });
};
