import { sql } from "@k2b/cloud";

export type OperationalStatus = "ok" | "warn" | "error";

export type GridsOperationalSnapshot = {
  status: OperationalStatus;
  outboxPending: number;
  outboxFailed: number;
  outboxDead: number;
  outboxOldestActiveAgeSeconds: number;
  workflowQueued: number;
  workflowRunning: number;
  workflowWaiting: number;
  workflowNeedsAttention: number;
  workflowStaleRunning: number;
  workflowOldestQueuedAgeSeconds: number;
  effectsExecuting: number;
  effectsNeedsAttention: number;
  effectsOldestActiveAgeSeconds: number;
  federatedDegraded: number;
  emailFailed24h: number;
  gqlTotal24h: number;
  gqlErrors24h: number;
  gqlAvgDurationMs24h: number;
  gqlP99DurationMs24h: number;
};

export type AppSloWindow = {
  window: "1h" | "6h" | "30d";
  requestCount: number;
  errorCount: number;
  slowCount: number;
  availabilityRatio: number;
  fastRequestRatio: number;
  observedSeconds: number;
};

const number = (value: unknown): number => Number(value) || 0;

export const getGridsOperationalSnapshot = async (): Promise<GridsOperationalSnapshot | null> => {
  const [exists] = await sql<Array<{ view_exists: boolean }>>`
    SELECT to_regclass('grids.operational_health') IS NOT NULL AS view_exists
  `;
  if (!exists?.view_exists) return null;
  const [[row], [gql]] = await Promise.all([
    sql<Array<Record<string, unknown>>>`SELECT * FROM grids.operational_health`,
    sql<Array<Record<string, unknown>>>`
      SELECT
        count(*)::int AS total_24h,
        count(*) FILTER (WHERE status = 'error')::int AS errors_24h,
        COALESCE(avg(duration_ms) FILTER (WHERE duration_ms IS NOT NULL), 0)::float AS avg_duration_ms_24h,
        COALESCE(percentile_cont(0.99) WITHIN GROUP (ORDER BY duration_ms)
          FILTER (WHERE duration_ms IS NOT NULL), 0)::float AS p99_duration_ms_24h
      FROM logging.trace_spans
      WHERE source = 'grids:gql'
        AND started_at >= now() - interval '24 hours'
    `,
  ]);
  if (!row) return null;
  return {
    status: row.status === "error" || row.status === "warn" ? row.status : "ok",
    outboxPending: number(row.outbox_pending),
    outboxFailed: number(row.outbox_failed),
    outboxDead: number(row.outbox_dead),
    outboxOldestActiveAgeSeconds: number(row.outbox_oldest_active_age_seconds),
    workflowQueued: number(row.workflow_queued),
    workflowRunning: number(row.workflow_running),
    workflowWaiting: number(row.workflow_waiting),
    workflowNeedsAttention: number(row.workflow_needs_attention),
    workflowStaleRunning: number(row.workflow_stale_running),
    workflowOldestQueuedAgeSeconds: number(row.workflow_oldest_queued_age_seconds),
    effectsExecuting: number(row.effects_executing),
    effectsNeedsAttention: number(row.effects_needs_attention),
    effectsOldestActiveAgeSeconds: number(row.effects_oldest_active_age_seconds),
    federatedDegraded: number(row.federated_degraded),
    emailFailed24h: number(row.email_failed_24h),
    gqlTotal24h: number(gql?.total_24h),
    gqlErrors24h: number(gql?.errors_24h),
    gqlAvgDurationMs24h: number(gql?.avg_duration_ms_24h),
    gqlP99DurationMs24h: number(gql?.p99_duration_ms_24h),
  };
};

export const listAppSloWindows = async (appId: string): Promise<AppSloWindow[]> => {
  const rows = await sql<Array<Record<string, unknown>>>`
    SELECT window_name, request_count, error_count, slow_count, availability_ratio, fast_request_ratio, observed_seconds
    FROM gateway.app_request_slo_windows
    WHERE app_id = ${appId}
  `;
  return rows.map((row) => ({
    window: row.window_name === "1h" || row.window_name === "6h" ? row.window_name : "30d",
    requestCount: number(row.request_count),
    errorCount: number(row.error_count),
    slowCount: number(row.slow_count),
    availabilityRatio: number(row.availability_ratio),
    fastRequestRatio: number(row.fast_request_ratio),
    observedSeconds: number(row.observed_seconds),
  }));
};

export const gridsSloStatus = (windows: readonly AppSloWindow[]): OperationalStatus => {
  const oneHour = windows.find((window) => window.window === "1h");
  if (oneHour && oneHour.requestCount >= 50 && 1 - oneHour.availabilityRatio > 0.0144) return "error";
  const sixHours = windows.find((window) => window.window === "6h");
  if (sixHours && sixHours.requestCount >= 200 && 1 - sixHours.availabilityRatio > 0.006) return "warn";
  return "ok";
};
