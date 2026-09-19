import type { SqlClient } from "../service/audit";
import { buildComputedFieldSqlMap } from "../service/computed-projections";
import type { Field } from "../service/types";
import { dslQueryCalculationFieldIds } from "./plan-dependencies";
import type { DslResolvedSqlQueryPlan } from "./resolver";
import { dslDerivedJoinRecordAlias, dslJoinRecordAlias } from "./sql-compiler";
import type { DslSqlRecordSource } from "./sql-compiler-types";
import { buildFederatedFieldSqlMap } from "./sql-record-source";

/** Prepare typed calculation expressions without executing the query. Both
 * publication metadata and preview use the same calculation dependencies. */
export const buildDslComputedSqlInputs = async (
  plan: DslResolvedSqlQueryPlan,
  options: {
    fieldsByTableId: Record<string, Field[]>;
    recordSourcesByTableId?: ReadonlyMap<string, DslSqlRecordSource>;
    timeZone?: string;
    client?: SqlClient;
    authorizedTableIds?: ReadonlySet<string>;
  },
) => {
  const recordSourcesByTableId = options.recordSourcesByTableId ?? new Map<string, DslSqlRecordSource>();
  const recordSource = recordSourcesByTableId.get(plan.tableId);
  const computedDateConfig = options.timeZone ? { timeZone: options.timeZone } : undefined;
  const calculationFieldIds = dslQueryCalculationFieldIds(plan, options.fieldsByTableId);
  const computedFieldSql = await buildComputedFieldSqlMap(options.fieldsByTableId[plan.tableId] ?? [], {
    sourceFieldSql: buildFederatedFieldSqlMap(recordSource, options.fieldsByTableId[plan.tableId] ?? []),
    fieldIds: calculationFieldIds,
    fieldsByTableId: options.fieldsByTableId,
    requireCapturedValues: true,
    useFinalizedFormulaValues: recordSource?.kind !== "federated",
    useStoredLocalValues: recordSource?.kind !== "federated",
    finalizedOnly:
      !plan.derivedViewSource &&
      plan.query.recordMeta?.finalizationStates?.length === 1 &&
      plan.query.recordMeta.finalizationStates[0] === "finalized",
    dateConfig: computedDateConfig,
    client: options.client,
    authorizedTableIds: options.authorizedTableIds,
  });
  const computedFieldSqlByJoinAlias = new Map<string, Awaited<ReturnType<typeof buildComputedFieldSqlMap>>>();
  for (const join of plan.summaryJoins ?? []) {
    const map = await buildComputedFieldSqlMap(options.fieldsByTableId[join.tableId] ?? [], {
      sourceFieldSql: buildFederatedFieldSqlMap(recordSourcesByTableId.get(join.tableId), options.fieldsByTableId[join.tableId] ?? [], "r"),
      fieldIds: calculationFieldIds,
      fieldsByTableId: options.fieldsByTableId,
      requireCapturedValues: true,
      useFinalizedFormulaValues: true,
      useStoredLocalValues: recordSourcesByTableId.get(join.tableId)?.kind !== "federated",
      finalizedOnly:
        join.source.query.recordMeta?.finalizationStates?.length === 1 &&
        join.source.query.recordMeta.finalizationStates[0] === "finalized",
      dateConfig: computedDateConfig,
      client: options.client,
      authorizedTableIds: options.authorizedTableIds,
    });
    computedFieldSqlByJoinAlias.set(join.alias, map);
  }
  for (const [index, join] of (plan.joins ?? []).entries()) {
    const map = await buildComputedFieldSqlMap(options.fieldsByTableId[join.tableId] ?? [], {
      sourceFieldSql: buildFederatedFieldSqlMap(
        recordSourcesByTableId.get(join.tableId),
        options.fieldsByTableId[join.tableId] ?? [],
        dslJoinRecordAlias(index),
      ),
      fieldIds: calculationFieldIds,
      fieldsByTableId: options.fieldsByTableId,
      requireCapturedValues: true,
      useFinalizedFormulaValues: recordSourcesByTableId.get(join.tableId)?.kind !== "federated",
      useStoredLocalValues: recordSourcesByTableId.get(join.tableId)?.kind !== "federated",
      dateConfig: computedDateConfig,
      client: options.client,
      recordAlias: dslJoinRecordAlias(index),
      authorizedTableIds: options.authorizedTableIds,
    });
    if (map.size > 0) computedFieldSqlByJoinAlias.set(join.alias, map);
  }
  for (const [index, join] of (plan.derivedViewSource?.joins ?? []).entries()) {
    const map = await buildComputedFieldSqlMap(options.fieldsByTableId[join.tableId] ?? [], {
      sourceFieldSql: buildFederatedFieldSqlMap(
        recordSourcesByTableId.get(join.tableId),
        options.fieldsByTableId[join.tableId] ?? [],
        dslDerivedJoinRecordAlias(index),
      ),
      fieldIds: calculationFieldIds,
      fieldsByTableId: options.fieldsByTableId,
      requireCapturedValues: true,
      useFinalizedFormulaValues: recordSourcesByTableId.get(join.tableId)?.kind !== "federated",
      useStoredLocalValues: recordSourcesByTableId.get(join.tableId)?.kind !== "federated",
      dateConfig: computedDateConfig,
      client: options.client,
      recordAlias: dslDerivedJoinRecordAlias(index),
      authorizedTableIds: options.authorizedTableIds,
    });
    if (map.size > 0) computedFieldSqlByJoinAlias.set(join.alias, map);
  }
  for (const [index, join] of (plan.derivedViewSource?.relationJoins ?? []).entries()) {
    const map = await buildComputedFieldSqlMap(options.fieldsByTableId[join.tableId] ?? [], {
      sourceFieldSql: buildFederatedFieldSqlMap(
        recordSourcesByTableId.get(join.tableId),
        options.fieldsByTableId[join.tableId] ?? [],
        dslJoinRecordAlias(index),
      ),
      fieldIds: calculationFieldIds,
      fieldsByTableId: options.fieldsByTableId,
      requireCapturedValues: true,
      useFinalizedFormulaValues: recordSourcesByTableId.get(join.tableId)?.kind !== "federated",
      useStoredLocalValues: recordSourcesByTableId.get(join.tableId)?.kind !== "federated",
      dateConfig: computedDateConfig,
      client: options.client,
      recordAlias: dslJoinRecordAlias(index),
      authorizedTableIds: options.authorizedTableIds,
    });
    if (map.size > 0) computedFieldSqlByJoinAlias.set(join.alias, map);
  }
  return { computedFieldSql, computedFieldSqlByJoinAlias };
};
