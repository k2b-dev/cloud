import { sql } from "bun";
import type { CapabilityOrigin } from "../contracts/capabilities";
import { logger } from "../services/logging";
import { CAPABILITY_CLAIM_RETENTION_HOURS, pruneCapabilityIdempotencyClaims } from "./claims";

export {
  CAPABILITY_CLAIM_MAX_BODY_BYTES,
  type CapabilityClaimOutcome,
  type CapabilityClaimScope,
  type CapabilityClaimState,
  capabilityIdempotencyKeyHash,
  capabilityRequestHash,
  claimCapabilityIdempotency,
  completeCapabilityClaim,
  markCapabilityClaimUncertain,
  releaseCapabilityClaim,
  resolveCapabilityClaim,
} from "./claims";
export { migrateCloudCapabilities } from "./migrate";
export { CAPABILITY_CLAIM_RETENTION_HOURS };

const log = logger("capabilities:executions");

export type CapabilityExecutionStatus = "succeeded" | "failed" | "denied" | "invalid_input" | "timed_out" | "rejected";

export type CapabilityValueMeta =
  | { type: "null" }
  | { type: "array"; length: number }
  | { type: "object"; keys: string[]; omittedKeys: number }
  | { type: "string"; length: number }
  | { type: "number"; value: number }
  | { type: "boolean"; value: boolean }
  | { type: "unknown" };

const META_KEY_LIMIT = 20;

/** Shape-only projection of one capability input or result. Never stores values of strings, arrays, or nested objects. */
export const capabilityValueMeta = (value: unknown): CapabilityValueMeta => {
  if (value === null) return { type: "null" };
  if (Array.isArray(value)) return { type: "array", length: value.length };
  if (typeof value === "string") return { type: "string", length: value.length };
  if (typeof value === "number") return { type: "number", value };
  if (typeof value === "boolean") return { type: "boolean", value };
  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>);
    return { type: "object", keys: keys.slice(0, META_KEY_LIMIT), omittedKeys: Math.max(0, keys.length - META_KEY_LIMIT) };
  }
  return { type: "unknown" };
};

export type CapabilityExecutionInput = {
  /** Correlation id shared with the invocation token, the app audit row, and request logs. */
  requestId: string;
  origin: CapabilityOrigin;
  appId: string;
  /** Fully qualified capability name, such as `contacts.list`. */
  capability: string;
  kind: "query" | "action";
  destructive: boolean;
  actorKind?: "user" | "service_account" | null;
  actorId?: string | null;
  userId?: string | null;
  /** Recorded only when the access subject differs from the acting principal. */
  accessSubject?: { type: "user" | "service_account"; id: string } | null;
  status: CapabilityExecutionStatus;
  errorCode?: string | null;
  inputMeta?: CapabilityValueMeta | null;
  outputMeta?: CapabilityValueMeta | null;
  idempotencyKey?: string | null;
  /** True when the dispatcher replayed a stored idempotent result instead of forwarding. */
  replayed?: boolean;
  startedAt: Date;
  completedAt: Date;
};

export type CapabilityExecution = {
  id: string;
  requestId: string;
  origin: CapabilityOrigin;
  appId: string;
  capability: string;
  kind: "query" | "action";
  destructive: boolean;
  actorKind: "user" | "service_account" | null;
  actorId: string | null;
  userId: string | null;
  accessSubjectType: "user" | "service_account" | null;
  accessSubjectId: string | null;
  status: CapabilityExecutionStatus;
  errorCode: string | null;
  inputMeta: CapabilityValueMeta | null;
  outputMeta: CapabilityValueMeta | null;
  idempotencyKey: string | null;
  replayed: boolean;
  startedAt: string;
  completedAt: string;
  durationMs: number;
};

