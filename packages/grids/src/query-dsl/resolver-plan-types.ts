import type { GroupSortSpec, RecordQuery } from "../contracts";
import type { DslFormulaAggregation, DslFormulaHavingPredicate, DslResolvedSqlAggregation } from "./resolver-aggregates";
import type { DslTableSource, DslViewSource } from "./resolver-context";
import type { DslResolvedDerivedViewSource } from "./resolver-derived-source";
import type { DslPlanDiagnosticSpans, DslResolverDiagnostic } from "./resolver-diagnostics";
import type { DslResolvedSqlGroupBy, DslResolvedSqlGroupSort, DslResolvedSqlSort } from "./resolver-group-sort";
import type { DslResolvedRelationJoin } from "./resolver-joins";
import type { DslJoinedColumn, DslOutputColumn } from "./resolver-output";
import type { DslResolvedSqlSearch } from "./resolver-search";
import type { DslWherePredicate } from "./resolver-where";
import type { DslSummaryJoin } from "./resolver-summary-joins";

type DslResolvedQueryPlan = {
  source: DslTableSource | DslViewSource;
  tableId: string;
  sourceAlias?: string;
  query: RecordQuery;
  offset?: number;
};

export type DslResolvedSqlQueryPlan = DslResolvedQueryPlan & {
  readableTableIds: string[];
  viewSourceQuery?: RecordQuery;
  joins?: DslResolvedRelationJoin[];
  summaryJoins?: DslSummaryJoin[];
  outputColumns?: DslOutputColumn[];
  joinedColumns?: DslJoinedColumn[];
  sqlSort?: DslResolvedSqlSort[];
  sqlGroupBy?: DslResolvedSqlGroupBy[];
  sqlGroupSort?: DslResolvedSqlGroupSort[];
  sqlAggregations?: DslResolvedSqlAggregation[];
  sqlSearch?: DslResolvedSqlSearch[];
  derivedViewSource?: DslResolvedDerivedViewSource;
  formulaGroupSort?: GroupSortSpec[];
  formulaAggregations?: DslFormulaAggregation[];
  wherePredicate?: DslWherePredicate;
  formulaHaving?: DslFormulaHavingPredicate;
  diagnosticSpans?: DslPlanDiagnosticSpans;
};

export const isDslAggregateOnlyPlan = (plan: DslResolvedSqlQueryPlan): boolean => {
  const hasAggregations =
    (plan.query.aggregations?.length ?? 0) > 0 || (plan.sqlAggregations?.length ?? 0) > 0 || (plan.formulaAggregations?.length ?? 0) > 0;
  const hasRowProjection = (plan.query.columns?.length ?? 0) > 0 || (plan.joinedColumns?.length ?? 0) > 0;
  const hasGrouping = (plan.query.groupBy?.length ?? 0) > 0 || (plan.sqlGroupBy?.length ?? 0) > 0;
  return hasAggregations && !hasRowProjection && !hasGrouping;
};

export type DslRecordQueryResolveResult = { ok: true; plan: DslResolvedQueryPlan } | { ok: false; diagnostics: DslResolverDiagnostic[] };

export type DslQueryPlanResolveResult = { ok: true; plan: DslResolvedSqlQueryPlan } | { ok: false; diagnostics: DslResolverDiagnostic[] };
