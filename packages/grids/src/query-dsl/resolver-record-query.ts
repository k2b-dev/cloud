import type { RecordQuery } from "../contracts";
import type { Expr } from "../formula/types";
import type { DslResolverContext } from "./resolver-context";
import { type DslResolverDiagnostic, diagnostic } from "./resolver-diagnostics";
import type { DslRecordQueryResolveResult, DslResolvedSqlQueryPlan } from "./resolver-plan-types";
import { resolveDslQueryToQueryPlan } from "./resolver-query-plan";
import { isScopedFormulaFieldRef } from "./scoped-formula";
import type { DslQueryAst } from "./types";

const exprHasScopedFieldRef = (expr: Expr): boolean => {
  switch (expr.kind) {
    case "field":
      return isScopedFormulaFieldRef(expr.fieldId);
    case "binop":
      return exprHasScopedFieldRef(expr.left) || exprHasScopedFieldRef(expr.right);
    case "unop":
      return exprHasScopedFieldRef(expr.operand);
    case "call":
      return expr.args.some(exprHasScopedFieldRef);
    default:
      return false;
  }
};

const sourceBlocker = (plan: DslResolvedSqlQueryPlan, ast: DslQueryAst): DslResolverDiagnostic | null => {
  if (plan.derivedViewSource)
    return diagnostic("derived view source queries cannot be represented by the records-table runtime yet", ast.source?.span);
  if (plan.viewSourceQuery)
    return diagnostic("view sources with limit/scope semantics cannot be represented by the records-table runtime yet", ast.source?.span);
  return null;
};

const predicateBlocker = (plan: DslResolvedSqlQueryPlan, ast: DslQueryAst): DslResolverDiagnostic | null => {
  if (plan.wherePredicate) {
    return diagnostic(
      "this where clause uses a formula, NOT, or cross-field comparison and cannot be represented as a RecordQuery filter yet",
      ast.where?.span,
    );
  }
  if (plan.formulaHaving) return diagnostic("having cannot be represented by the records-table runtime yet", ast.having?.span);
  return null;
};

const joinBlocker = (plan: DslResolvedSqlQueryPlan, ast: DslQueryAst): DslResolverDiagnostic | null =>
  (plan.joins?.length ?? 0) > 0
    ? diagnostic("queries with relation joins cannot be represented by the records-table runtime yet", ast.joins[0]?.span)
    : null;

const groupingBlocker = (plan: DslResolvedSqlQueryPlan, ast: DslQueryAst): DslResolverDiagnostic | null => {
  if ((plan.formulaAggregations?.length ?? 0) > 0)
    return diagnostic("formula aggregates cannot be represented by the records-table runtime yet", ast.aggregations[0]?.span);
  if ((plan.sqlGroupBy?.length ?? 0) > 0 && (plan.query.groupBy?.length ?? 0) !== plan.sqlGroupBy?.length) {
    return diagnostic("group by computed fields cannot be represented by the records-table runtime yet", ast.groupBy[0]?.span);
  }
  if ((plan.offset ?? 0) > 0) return diagnostic("offset cannot be represented by the records-table runtime yet");
  if (ast.aggregations.length > 0 && (plan.query.groupBy?.length ?? 0) === 0) {
    return diagnostic(
      "aggregate-only queries cannot be represented by the records-table runtime yet; add group by or use preview",
      ast.aggregations[0]?.span,
    );
  }
  return null;
};

const projectionBlocker = (plan: DslResolvedSqlQueryPlan, ast: DslQueryAst): DslResolverDiagnostic | null => {
  const scopedFormulaSelect = ast.select.find((item) => item.kind === "formula" && exprHasScopedFieldRef(item.expression));
  if (scopedFormulaSelect) {
    return diagnostic(
      "computed formulas with scoped field refs cannot be represented by the records-table runtime yet",
      scopedFormulaSelect.span,
    );
  }
  return null;
};

const sortBlocker = (plan: DslResolvedSqlQueryPlan, ast: DslQueryAst): DslResolverDiagnostic | null => {
  const computedSort = (plan.sqlSort ?? []).find((sort) => sort.kind === "computed");
  if (computedSort?.kind === "computed") {
    return diagnostic(`sort by computed alias "${computedSort.alias}" is not supported by RecordQuery yet`, ast.sort[0]?.span);
  }
  if ((plan.sqlSort ?? []).some((sort) => sort.kind === "joined" || sort.kind === "joinedField")) {
    return diagnostic("sort by a joined field is not supported by RecordQuery yet", ast.sort[0]?.span);
  }
  return null;
};

/** Why a successfully-previewable plan can't yet be represented by the
 *  records-table runtime. Returns null when a RecordQuery can carry it. */
const recordQueryBlocker = (plan: DslResolvedSqlQueryPlan, ast: DslQueryAst): DslResolverDiagnostic | null =>
  sourceBlocker(plan, ast) ??
  predicateBlocker(plan, ast) ??
  joinBlocker(plan, ast) ??
  groupingBlocker(plan, ast) ??
  projectionBlocker(plan, ast) ??
  sortBlocker(plan, ast);

const withoutColumns = (query: RecordQuery): RecordQuery => {
  const { columns: _columns, ...rest } = query;
  return rest;
};

/** Projects an already resolved plan into the visual record controls only when
 * they can carry it without losing joins, predicates, grouping or offsets. */
export const projectDslPlanToRecordQuery = (plan: DslResolvedSqlQueryPlan, ast: DslQueryAst): DslRecordQueryResolveResult => {
  const blocker = recordQueryBlocker(plan, ast);
  if (blocker) return { ok: false, diagnostics: [blocker] };

  // Without an explicit output shape, saved views must continue following the
  // table's live columns instead of persisting the preview's expanded defaults.
  const autoColumns = ast.select.length === 0 && ast.groupBy.length === 0 && ast.aggregations.length === 0 && !ast.having;
  const query = autoColumns ? withoutColumns(plan.query) : plan.query;

  return {
    ok: true,
    plan: {
      source: plan.source,
      tableId: plan.tableId,
      query,
    },
  };
};

export const resolveDslQueryToRecordQuery = (ast: DslQueryAst, ctx: DslResolverContext): DslRecordQueryResolveResult => {
  const resolved = resolveDslQueryToQueryPlan(ast, ctx);
  return resolved.ok ? projectDslPlanToRecordQuery(resolved.plan, ast) : resolved;
};