/** Insert one execution record. Called only by the capability dispatcher and the surfaces that deny before it. */
export const recordCapabilityExecution = async (input: CapabilityExecutionInput): Promise<string> => {
  const durationMs = Math.max(0, Math.round(input.completedAt.getTime() - input.startedAt.getTime()));
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO capabilities.executions (
      request_id, origin, app_id, capability, kind, destructive,
      actor_kind, actor_id, user_id, access_subject_type, access_subject_id,
      status, error_code, input_meta, output_meta, idempotency_key, replayed,
      started_at, completed_at, duration_ms
    ) VALUES (
      ${input.requestId}, ${input.origin}, ${input.appId}, ${input.capability}, ${input.kind}, ${input.destructive},
      ${input.actorKind ?? null}, ${input.actorId ?? null}, ${input.userId ?? null},
      ${input.accessSubject?.type ?? null}, ${input.accessSubject?.id ?? null},
      ${input.status}, ${input.errorCode ?? null},
      ${input.inputMeta ? JSON.stringify(input.inputMeta) : null}::text::jsonb,
      ${input.outputMeta ? JSON.stringify(input.outputMeta) : null}::text::jsonb,
      ${input.idempotencyKey ?? null}, ${input.replayed ?? false}, ${input.startedAt}, ${input.completedAt}, ${durationMs}
    )
    RETURNING id::text AS id
  `;
  return row!.id;
};

export type CapabilityExecutionFilter = {
  appId?: string;
  capability?: string;
  origin?: CapabilityOrigin;
  status?: CapabilityExecutionStatus;
  userId?: string;
  destructive?: boolean;
  requestId?: string;
  since?: Date;
  until?: Date;
};

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

const filterSql = (filter: CapabilityExecutionFilter) => sql`
  (${filter.appId ?? null}::text IS NULL OR execution.app_id = ${filter.appId ?? null})
  AND (${filter.capability ?? null}::text IS NULL OR execution.capability = ${filter.capability ?? null})
  AND (${filter.origin ?? null}::text IS NULL OR execution.origin = ${filter.origin ?? null})
  AND (${filter.status ?? null}::text IS NULL OR execution.status = ${filter.status ?? null})
  AND (${filter.userId ?? null}::uuid IS NULL OR execution.user_id = ${filter.userId ?? null}::uuid)
  AND (${filter.requestId ?? null}::text IS NULL OR execution.request_id = ${filter.requestId ?? null})
  AND (${filter.destructive ?? null}::boolean IS NULL OR execution.destructive = ${filter.destructive ?? null})
  AND (${filter.since ?? null}::timestamptz IS NULL OR execution.started_at >= ${filter.since ?? null})
  AND (${filter.until ?? null}::timestamptz IS NULL OR execution.started_at <= ${filter.until ?? null})
`;

const columns = () => sql`
  execution.id::text AS id, execution.request_id AS "requestId", execution.origin, execution.app_id AS "appId",
  execution.capability, execution.kind, execution.destructive,
  execution.actor_kind AS "actorKind", execution.actor_id::text AS "actorId", execution.user_id::text AS "userId",
  execution.access_subject_type AS "accessSubjectType", execution.access_subject_id::text AS "accessSubjectId",
  execution.status, execution.error_code AS "errorCode", execution.input_meta AS "inputMeta",
  execution.output_meta AS "outputMeta", execution.idempotency_key AS "idempotencyKey", execution.replayed,
  to_json(execution.started_at) #>> '{}' AS "startedAt", to_json(execution.completed_at) #>> '{}' AS "completedAt",
  execution.duration_ms AS "durationMs"
`;

/** The driver returns jsonb as text; execution rows are a public contract, so parse once here. */
const meta = (value: unknown): CapabilityValueMeta | null =>
  typeof value === "string" ? (JSON.parse(value) as CapabilityValueMeta) : ((value as CapabilityValueMeta | null) ?? null);

const toExecution = (row: CapabilityExecution): CapabilityExecution => ({
  ...row,
  inputMeta: meta(row.inputMeta),
  outputMeta: meta(row.outputMeta),
});

const encodeCursor = (row: CapabilityExecution): string => `${row.startedAt}|${row.id}`;
const decodeCursor = (cursor: string): { startedAt: string; id: string } | null => {
  const separator = cursor.lastIndexOf("|");
  if (separator <= 0) return null;
  return { startedAt: cursor.slice(0, separator), id: cursor.slice(separator + 1) };
};

/** Newest first, keyset paginated on (started_at, id). The page size is always bounded. */
export const listCapabilityExecutions = async (
  input: CapabilityExecutionFilter & { limit?: number; cursor?: string } = {},
): Promise<{ items: CapabilityExecution[]; nextCursor?: string }> => {
  const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.trunc(input.limit ?? DEFAULT_PAGE_SIZE)));
  const cursor = input.cursor ? decodeCursor(input.cursor) : null;
  const rows = await sql<CapabilityExecution[]>`
    SELECT ${columns()}
    FROM capabilities.executions execution
    WHERE ${filterSql(input)}
      AND (${cursor?.startedAt ?? null}::timestamptz IS NULL
        OR (execution.started_at, execution.id) < (${cursor?.startedAt ?? null}::timestamptz, ${cursor?.id ?? null}::uuid))
    ORDER BY execution.started_at DESC, execution.id DESC
    LIMIT ${limit + 1}
  `;
  const items = rows.slice(0, limit).map(toExecution);
  const last = items.at(-1);
  return { items, ...(rows.length > limit && last ? { nextCursor: encodeCursor(last) } : {}) };
};

export type CapabilityExecutionGroup = { id: string; executions: number; failed: number; denied: number; destructive: number };
export type CapabilityExecutionSummary = {
  executions: number;
  failed: number;
  denied: number;
  destructive: number;
  avgDurationMs: number | null;
  p95DurationMs: number | null;
  apps: CapabilityExecutionGroup[];
  capabilities: CapabilityExecutionGroup[];
};

const MAX_SUMMARY_GROUPS = 50;

const groupCounts = () => sql`
  count(*)::int AS executions,
  count(*) FILTER (WHERE execution.status IN ('failed', 'timed_out', 'invalid_input'))::int AS failed,
  count(*) FILTER (WHERE execution.status IN ('denied', 'rejected'))::int AS denied,
  count(*) FILTER (WHERE execution.destructive)::int AS destructive
`;

/** Counts and latency for one time range. Group lists are bounded to the busiest entries. */
export const summarizeCapabilityExecutions = async (filter: CapabilityExecutionFilter = {}): Promise<CapabilityExecutionSummary> => {
  const scope = filterSql(filter);
  const [totals, apps, capabilities] = await Promise.all([
    sql<Omit<CapabilityExecutionSummary, "apps" | "capabilities">[]>`
      SELECT ${groupCounts()},
        avg(execution.duration_ms)::double precision AS "avgDurationMs",
        percentile_cont(0.95) WITHIN GROUP (ORDER BY execution.duration_ms)::double precision AS "p95DurationMs"
      FROM capabilities.executions execution WHERE ${scope}
    `,
    sql<CapabilityExecutionGroup[]>`
      SELECT execution.app_id AS id, ${groupCounts()}
      FROM capabilities.executions execution WHERE ${scope}
      GROUP BY execution.app_id ORDER BY executions DESC, id LIMIT ${MAX_SUMMARY_GROUPS}
    `,
    sql<CapabilityExecutionGroup[]>`
      SELECT execution.capability AS id, ${groupCounts()}
      FROM capabilities.executions execution WHERE ${scope}
      GROUP BY execution.capability ORDER BY executions DESC, id LIMIT ${MAX_SUMMARY_GROUPS}
    `,
  ]);
  const summary = totals[0]!;
  return { ...summary, apps, capabilities };
};

const PRUNE_BATCH_SIZE = 5_000;

/** Deletes expired rows in bounded batches so one call cannot hold a long transaction. */
export const pruneCapabilityExecutions = async (olderThan: Date): Promise<number> => {
  let total = 0;
  let deleted: number;
  do {
    const result = await sql`
      WITH expired AS (
        SELECT ctid FROM capabilities.executions WHERE started_at < ${olderThan} LIMIT ${PRUNE_BATCH_SIZE}
      )
      DELETE FROM capabilities.executions execution USING expired WHERE execution.ctid = expired.ctid
    `;
    deleted = result.count;
    total += deleted;
  } while (deleted === PRUNE_BATCH_SIZE);
  return total;
};

/**
 * Execution history is operational evidence, not durable app data. Ninety days
 * covers a quarterly review of what agents did without an unbounded table; there
 * is no operator setting for it yet, so the window is a platform constant.
 */
export const CAPABILITY_EXECUTION_RETENTION_DAYS = 90;
const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;

let pruneTimer: ReturnType<typeof setInterval> | null = null;
let pruneRunning = false;

/** Starts the retention sweep. Mirrors the mandate maintenance loop and is started once per Cloud runtime. */
export const startCapabilityExecutionMaintenance = (): (() => void) => {
  if (pruneTimer) return () => undefined;
  const prune = async (): Promise<void> => {
    if (pruneRunning) return;
    pruneRunning = true;
    try {
      const removed = await pruneCapabilityExecutions(new Date(Date.now() - CAPABILITY_EXECUTION_RETENTION_DAYS * 86_400_000));
      if (removed > 0) log.info("Pruned expired capability executions", { removed });
      const claims = await pruneCapabilityIdempotencyClaims(new Date(Date.now() - CAPABILITY_CLAIM_RETENTION_HOURS * 3_600_000));
      if (claims > 0) log.info("Pruned expired capability idempotency claims", { removed: claims });
    } catch (error) {
      log.error("Capability retention sweep failed", { error: error instanceof Error ? error.message : String(error) });
    } finally {
      pruneRunning = false;
    }
  };
  void prune();
  pruneTimer = setInterval(() => void prune(), PRUNE_INTERVAL_MS);
  pruneTimer.unref?.();
  return () => {
    if (pruneTimer) clearInterval(pruneTimer);
    pruneTimer = null;
  };
};
