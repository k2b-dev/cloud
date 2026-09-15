import {
  canonicalCustomAppQueryContext,
  customAppQueryPlanHash,
  customAppQueryPlanRelationTargetTableIds,
} from "../custom-apps/query-plan-hash";
import { bindDslQueryContext, type DslQueryContextKey, type DslQueryContextValues, dslQueryContextKeys } from "../query-dsl/parameters";
import { parseGridsQueryDsl } from "../query-dsl/parser";
import { type DslResolvedSqlQueryPlan, resolveDslQueryToQueryPlan } from "../query-dsl/resolver";
import { collectDslPlanExtraFieldTableIds, collectDslPlanTableIds } from "../query-dsl/source-plan";
import type { SqlClient } from "./audit";
import { containsDocumentMetadata } from "./document-query-expression";
import * as fields from "./fields";
import { buildTrustedGqlResolverContext } from "./gql-resolver-context";
import type { Field } from "./types";

type CompiledCustomAppQuery = {
  plan: DslResolvedSqlQueryPlan;
  planHash: string;
  fieldsByTableId: Record<string, Field[]>;
  tableShortIds: Record<string, string>;
};

type CompileCustomAppQueryResult = { ok: true; data: CompiledCustomAppQuery } | { ok: false; error: string };

const diagnosticMessage = (diagnostics: Array<{ message: string }>, fallback: string) =>
  diagnostics.map((diagnostic) => diagnostic.message).join("; ") || fallback;

export const compileCustomAppQuery = async (params: {
  baseId: string;
  source: string;
  currentTableId?: string;
  context: DslQueryContextValues;
  allowedContextKeys?: readonly DslQueryContextKey[];
  client?: SqlClient;
}): Promise<CompileCustomAppQueryResult> => {
  const parsed = parseGridsQueryDsl(params.source);
  if (!parsed.ok) return { ok: false, error: diagnosticMessage(parsed.diagnostics, "invalid GQL source") };
  if (params.allowedContextKeys) {
    const allowed = new Set(params.allowedContextKeys);
    const forbidden = dslQueryContextKeys(parsed.ast).find((key) => !allowed.has(key));
    if (forbidden) return { ok: false, error: `Query context reference "@${forbidden}" is not available here` };
  }
  const bound = bindDslQueryContext(parsed.ast, params.context);
  if (!bound.ok) return { ok: false, error: bound.error };
  const canonicalBound = bindDslQueryContext(parsed.ast, canonicalCustomAppQueryContext(params.context));
  if (!canonicalBound.ok) return { ok: false, error: canonicalBound.error };

  const context = await buildTrustedGqlResolverContext({
    baseId: params.baseId,
    ...(params.currentTableId ? { currentTableId: params.currentTableId } : {}),
    ast: bound.ast,
    purpose: "custom-app-render",
    ...(params.client ? { client: params.client } : {}),
  });
  const resolved = resolveDslQueryToQueryPlan(bound.ast, context);
  if (!resolved.ok) return { ok: false, error: diagnosticMessage(resolved.diagnostics, "invalid GQL source") };
  if (containsDocumentMetadata(resolved.plan))
    return { ok: false, error: "Document metadata requires Base access and is not available in Custom App queries" };
  const canonicalResolved = resolveDslQueryToQueryPlan(canonicalBound.ast, context);
  if (!canonicalResolved.ok) return { ok: false, error: diagnosticMessage(canonicalResolved.diagnostics, "invalid GQL source") };

  const missingFieldTableIds = [
    ...new Set([...collectDslPlanExtraFieldTableIds(resolved.plan), ...collectDslPlanExtraFieldTableIds(canonicalResolved.plan)]),
  ].filter((tableId) => context.fieldsByTableId[tableId] === undefined);
  const missingFields = await Promise.all(
    missingFieldTableIds.map(async (tableId) => ({
      tableId,
      fields: await fields.listByTable(tableId, false, params.client),
    })),
  );

  const fieldsByTableId = {
    ...context.fieldsByTableId,
    ...Object.fromEntries(missingFields.map((group) => [group.tableId, group.fields])),
  };
  const availableTableIds = new Set(context.tables.map((table) => table.id));
  // A lookup can target another computed field. Load only the reachable
  // metadata to a fixed point so publication pins the complete read boundary.
  for (;;) {
    const targetTableIds = [
      ...new Set([
        ...collectDslPlanTableIds(canonicalResolved.plan, fieldsByTableId),
        ...customAppQueryPlanRelationTargetTableIds(canonicalResolved.plan, fieldsByTableId),
      ]),
    ].filter((tableId) => fieldsByTableId[tableId] === undefined);
    if (targetTableIds.length === 0) break;
    if (targetTableIds.some((tableId) => !availableTableIds.has(tableId)))
      return { ok: false, error: "A computed or relation dependency is outside the available query scope" };
    const targets = await fields.listByTables(targetTableIds, params.client);
    for (const tableId of targetTableIds) fieldsByTableId[tableId] = targets.get(tableId) ?? [];
  }

  return {
    ok: true,
    data: {
      plan: resolved.plan,
      planHash: customAppQueryPlanHash(canonicalResolved.plan, fieldsByTableId),
      fieldsByTableId,
      tableShortIds: Object.fromEntries(context.tables.map((table) => [table.id, table.shortId])),
    },
  };
};
