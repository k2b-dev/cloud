import { sql } from "bun";

type GridsOperationalStatus = "error" | "ok" | "warn";

type GridsOperationalIssue = {
  detail: string;
  severity: Exclude<GridsOperationalStatus, "ok">;
  title: string;
};

export type GridsOperationalHealth = {
  status: GridsOperationalStatus;
  observedAt: string;
  outbox: { pending: number; failed: number; dead: number; oldestActiveAgeSeconds: number };
  workflows: {
    queued: number;
    running: number;
    waiting: number;
    needsAttention: number;
    staleRunning: number;
    oldestQueuedAgeSeconds: number;
  };
  effects: { executing: number; needsAttention: number; oldestActiveAgeSeconds: number };
  federatedDegraded: number;
  emailFailed24h: number;
  gql: { total24h: number; errors24h: number; avgDurationMs24h: number; p99DurationMs24h: number };
  issues: GridsOperationalIssue[];
};

type OperationalHealthRow = {
  status: GridsOperationalStatus;
  outbox_pending: number | string;
  outbox_failed: number | string;
  outbox_dead: number | string;
  outbox_oldest_active_age_seconds: number | string;
  workflow_queued: number | string;
  workflow_running: number | string;
  workflow_waiting: number | string;
  workflow_needs_attention: number | string;
  workflow_stale_running: number | string;
  workflow_oldest_queued_age_seconds: number | string;
  effects_executing: number | string;
  effects_needs_attention: number | string;
  effects_oldest_active_age_seconds: number | string;
  federated_degraded: number | string;
  email_failed_24h: number | string;
  observed_at: Date | string;
};

type GqlHealthRow = {
  total_24h: number | string;
  errors_24h: number | string;
  avg_duration_ms_24h: number | string;
  p99_duration_ms_24h: number | string;
};

const number = (value: number | string): number => Number(value) || 0;
const plural = (count: number, one: string, many = `${one}s`): string => `${count} ${count === 1 ? one : many}`;

export const operationalIssues = (health: Omit<GridsOperationalHealth, "issues">): GridsOperationalIssue[] => {
  const issues: GridsOperationalIssue[] = [];
  if (health.outbox.dead > 0) {
    issues.push({
      severity: "error",
      title: "Record events need intervention",
      detail: `${plural(health.outbox.dead, "event")} reached the dead-letter state.`,
    });
  }
  if (health.workflows.needsAttention > 0 || health.effects.needsAttention > 0) {
    const total = health.workflows.needsAttention + health.effects.needsAttention;
    issues.push({
      severity: "error",
      title: "Workflow effects need review",
      detail: `${plural(total, "run or effect")} has an uncertain external outcome.`,
    });
  }
  if (health.workflows.staleRunning > 0) {
    issues.push({
      severity: "error",
      title: "Workflow leases expired",
      detail: `${plural(health.workflows.staleRunning, "run")} is still marked running after its lease expired.`,
    });
  }
  if (health.outbox.failed > 0 || health.outbox.oldestActiveAgeSeconds > 60) {
    issues.push({
      severity: "warn",
      title: "Record events are delayed",
      detail: `${plural(health.outbox.pending + health.outbox.failed, "event")} is pending or retrying; oldest age is ${Math.round(health.outbox.oldestActiveAgeSeconds)}s.`,
    });
  }
  if (health.workflows.oldestQueuedAgeSeconds > 60) {
    issues.push({
      severity: "warn",
      title: "Workflow queue is delayed",
      detail: `The oldest queued run has waited ${Math.round(health.workflows.oldestQueuedAgeSeconds)}s.`,
    });
  }
  if (health.effects.oldestActiveAgeSeconds > 300) {
    issues.push({
      severity: "warn",
      title: "Workflow effects are delayed",
      detail: `The oldest active effect is ${Math.round(health.effects.oldestActiveAgeSeconds)}s old.`,
    });
  }
  if (health.federatedDegraded > 0) {
    issues.push({
      severity: "warn",
      title: "Combined tables are degraded",
      detail: `${plural(health.federatedDegraded, "combined table")} cannot currently read every configured source.`,
    });
  }
  if (health.emailFailed24h > 0) {
    issues.push({
      severity: "warn",
      title: "Workflow email delivery failed",
      detail: `${plural(health.emailFailed24h, "delivery", "deliveries")} failed in the last 24 hours.`,
    });
  }
  return issues;
};

const mapOperationalHealth = (row: OperationalHealthRow, gqlRow?: GqlHealthRow): GridsOperationalHealth => {
  const health = {
    status: row.status,
    observedAt: new Date(row.observed_at).toISOString(),
    outbox: {
      pending: number(row.outbox_pending),
      failed: number(row.outbox_failed),
      dead: number(row.outbox_dead),
      oldestActiveAgeSeconds: number(row.outbox_oldest_active_age_seconds),
    },
    workflows: {
      queued: number(row.workflow_queued),
      running: number(row.workflow_running),
      waiting: number(row.workflow_waiting),
      needsAttention: number(row.workflow_needs_attention),
      staleRunning: number(row.workflow_stale_running),
      oldestQueuedAgeSeconds: number(row.workflow_oldest_queued_age_seconds),
    },
    effects: {
      executing: number(row.effects_executing),
      needsAttention: number(row.effects_needs_attention),
      oldestActiveAgeSeconds: number(row.effects_oldest_active_age_seconds),
    },
    federatedDegraded: number(row.federated_degraded),
    emailFailed24h: number(row.email_failed_24h),
    gql: {
      total24h: number(gqlRow?.total_24h ?? 0),
      errors24h: number(gqlRow?.errors_24h ?? 0),
      avgDurationMs24h: number(gqlRow?.avg_duration_ms_24h ?? 0),
      p99DurationMs24h: number(gqlRow?.p99_duration_ms_24h ?? 0),
    },
  } satisfies Omit<GridsOperationalHealth, "issues">;
  return { ...health, issues: operationalIssues(health) };
};

export const getOperationalHealth = async (): Promise<GridsOperationalHealth> => {
  const [[row], [gqlRow]] = await Promise.all([
    sql<OperationalHealthRow[]>`SELECT * FROM grids.operational_health`,
    sql<GqlHealthRow[]>`
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
  if (!row) throw new Error("Grids operational health view returned no row");
  return mapOperationalHealth(row, gqlRow);
};
