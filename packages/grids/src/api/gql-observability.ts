import { type TraceAttributes, type TraceStatus, trace } from "@k2b/cloud/services";
import type { DslQueryPreviewBody, DslQueryPreviewResponse, DslQuerySurface } from "../contracts";
import type { DslResolvedSqlQueryPlan } from "../query-dsl/resolver";

type GqlTraceCurrentSource = DslQueryPreviewBody["currentSource"];

export type GqlRuntimeOperation = "execute" | "initial-preview" | "preview";
type GqlRuntimeOutcome = "diagnostic" | "error" | "success";
type GqlRuntimeStage = "execute" | "parse" | "resolve" | "runtime";

export type GqlRuntimeTraceStart = {
  baseId: string;
  operation: GqlRuntimeOperation;
  surface: NonNullable<DslQuerySurface>;
  currentTableId?: string;
  currentSource?: GqlTraceCurrentSource;
  limit?: number;
  maxRows?: number;
};

export type GqlRuntimeTraceEnd = {
  stage: GqlRuntimeStage;
  outcome: GqlRuntimeOutcome;
  plan?: DslResolvedSqlQueryPlan;
  response?: DslQueryPreviewResponse;
  error?: unknown;
  timings?: {
    parseMs?: number;
    contextMs?: number;
    resolveMs?: number;
    executeMs?: number;
    totalMs?: number;
  };
};

type GqlRuntimeTraceHandle = {
  end: (event: GqlRuntimeTraceEnd) => Promise<void>;
};

export type GqlRuntimeTracer = (event: GqlRuntimeTraceStart) => Promise<GqlRuntimeTraceHandle>;

const GQL_TRACE_SOURCE = "grids:gql";
const GQL_TRACE_APP_ID = "grids";

const diagnosticClass = (event: GqlRuntimeTraceEnd): string | undefined => {
  if (event.outcome === "success") return undefined;
  if (event.stage === "execute" && event.response?.ok === false) {
    const text = event.response.diagnostics
      .map((diagnostic) => diagnostic.message)
      .join(" ")
      .toLowerCase();
    if (text.includes("took too long") || text.includes("statement timeout")) return "timeout";
    return "compiler";
  }
  if (event.stage === "runtime") return "exception";
  return event.stage;
};

const errorMessage = (error: unknown): string | undefined => {
  if (!error) return undefined;
  return error instanceof Error ? error.message : String(error);
};

const responseMetrics = (response: DslQueryPreviewResponse | undefined): TraceAttributes => {
  if (!response) return {};
  if (!response.ok) {
    return {
      "gql.diagnostic.count": response.diagnostics.length,
    };
  }
  return {
    "gql.result.columns": response.columns.length,
    "gql.result.explode": response.explode ?? false,
    "gql.result.mode": response.mode,
    "gql.result.rows": response.rows.length,
    "gql.result.truncated": response.truncated ?? false,
  };
};

const sourceAttributes = (
  start: Pick<GqlRuntimeTraceStart, "currentSource" | "currentTableId">,
  plan: DslResolvedSqlQueryPlan | undefined,
): TraceAttributes => ({
  "gql.current_source.kind": start.currentSource?.kind,
  "gql.current_source.table_id": start.currentSource?.kind === "table" ? start.currentSource.tableId : undefined,
  "gql.current_source.view_id": start.currentSource?.kind === "view" ? start.currentSource.viewId : undefined,
  "gql.current_table_id": start.currentTableId,
  "gql.source.kind": plan?.source.kind,
  "gql.source.table_id": plan?.source.kind === "table" ? plan.source.id : plan?.source.tableId,
  "gql.source.view_id": plan?.source.kind === "view" ? plan.source.id : undefined,
  "gql.table_id": plan?.tableId,
});

export const gqlRuntimeTraceAttributes = (start: GqlRuntimeTraceStart, event?: GqlRuntimeTraceEnd): TraceAttributes => ({
  "gql.base_id": start.baseId,
  "gql.limit": start.limit,
  "gql.max_rows": start.maxRows,
  "gql.operation": start.operation,
  "gql.surface": start.surface,
  ...(event
    ? {
        "gql.diagnostic.class": diagnosticClass(event),
        "gql.outcome": event.outcome,
        "gql.stage": event.stage,
        "gql.timing.context_ms": event.timings?.contextMs,
        "gql.timing.execute_ms": event.timings?.executeMs,
        "gql.timing.parse_ms": event.timings?.parseMs,
        "gql.timing.resolve_ms": event.timings?.resolveMs,
        "gql.timing.total_ms": event.timings?.totalMs,
        ...sourceAttributes(start, event.plan),
        ...responseMetrics(event.response),
      }
    : sourceAttributes(start, undefined)),
});

export const gqlRuntimeTraceSummary = (start: GqlRuntimeTraceStart, event: GqlRuntimeTraceEnd): Record<string, unknown> => ({
  baseId: start.baseId,
  operation: start.operation,
  outcome: event.outcome,
  stage: event.stage,
  surface: start.surface,
  ...(diagnosticClass(event) ? { diagnosticClass: diagnosticClass(event) } : {}),
  ...(event.plan
    ? {
        sourceKind: event.plan.source.kind,
        sourceTableId: event.plan.source.kind === "table" ? event.plan.source.id : event.plan.source.tableId,
        sourceViewId: event.plan.source.kind === "view" ? event.plan.source.id : null,
        tableId: event.plan.tableId,
      }
    : {}),
  ...(event.response?.ok
    ? {
        columns: event.response.columns.length,
        rows: event.response.rows.length,
        truncated: event.response.truncated ?? false,
      }
    : {}),
  ...(!event.response?.ok && event.response ? { diagnostics: event.response.diagnostics.length } : {}),
  ...(event.timings ? { timings: event.timings } : {}),
});

const traceStatus = (outcome: GqlRuntimeOutcome): TraceStatus => (outcome === "success" ? "ok" : "error");

export const traceGqlRuntime: GqlRuntimeTracer = async (start) => {
  const startedAt = new Date();

  return {
    end: async (event) => {
      const status = traceStatus(event.outcome);
      const statusMessage = event.outcome === "success" ? undefined : (errorMessage(event.error) ?? diagnosticClass(event));
      await trace.complete({
        name: `GQL ${start.operation}`,
        source: GQL_TRACE_SOURCE,
        appId: GQL_TRACE_APP_ID,
        category: "custom",
        kind: "server",
        startedAt,
        endedAt: new Date(),
        status,
        statusMessage,
        attributes: gqlRuntimeTraceAttributes(start, event),
        summary: gqlRuntimeTraceSummary(start, event),
      });
    },
  };
};
