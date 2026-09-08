import { createHash, randomBytes } from "node:crypto";
import type { SyncEvent } from "@k2b/sync";
import { sql } from "bun";
import type { PaginationParams } from "../../contracts/shared";
import { escapeLikePattern, parsePgJsonRecord, toPgTextArray } from "../postgres";
import { isSensitiveMetadataKey, REDACTED, redactMetadata } from "./redaction";

export type TraceAttributeValue = string | number | boolean | null | undefined;
export type TraceAttributes = Record<string, TraceAttributeValue>;
export type TraceCategory = "job" | "schedule" | "backfill" | "ai" | "http" | "notification" | "sync" | "custom";
export type TraceSeverity = "debug" | "info" | "warn" | "error";
export type TraceSpanKind = "internal" | "server" | "client" | "producer" | "consumer";
export type TraceStatus = "unset" | "ok" | "error";

export type TraceContext = {
  traceId: string;
  spanId: string;
  traceparent: string;
};

export type TraceSpan = TraceContext & {
  spanKey: string | null;
  parentSpanId: string | null;
  name: string;
  source: string;
  appId: string | null;
  category: TraceCategory;
  kind: TraceSpanKind;
  status: TraceStatus;
  statusMessage: string | null;
  attributes: Record<string, unknown> | null;
  summary: Record<string, unknown> | null;
  eventCount: number;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  updatedAt: string;
};

export type TraceEvent = {
  id: string;
  traceId: string;
  spanId: string;
  name: string;
  severity: TraceSeverity;
  attributes: Record<string, unknown> | null;
  body: string | null;
  occurredAt: string;
};

export type TraceSummary = {
  total: number;
  totalWindow: number;
  running: number;
  succeededWindow: number;
  failedWindow: number;
  sources: number;
  avgDurationMs: number | null;
  p95DurationMs: number | null;
};

export type TraceWindow = "10m" | "1h" | "12h" | "24h" | "7d" | "30d";

/**
 * A span open longer than this is treated as abandoned rather than running,
 * and a span that *closed* after longer than this is treated as anomalous
 * rather than slow.
 *
 * Both cases are real: a process that dies mid-run leaves an open span
 * forever, and a sweep that closes such spans later produces "runs" of
 * several days. Counting either as normal makes "running" report activity
 * that is not happening and drags duration percentiles far off the real
 * distribution, so both are separated out instead of silently averaged in.
 */
export const TRACE_STUCK_AFTER_MS = 60 * 60 * 1000;

export type TraceRunStats = {
  runs: number;
  sources: number;
  /** Open and started recently — genuinely in flight. */
  running: number;
  /** Open past the abandonment threshold — nothing is working on these. */
  stuck: number;
  /** Closed, but with a duration past the threshold; excluded from percentiles. */
  anomalous: number;
  succeeded: number;
  failed: number;
  errorRate: number;
  avgDurationMs: number | null;
  p95DurationMs: number | null;
  p99DurationMs: number | null;
};

export type TraceSourceGroup = {
  source: string;
  appId: string | null;
  categories: TraceCategory[];
  names: string[];
  runs: number;
  jobRuns: number;
  scheduleRuns: number;
  aiRuns: number;
  customRuns: number;
  running: number;
  stuck: number;
  anomalous: number;
  succeeded: number;
  failed: number;
  errorRate: number;
  avgDurationMs: number | null;
  p95DurationMs: number | null;
  p99DurationMs: number | null;
  latestName: string | null;
  latestCategory: TraceCategory | null;
  latestStatus: TraceStatus | null;
  latestStartedAt: string | null;
  latestEndedAt: string | null;
  latestDurationMs: number | null;
};

export type TraceListFilter = {
  appId?: string;
  source?: string;
  sources?: string[];
  status?: TraceStatus;
  active?: boolean;
  category?: TraceCategory;
  attributeEquals?: TraceAttributes;
  search?: string;
  sinceHours?: number;
  sinceSeconds?: number;
  window?: TraceWindow;
  minDurationMs?: number;
};

export type TraceStartParams = {
  name: string;
  source: string;
  spanKey?: string;
  parent?: TraceContext;
  appId?: string;
  category?: TraceCategory;
  kind?: TraceSpanKind;
  attributes?: TraceAttributes | Record<string, unknown>;
  startedAt?: Date | number | string;
};

export type TraceRecordParams = {
  context?: TraceContext;
  spanKey?: string;
  name?: string;
  source?: string;
  appId?: string;
  category?: TraceCategory;
  kind?: TraceSpanKind;
  event: string;
  severity?: TraceSeverity;
  attributes?: TraceAttributes | Record<string, unknown>;
  body?: string;
  status?: TraceStatus;
  statusMessage?: string;
  summary?: Record<string, unknown>;
  occurredAt?: Date | number | string;
};

export type TraceEndParams = {
  context?: TraceContext;
  spanKey?: string;
  status?: TraceStatus;
  statusMessage?: string;
  summary?: Record<string, unknown>;
  endedAt?: Date | number | string;
};

export type TraceCompleteParams = TraceStartParams & {
  status?: TraceStatus;
  statusMessage?: string;
  summary?: Record<string, unknown>;
  endedAt?: Date | number | string;
};

export type TraceWithSpanOptions<T> = {
  summarize?: (result: T) => Record<string, unknown> | undefined;
  onError?: (error: unknown) => Record<string, unknown> | undefined;
};

type DbTraceSpanRow = {
  trace_id: string;
  span_id: string;
  span_key: string | null;
  parent_span_id: string | null;
  name: string;
  source: string;
  app_id: string | null;
  category: TraceCategory;
  kind: TraceSpanKind;
  status: TraceStatus;
  status_message: string | null;
  attributes: Record<string, unknown> | string | null;
  summary: Record<string, unknown> | string | null;
  event_count?: number;
  started_at: Date | string;
  ended_at: Date | string | null;
  duration_ms: number | string | null;
  updated_at: Date | string;
};

type DbTraceEventRow = {
  id: string | number;
  trace_id: string;
  span_id: string;
  name: string;
  severity: TraceSeverity;
  attributes: Record<string, unknown> | string | null;
  body: string | null;
  occurred_at: Date | string;
};

type DbTraceStatsRow = {
  runs: number;
  sources: number;
  running: number;
  stuck: number;
  anomalous: number;
  succeeded: number;
  failed: number;
  error_rate: number | string | null;
  avg_duration_ms: number | string | null;
  p95_duration_ms: number | string | null;
  p99_duration_ms: number | string | null;
};

type DbTraceSourceGroupRow = DbTraceStatsRow & {
  source: string;
  app_id: string | null;
  categories: TraceCategory[] | string | null;
  names: string[] | string | null;
  job_runs: number;
  schedule_runs: number;
  ai_runs: number;
  custom_runs: number;
  latest_name: string | null;
  latest_category: TraceCategory | null;
  latest_status: TraceStatus | null;
  latest_started_at: Date | string | null;
  latest_ended_at: Date | string | null;
  latest_duration_ms: number | string | null;
};

const MAX_TEXT_LENGTH = 2_000;
const MAX_ARRAY_ITEMS = 50;
const MAX_OBJECT_KEYS = 100;
const MAX_JSON_DEPTH = 4;
const DEFAULT_SOURCE = "trace";
const TRACE_WINDOW_SECONDS: Record<TraceWindow, number> = {
  "10m": 10 * 60,
  "1h": 60 * 60,
  "12h": 12 * 60 * 60,
  "24h": 24 * 60 * 60,
  "7d": 7 * 24 * 60 * 60,
  "30d": 30 * 24 * 60 * 60,
};

const normalizeDate = (value: Date | number | string | undefined): Date => {
  if (value instanceof Date) return value;
  if (typeof value === "number" || typeof value === "string") {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date;
  }
  return new Date();
};

const toIso = (value: Date | string): string => (value instanceof Date ? value.toISOString() : new Date(value).toISOString());

const toNumberOrNull = (value: number | string | null | undefined): number | null => {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const toNumber = (value: number | string | null | undefined): number => toNumberOrNull(value) ?? 0;

const toStringArray = <T extends string>(value: T[] | string | null | undefined): T[] => {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter(Boolean);
  return value
    .replace(/[{}]/g, "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean) as T[];
};

const randomHex = (bytes: number): string => randomBytes(bytes).toString("hex");

const hashHex = (value: string, bytes: number): string =>
  createHash("sha256")
    .update(value)
    .digest("hex")
    .slice(0, bytes * 2);

const contextFor = (traceId: string, spanId: string): TraceContext => ({
  traceId,
  spanId,
  traceparent: `00-${traceId}-${spanId}-01`,
});

const newContext = (spanKey?: string, parent?: TraceContext): TraceContext => {
  if (spanKey) return contextFor(hashHex(`trace:${spanKey}`, 16), hashHex(`span:${spanKey}`, 8));
  return contextFor(parent?.traceId ?? randomHex(16), randomHex(8));
};

const contextFromParams = (params: { context?: TraceContext; spanKey?: string }): TraceContext | null => {
  if (params.context) return params.context;
  if (params.spanKey) return newContext(params.spanKey);
  return null;
};

const sanitizeJson = (input: unknown, depth = 0): unknown => {
  const redacted = redactMetadata(input);
  if (redacted === null) return null;
  if (typeof redacted === "string") return redacted.length > MAX_TEXT_LENGTH ? `${redacted.slice(0, MAX_TEXT_LENGTH)}...` : redacted;
  if (typeof redacted === "number") return Number.isFinite(redacted) ? redacted : null;
  if (typeof redacted === "boolean") return redacted;
  if (typeof redacted === "bigint") return redacted.toString();
  if (redacted === undefined || typeof redacted === "function" || typeof redacted === "symbol") return null;
  if (depth >= MAX_JSON_DEPTH) return "[Max depth]";
  if (Array.isArray(redacted)) {
    const items = redacted.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitizeJson(item, depth + 1));
    if (redacted.length > MAX_ARRAY_ITEMS) items.push(`[${redacted.length - MAX_ARRAY_ITEMS} more]`);
    return items;
  }
  if (typeof redacted === "object") {
    const out: Record<string, unknown> = {};
    const entries = Object.entries(redacted as Record<string, unknown>).slice(0, MAX_OBJECT_KEYS);
    for (const [key, value] of entries) {
      out[key] = isSensitiveMetadataKey(key) ? REDACTED : sanitizeJson(value, depth + 1);
    }
    const extra = Object.keys(redacted as Record<string, unknown>).length - entries.length;
    if (extra > 0) out.__truncatedKeys = extra;
    return out;
  }
  return null;
};

const sanitizeRecord = (input: Record<string, unknown> | TraceAttributes | undefined): Record<string, unknown> | null => {
  if (!input) return null;
  const sanitized = sanitizeJson(input);
  if (!sanitized || typeof sanitized !== "object" || Array.isArray(sanitized)) return null;
  return sanitized as Record<string, unknown>;
};

const sanitizeAttributes = (input: Record<string, unknown> | TraceAttributes | undefined): Record<string, unknown> | null => {
  const record = sanitizeRecord(input);
  if (!record) return null;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      out[key] = value;
    } else {
      out[key] = JSON.stringify(value);
    }
  }
  return out;
};

const errorAttributes = (error: Error): TraceAttributes => ({
  "exception.type": error.name || "Error",
  "exception.message": error.message,
});

const mapSpanRow = (row: DbTraceSpanRow): TraceSpan => {
  const context = contextFor(row.trace_id, row.span_id);
  return {
    ...context,
    spanKey: row.span_key,
    parentSpanId: row.parent_span_id,
    name: row.name,
    source: row.source,
    appId: row.app_id,
    category: row.category,
    kind: row.kind,
    status: row.status,
    statusMessage: row.status_message,
    attributes: parsePgJsonRecord(row.attributes),
    summary: parsePgJsonRecord(row.summary),
    eventCount: Number(row.event_count ?? 0),
    startedAt: toIso(row.started_at),
    endedAt: row.ended_at ? toIso(row.ended_at) : null,
    durationMs: toNumberOrNull(row.duration_ms),
    updatedAt: toIso(row.updated_at),
  };
};

const mapEventRow = (row: DbTraceEventRow): TraceEvent => ({
  id: String(row.id),
  traceId: row.trace_id,
  spanId: row.span_id,
  name: row.name,
  severity: row.severity,
  attributes: parsePgJsonRecord(row.attributes),
  body: row.body,
  occurredAt: toIso(row.occurred_at),
});

const mapStatsRow = (row: DbTraceStatsRow | undefined): TraceRunStats => ({
  runs: row?.runs ?? 0,
  sources: row?.sources ?? 0,
  running: row?.running ?? 0,
  stuck: row?.stuck ?? 0,
  anomalous: row?.anomalous ?? 0,
  succeeded: row?.succeeded ?? 0,
  failed: row?.failed ?? 0,
  errorRate: toNumber(row?.error_rate),
  avgDurationMs: toNumberOrNull(row?.avg_duration_ms),
  p95DurationMs: toNumberOrNull(row?.p95_duration_ms),
  p99DurationMs: toNumberOrNull(row?.p99_duration_ms),
});

const mapSourceGroupRow = (row: DbTraceSourceGroupRow): TraceSourceGroup => ({
  source: row.source,
  appId: row.app_id,
  categories: toStringArray(row.categories),
  names: toStringArray(row.names),
  runs: row.runs,
  jobRuns: row.job_runs,
  scheduleRuns: row.schedule_runs,
  aiRuns: row.ai_runs,
  customRuns: row.custom_runs,
  running: row.running,
  stuck: row.stuck,
  anomalous: row.anomalous,
  succeeded: row.succeeded,
  failed: row.failed,
  errorRate: toNumber(row.error_rate),
  avgDurationMs: toNumberOrNull(row.avg_duration_ms),
  p95DurationMs: toNumberOrNull(row.p95_duration_ms),
  p99DurationMs: toNumberOrNull(row.p99_duration_ms),
  latestName: row.latest_name,
  latestCategory: row.latest_category,
  latestStatus: row.latest_status,
  latestStartedAt: row.latest_started_at ? toIso(row.latest_started_at) : null,
  latestEndedAt: row.latest_ended_at ? toIso(row.latest_ended_at) : null,
  latestDurationMs: toNumberOrNull(row.latest_duration_ms),
});

const updateSpan = async (
  context: TraceContext,
  params: {
    status?: TraceStatus;
    statusMessage?: string;
    summary?: Record<string, unknown>;
    endedAt?: Date;
  },
): Promise<void> => {
  const summary = sanitizeRecord(params.summary);
  const summaryJson = summary ? JSON.stringify(summary) : null;
  const statusMessage = params.statusMessage ? String(sanitizeJson(params.statusMessage)) : null;
  await sql`
    UPDATE logging.trace_spans
    SET
      status = COALESCE(${params.status ?? null}::text, status),
      status_message = COALESCE(${statusMessage}::text, status_message),
      summary = CASE
        WHEN (${summaryJson}::text)::jsonb IS NULL THEN logging.trace_spans.summary
        ELSE COALESCE(logging.trace_spans.summary, '{}'::jsonb) || (${summaryJson}::text)::jsonb
      END,
      ended_at = COALESCE(${params.endedAt ?? null}, ended_at),
      duration_ms = CASE
        WHEN COALESCE(${params.endedAt ?? null}, ended_at) IS NULL THEN duration_ms
        ELSE GREATEST(0, EXTRACT(EPOCH FROM (COALESCE(${params.endedAt ?? null}, ended_at) - started_at)) * 1000)
      END,
      updated_at = now()
    WHERE trace_id = ${context.traceId} AND span_id = ${context.spanId}
  `.catch((error: Error) => console.error("[logging:trace] span update failed:", error.message));
};

const start = async (params: TraceStartParams, preservePresentation = false): Promise<TraceContext> => {
  const context = newContext(params.spanKey, params.parent);
  const attributes = sanitizeAttributes(params.attributes);
  const attributesJson = attributes ? JSON.stringify(attributes) : null;
  const startedAt = normalizeDate(params.startedAt);
  const [stored] = await sql<Array<{ trace_id: string; span_id: string }>>`
    INSERT INTO logging.trace_spans (
      trace_id,
      span_id,
      span_key,
      parent_span_id,
      name,
      source,
      app_id,
      category,
      kind,
      status,
      attributes,
      started_at,
      updated_at
    )
    VALUES (
      ${context.traceId},
      ${context.spanId},
      ${params.spanKey ?? null},
      ${params.parent?.spanId ?? null},
      ${params.name},
      ${params.source},
      ${params.appId ?? null},
      ${params.category ?? "custom"},
      ${params.kind ?? "internal"},
      'unset',
      (${attributesJson}::text)::jsonb,
      ${startedAt},
      now()
    )
    ON CONFLICT (trace_id, span_id) DO UPDATE
    SET
      span_key = COALESCE(logging.trace_spans.span_key, EXCLUDED.span_key),
      parent_span_id = COALESCE(logging.trace_spans.parent_span_id, EXCLUDED.parent_span_id),
      name = CASE WHEN ${preservePresentation} THEN logging.trace_spans.name ELSE EXCLUDED.name END,
      source = CASE WHEN ${preservePresentation} THEN logging.trace_spans.source ELSE EXCLUDED.source END,
      app_id = COALESCE(EXCLUDED.app_id, logging.trace_spans.app_id),
      category = CASE WHEN ${preservePresentation} THEN logging.trace_spans.category ELSE EXCLUDED.category END,
      kind = CASE WHEN ${preservePresentation} THEN logging.trace_spans.kind ELSE EXCLUDED.kind END,
      attributes = COALESCE(logging.trace_spans.attributes, '{}'::jsonb) || COALESCE(EXCLUDED.attributes, '{}'::jsonb),
      started_at = LEAST(logging.trace_spans.started_at, EXCLUDED.started_at),
      updated_at = now()
    RETURNING trace_id, span_id
  `.catch((error: Error) => {
    console.error("[logging:trace] span start failed:", error.message);
    return [];
  });
  return stored ? contextFor(stored.trace_id, stored.span_id) : context;
};

/**
 * Persists a span whose complete lifecycle is already known. Hot request paths
 * can retain exact tracing without a start/update round-trip pair.
 */
const complete = async (params: TraceCompleteParams, preservePresentation = false): Promise<TraceContext> => {
  const context = newContext(params.spanKey, params.parent);
  const attributes = sanitizeAttributes(params.attributes);
  const summary = sanitizeRecord(params.summary);
  const attributesJson = attributes ? JSON.stringify(attributes) : null;
  const summaryJson = summary ? JSON.stringify(summary) : null;
  const statusMessage = params.statusMessage ? String(sanitizeJson(params.statusMessage)) : null;
  const startedAt = normalizeDate(params.startedAt);
  const endedAt = normalizeDate(params.endedAt);
  const [stored] = await sql<Array<{ trace_id: string; span_id: string }>>`
    INSERT INTO logging.trace_spans (
      trace_id,
      span_id,
      span_key,
      parent_span_id,
      name,
      source,
      app_id,
      category,
      kind,
      status,
      status_message,
      attributes,
      summary,
      started_at,
      ended_at,
      duration_ms,
      updated_at
    )
    VALUES (
      ${context.traceId},
      ${context.spanId},
      ${params.spanKey ?? null},
      ${params.parent?.spanId ?? null},
      ${params.name},
      ${params.source},
      ${params.appId ?? null},
      ${params.category ?? "custom"},
      ${params.kind ?? "internal"},
      ${params.status ?? "ok"},
      ${statusMessage},
      (${attributesJson}::text)::jsonb,
      (${summaryJson}::text)::jsonb,
      ${startedAt},
      ${endedAt},
      GREATEST(0, EXTRACT(EPOCH FROM (${endedAt}::timestamptz - ${startedAt}::timestamptz)) * 1000),
      now()
    )
    ON CONFLICT (trace_id, span_id) DO UPDATE
    SET
      span_key = COALESCE(logging.trace_spans.span_key, EXCLUDED.span_key),
      parent_span_id = COALESCE(logging.trace_spans.parent_span_id, EXCLUDED.parent_span_id),
      name = CASE WHEN ${preservePresentation} THEN logging.trace_spans.name ELSE EXCLUDED.name END,
      source = CASE WHEN ${preservePresentation} THEN logging.trace_spans.source ELSE EXCLUDED.source END,
      app_id = COALESCE(EXCLUDED.app_id, logging.trace_spans.app_id),
      category = CASE WHEN ${preservePresentation} THEN logging.trace_spans.category ELSE EXCLUDED.category END,
      kind = CASE WHEN ${preservePresentation} THEN logging.trace_spans.kind ELSE EXCLUDED.kind END,
      status = EXCLUDED.status,
      status_message = EXCLUDED.status_message,
      attributes = COALESCE(logging.trace_spans.attributes, '{}'::jsonb) || COALESCE(EXCLUDED.attributes, '{}'::jsonb),
      summary = COALESCE(logging.trace_spans.summary, '{}'::jsonb) || COALESCE(EXCLUDED.summary, '{}'::jsonb),
      started_at = LEAST(logging.trace_spans.started_at, EXCLUDED.started_at),
      ended_at = GREATEST(logging.trace_spans.ended_at, EXCLUDED.ended_at),
      duration_ms = GREATEST(
        0,
        EXTRACT(EPOCH FROM (GREATEST(logging.trace_spans.ended_at, EXCLUDED.ended_at) - LEAST(logging.trace_spans.started_at, EXCLUDED.started_at))) * 1000
      ),
      updated_at = now()
    RETURNING trace_id, span_id
  `.catch((error: Error) => {
    console.error("[logging:trace] completed span write failed:", error.message);
    return [];
  });
  return stored ? contextFor(stored.trace_id, stored.span_id) : context;
};

const record = async (params: TraceRecordParams, preservePresentation = false): Promise<TraceContext> => {
  const standalone = !params.context && !params.spanKey;
  const context =
    params.context ??
    (await start(
      {
        name: params.name ?? params.event,
        source: params.source ?? DEFAULT_SOURCE,
        spanKey: params.spanKey,
        appId: params.appId,
        category: params.category ?? "custom",
        kind: params.kind ?? "internal",
        startedAt: params.occurredAt,
      },
      preservePresentation,
    ));
  const occurredAt = normalizeDate(params.occurredAt);
  const attributes = sanitizeAttributes(params.attributes);
  const attributesJson = attributes ? JSON.stringify(attributes) : null;
  const body = params.body ? String(sanitizeJson(params.body)) : null;
  await sql`
    INSERT INTO logging.trace_events (trace_id, span_id, name, severity, attributes, body, occurred_at)
    VALUES (
      ${context.traceId},
      ${context.spanId},
      ${params.event},
      ${params.severity ?? "info"},
      (${attributesJson}::text)::jsonb,
      ${body},
      ${occurredAt}
    )
  `.catch((error: Error) => console.error("[logging:trace] event write failed:", error.message));
  if (params.status || params.statusMessage || params.summary) {
    await updateSpan(context, { status: params.status, statusMessage: params.statusMessage, summary: params.summary });
  }
  if (standalone) await end({ context, status: params.status ?? "unset", summary: params.summary, endedAt: occurredAt });
  return context;
};

const end = async (params: TraceEndParams): Promise<void> => {
  // An application may attach a summary immediately after Sync emits start.
  // Wait for that queued insert before updating the same deterministic span.
  if (params.spanKey) await pendingSyncWrites.get(params.spanKey);
  const context = contextFromParams(params);
  if (!context) return;
  await updateSpan(context, {
    status: params.status ?? "ok",
    statusMessage: params.statusMessage,
    summary: params.summary,
    endedAt: normalizeDate(params.endedAt),
  });
};

const withSpan = async <T>(
  params: TraceStartParams,
  fn: (span: TraceContext) => Promise<T> | T,
  options?: TraceWithSpanOptions<T>,
): Promise<T> => {
  const span = await start(params);
  try {
    const result = await fn(span);
    await end({ context: span, status: "ok", summary: options?.summarize?.(result) });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await record({
      context: span,
      event: "exception",
      severity: "error",
      attributes: error instanceof Error ? errorAttributes(error) : { "exception.message": message },
    });
    await end({ context: span, status: "error", statusMessage: message, summary: options?.onError?.(error) });
    throw error;
  }
};

const normalizeSinceHours = (sinceHours: number | undefined): number | null =>
  Number.isFinite(sinceHours) && sinceHours && sinceHours > 0 ? Math.trunc(sinceHours) : null;

const normalizeSinceSeconds = (filter: TraceListFilter | undefined): number | null => {
  if (Number.isFinite(filter?.sinceSeconds) && filter?.sinceSeconds && filter.sinceSeconds > 0) return Math.trunc(filter.sinceSeconds);
  if (filter?.window) return TRACE_WINDOW_SECONDS[filter.window];
  const sinceHours = normalizeSinceHours(filter?.sinceHours);
  return sinceHours ? sinceHours * 60 * 60 : null;
};

const normalizeMinDurationMs = (value: number | undefined): number | null =>
  Number.isFinite(value) && value && value > 0 ? Math.trunc(value) : null;

const normalizeLimit = (limit: number | undefined): number => Math.min(Math.max(Math.trunc(limit ?? 50), 1), 200);

const traceConditions = (filter: TraceListFilter | undefined): any[] => {
  const conditions: any[] = [sql`TRUE`];
  const searchPattern = filter?.search ? `%${escapeLikePattern(filter.search)}%` : null;
  const sources = filter?.sources?.map((value) => value.trim()).filter(Boolean);
  const sourceList = sources && sources.length > 0 ? toPgTextArray([...new Set(sources)]) : null;
  const sinceSeconds = normalizeSinceSeconds(filter);
  const minDurationMs = normalizeMinDurationMs(filter?.minDurationMs);
  const attributeEquals = sanitizeAttributes(filter?.attributeEquals);

  if (filter?.appId) conditions.push(sql`s.app_id = ${filter.appId}`);
  if (filter?.source) conditions.push(sql`s.source = ${filter.source}`);
  if (sourceList && !filter?.source) conditions.push(sql`s.source = ANY(${sourceList}::text[])`);
  if (filter?.status) conditions.push(sql`s.status = ${filter.status}`);
  if (filter?.active === true) conditions.push(sql`s.ended_at IS NULL`);
  if (filter?.active === false) conditions.push(sql`s.ended_at IS NOT NULL`);
  if (filter?.category) conditions.push(sql`s.category = ${filter.category}`);
  if (attributeEquals && Object.keys(attributeEquals).length > 0) {
    conditions.push(sql`s.attributes @> (${JSON.stringify(attributeEquals)}::text)::jsonb`);
  }
  if (sinceSeconds) conditions.push(sql`s.started_at >= now() - (${sinceSeconds}::int * INTERVAL '1 second')`);
  if (minDurationMs) conditions.push(sql`s.duration_ms IS NOT NULL AND s.duration_ms > ${minDurationMs}`);
  if (searchPattern) {
    conditions.push(sql`(
      s.name ILIKE ${searchPattern} ESCAPE '\'
      OR s.source ILIKE ${searchPattern} ESCAPE '\'
      OR COALESCE(s.app_id, '') ILIKE ${searchPattern} ESCAPE '\'
      OR COALESCE(s.span_key, '') ILIKE ${searchPattern} ESCAPE '\'
    )`);
  }

  return conditions;
};

const traceWhere = (filter: TraceListFilter | undefined) =>
  traceConditions(filter).reduce((acc, condition) => sql`${acc} AND ${condition}`);

/**
 * Abandoned spans are old by definition, so a windowed count hides exactly the
 * ones worth seeing: with a 24h window, a span orphaned three days ago reports
 * zero. Stuck is therefore counted across all retained spans, with the rest of
 * the filter (source, category, search) still applied.
 */
const stuckWhere = (filter: TraceListFilter | undefined) =>
  traceConditions({ ...filter, window: undefined })
    .concat([sql`s.ended_at IS NULL`, sql`s.started_at < now() - (${TRACE_STUCK_AFTER_MS}::bigint * INTERVAL '1 millisecond')`])
    .reduce((acc, condition) => sql`${acc} AND ${condition}`);

const countStuck = async (filter: TraceListFilter | undefined): Promise<number> => {
  const [row] = await sql<{ count: number }[]>`
    SELECT COUNT(*)::int AS count FROM logging.trace_spans s WHERE ${stuckWhere(filter)}
  `;
  return row?.count ?? 0;
};

const countStuckBySource = async (filter: TraceListFilter | undefined): Promise<Map<string, number>> => {
  const rows = await sql<{ source: string; count: number }[]>`
    SELECT s.source, COUNT(*)::int AS count
    FROM logging.trace_spans s WHERE ${stuckWhere(filter)}
    GROUP BY s.source
  `;
  return new Map(rows.map((row) => [row.source, row.count]));
};

const list = async (
  pagination: PaginationParams,
  options?: {
    filter?: TraceListFilter;
  },
): Promise<{ spans: TraceSpan[]; total: number }> => {
  const { offset, perPage } = pagination;
  const where = traceWhere(options?.filter);
  const [countRows, dataRows] = await Promise.all([
    sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count
      FROM logging.trace_spans s
      WHERE ${where}
    `,
    sql<DbTraceSpanRow[]>`
      SELECT
        s.*,
        (
          SELECT COUNT(*)::int
          FROM logging.trace_events e
          WHERE e.trace_id = s.trace_id AND e.span_id = s.span_id
        ) AS event_count
      FROM logging.trace_spans s
      WHERE ${where}
      ORDER BY COALESCE(s.ended_at, s.updated_at, s.started_at) DESC
      LIMIT ${perPage} OFFSET ${offset}
    `,
  ]);

  return { spans: dataRows.map(mapSpanRow), total: countRows[0]?.count ?? 0 };
};

const getSpan = async (params: { traceId: string; spanId: string }): Promise<TraceSpan | null> => {
  const rows = await sql<DbTraceSpanRow[]>`
    SELECT
      s.*,
      (
        SELECT COUNT(*)::int
        FROM logging.trace_events e
        WHERE e.trace_id = s.trace_id AND e.span_id = s.span_id
      ) AS event_count
    FROM logging.trace_spans s
    WHERE s.trace_id = ${params.traceId} AND s.span_id = ${params.spanId}
    LIMIT 1
  `;
  return rows[0] ? mapSpanRow(rows[0]) : null;
};

const stats = async (options?: { filter?: TraceListFilter }): Promise<TraceRunStats> => {
  const where = traceWhere(options?.filter);
  const [row] = await sql<DbTraceStatsRow[]>`
    SELECT
      COUNT(*)::int AS runs,
      COUNT(DISTINCT s.source)::int AS sources,
      COUNT(*) FILTER (WHERE s.ended_at IS NULL AND s.started_at >= now() - (${TRACE_STUCK_AFTER_MS}::bigint * INTERVAL '1 millisecond'))::int AS running,
        COUNT(*) FILTER (WHERE s.ended_at IS NULL AND s.started_at < now() - (${TRACE_STUCK_AFTER_MS}::bigint * INTERVAL '1 millisecond'))::int AS stuck,
        COUNT(*) FILTER (WHERE s.duration_ms > ${TRACE_STUCK_AFTER_MS})::int AS anomalous,
      COUNT(*) FILTER (WHERE s.status = 'ok')::int AS succeeded,
      COUNT(*) FILTER (WHERE s.status = 'error')::int AS failed,
      COALESCE(ROUND((COUNT(*) FILTER (WHERE s.status = 'error'))::numeric * 100 / NULLIF(COUNT(*), 0), 2), 0)::float AS error_rate,
      (AVG(s.duration_ms) FILTER (WHERE s.duration_ms IS NOT NULL AND s.duration_ms <= ${TRACE_STUCK_AFTER_MS}))::float AS avg_duration_ms,
      (percentile_cont(0.95) WITHIN GROUP (ORDER BY s.duration_ms) FILTER (WHERE s.duration_ms IS NOT NULL AND s.duration_ms <= ${TRACE_STUCK_AFTER_MS}))::float AS p95_duration_ms,
      (percentile_cont(0.99) WITHIN GROUP (ORDER BY s.duration_ms) FILTER (WHERE s.duration_ms IS NOT NULL AND s.duration_ms <= ${TRACE_STUCK_AFTER_MS}))::float AS p99_duration_ms
    FROM logging.trace_spans s
    WHERE ${where}
  `;
  return { ...mapStatsRow(row), stuck: await countStuck(options?.filter) };
};

const sourceGroups = async (options?: { filter?: TraceListFilter }): Promise<TraceSourceGroup[]> => {
  const where = traceWhere(options?.filter);
  const stuckBySource = await countStuckBySource(options?.filter);
  const rows = await sql<DbTraceSourceGroupRow[]>`
    WITH grouped AS (
      SELECT
        s.source,
        (array_remove(array_agg(DISTINCT s.app_id), NULL))[1] AS app_id,
        array_agg(DISTINCT s.category ORDER BY s.category)::text[] AS categories,
        array_agg(DISTINCT s.name ORDER BY s.name)::text[] AS names,
        COUNT(*)::int AS runs,
        COUNT(DISTINCT s.source)::int AS sources,
        COUNT(*) FILTER (WHERE s.category = 'job')::int AS job_runs,
        COUNT(*) FILTER (WHERE s.category = 'schedule')::int AS schedule_runs,
        COUNT(*) FILTER (WHERE s.category = 'ai')::int AS ai_runs,
        COUNT(*) FILTER (WHERE s.category = 'custom')::int AS custom_runs,
        COUNT(*) FILTER (WHERE s.ended_at IS NULL AND s.started_at >= now() - (${TRACE_STUCK_AFTER_MS}::bigint * INTERVAL '1 millisecond'))::int AS running,
        COUNT(*) FILTER (WHERE s.ended_at IS NULL AND s.started_at < now() - (${TRACE_STUCK_AFTER_MS}::bigint * INTERVAL '1 millisecond'))::int AS stuck,
        COUNT(*) FILTER (WHERE s.duration_ms > ${TRACE_STUCK_AFTER_MS})::int AS anomalous,
        COUNT(*) FILTER (WHERE s.status = 'ok')::int AS succeeded,
        COUNT(*) FILTER (WHERE s.status = 'error')::int AS failed,
        COALESCE(ROUND((COUNT(*) FILTER (WHERE s.status = 'error'))::numeric * 100 / NULLIF(COUNT(*), 0), 2), 0)::float AS error_rate,
        (AVG(s.duration_ms) FILTER (WHERE s.duration_ms IS NOT NULL AND s.duration_ms <= ${TRACE_STUCK_AFTER_MS}))::float AS avg_duration_ms,
        (percentile_cont(0.95) WITHIN GROUP (ORDER BY s.duration_ms) FILTER (WHERE s.duration_ms IS NOT NULL AND s.duration_ms <= ${TRACE_STUCK_AFTER_MS}))::float AS p95_duration_ms,
        (percentile_cont(0.99) WITHIN GROUP (ORDER BY s.duration_ms) FILTER (WHERE s.duration_ms IS NOT NULL AND s.duration_ms <= ${TRACE_STUCK_AFTER_MS}))::float AS p99_duration_ms,
        (array_agg(s.name ORDER BY s.started_at DESC, s.updated_at DESC))[1] AS latest_name,
        (array_agg(s.category ORDER BY s.started_at DESC, s.updated_at DESC))[1] AS latest_category,
        (array_agg(s.status ORDER BY s.started_at DESC, s.updated_at DESC))[1] AS latest_status,
        (array_agg(s.started_at ORDER BY s.started_at DESC, s.updated_at DESC))[1] AS latest_started_at,
        (array_agg(s.ended_at ORDER BY s.started_at DESC, s.updated_at DESC))[1] AS latest_ended_at,
        (array_agg(s.duration_ms ORDER BY s.started_at DESC, s.updated_at DESC))[1] AS latest_duration_ms
      FROM logging.trace_spans s
      WHERE ${where}
      GROUP BY s.source
    )
    SELECT *
    FROM grouped
    ORDER BY
      (latest_ended_at IS NULL) DESC,
      (latest_status = 'error') DESC,
      error_rate DESC,
      p99_duration_ms DESC NULLS LAST,
      runs DESC,
      source ASC
  `;
  return rows.map((row) => ({ ...mapSourceGroupRow(row), stuck: stuckBySource.get(row.source) ?? 0 }));
};

const events = async (params: { traceId: string; spanId?: string; limit?: number }): Promise<TraceEvent[]> => {
  const limit = normalizeLimit(params.limit);
  const rows = await sql<DbTraceEventRow[]>`
    SELECT id, trace_id, span_id, name, severity, attributes, body, occurred_at
    FROM logging.trace_events
    WHERE trace_id = ${params.traceId}
      AND (${params.spanId ?? null}::text IS NULL OR span_id = ${params.spanId ?? null})
    ORDER BY occurred_at ASC, id ASC
    LIMIT ${limit}
  `;
  return rows.map(mapEventRow);
};

const sources = async (): Promise<string[]> => {
  const rows = await sql<{ source: string }[]>`
    SELECT DISTINCT source FROM logging.trace_spans ORDER BY source
  `;
  return rows.map((row) => row.source);
};

const summary = async (options?: { sinceHours?: number }): Promise<TraceSummary> => {
  const sinceHours = normalizeSinceHours(options?.sinceHours) ?? 24;
  const [row] = await sql<
    {
      total: number;
      total_window: number;
      running: number;
      succeeded_window: number;
      failed_window: number;
      sources: number;
      avg_duration_ms: number | string | null;
      p95_duration_ms: number | string | null;
    }[]
  >`
    SELECT
      (SELECT COUNT(*)::int FROM logging.trace_spans) AS total,
      (SELECT COUNT(*)::int FROM logging.trace_spans WHERE started_at >= now() - (${sinceHours}::int * INTERVAL '1 hour')) AS total_window,
      (SELECT COUNT(*)::int FROM logging.trace_spans WHERE ended_at IS NULL) AS running,
      (SELECT COUNT(*)::int FROM logging.trace_spans WHERE status = 'ok' AND started_at >= now() - (${sinceHours}::int * INTERVAL '1 hour')) AS succeeded_window,
      (SELECT COUNT(*)::int FROM logging.trace_spans WHERE status = 'error' AND started_at >= now() - (${sinceHours}::int * INTERVAL '1 hour')) AS failed_window,
      (SELECT COUNT(*)::int FROM (SELECT DISTINCT source FROM logging.trace_spans) s) AS sources,
      (SELECT AVG(duration_ms)::float FROM logging.trace_spans WHERE duration_ms IS NOT NULL AND started_at >= now() - (${sinceHours}::int * INTERVAL '1 hour')) AS avg_duration_ms,
      (
        SELECT percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms)::float
        FROM logging.trace_spans
        WHERE duration_ms IS NOT NULL AND started_at >= now() - (${sinceHours}::int * INTERVAL '1 hour')
      ) AS p95_duration_ms
  `;

  return {
    total: row?.total ?? 0,
    totalWindow: row?.total_window ?? 0,
    running: row?.running ?? 0,
    succeededWindow: row?.succeeded_window ?? 0,
    failedWindow: row?.failed_window ?? 0,
    sources: row?.sources ?? 0,
    avgDurationMs: toNumberOrNull(row?.avg_duration_ms),
    p95DurationMs: toNumberOrNull(row?.p95_duration_ms),
  };
};

const cleanup = async (options: { days: number; source?: string }): Promise<number> => {
  const days = Math.max(1, Math.trunc(options.days));
  const result = await sql`
    DELETE FROM logging.trace_spans
    WHERE ended_at IS NOT NULL
      AND ended_at < now() - (${days}::int * INTERVAL '1 day')
      AND (${options.source ?? null}::text IS NULL OR source = ${options.source ?? null})
  `;
  return result.count;
};

// ==========================
// Sync observe adapter
// ==========================

/**
 * Sync v6 emits ids, keys and statuses only — never handler results — so a
 * run span carries the run identity and outcome. A handler that wants a
 * summary attaches it itself with `trace.end({ spanKey, summary })`, using
 * `trace.syncSpanKey(kind, resource, runId)` for the same span.
 *
 * Topic consumer runs are traced only when they fail: a successful run
 * writes nothing. Telemetry consumers process one event per request, and two
 * span writes per event would multiply the write load and saturate the
 * bounded observer buffer, dropping the process's other Sync diagnostics.
 */

type SyncRunKind = "queue" | "job" | "topic" | "scheduler" | "pump";

const SYNC_CATEGORY: Record<SyncRunKind, TraceCategory> = {
  queue: "job",
  job: "job",
  topic: "sync",
  scheduler: "schedule",
  pump: "backfill",
};

/** Span key of one Sync run. Topic handlers also pass their independent consumer name. */
const syncSpanKey = (kind: SyncRunKind, resource: string, runId: string, consumer?: string): string =>
  kind === "topic" && consumer !== undefined
    ? `sync:topic:${JSON.stringify([resource, runId, consumer])}`
    : `sync:${kind}:${resource}:${runId}`;

const isSyncRunKind = (kind: string): kind is SyncRunKind => kind in SYNC_CATEGORY;

const TRACED_SYNC_EVENT_TYPES = new Set([
  "handler_started",
  "handler_settled",
  "dead_letter",
  "redelivery",
  "pump_run_started",
  "pump_run_settled",
]);

/** Whether the adapter records this event at all (see the topic policy above). */
const isTracedSyncEvent = (event: SyncEvent): boolean => {
  if (!event.resource || !event.kind || !isSyncRunKind(event.kind) || !TRACED_SYNC_EVENT_TYPES.has(event.type)) return false;
  if (event.kind !== "topic") return true;
  if (event.type === "handler_started") return false;
  if (event.type !== "handler_settled") return true;
  const status = event.detail?.status;
  return status === "retry" || status === "dead_letter";
};

const detailString = (detail: Record<string, unknown>, key: string): string | undefined => {
  const value = detail[key];
  return typeof value === "string" ? value : undefined;
};

const detailNumber = (detail: Record<string, unknown>, key: string): number | undefined => {
  const value = detail[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
};

const detailAttributes = (detail: Record<string, unknown>): TraceAttributes => {
  const out: TraceAttributes = {};
  for (const [key, value] of Object.entries(detail)) {
    if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      out[`sync.${key}`] = value;
    }
  }
  return out;
};

/** The app hosting this process; Sync events carry no app name. */
const processAppId = (): string | undefined => process.env.APP_ID?.trim() || undefined;

const traceSyncEvent = async (event: SyncEvent, application?: string): Promise<void> => {
  const resource = event.resource;
  const kind = event.kind;
  if (!resource || !kind || !isSyncRunKind(kind) || !isTracedSyncEvent(event)) return;
  const detail: Record<string, unknown> = event.detail ?? {};
  const appId = application ?? processAppId();
  const category = SYNC_CATEGORY[kind];
  const attributes: TraceAttributes = {
    "sync.kind": kind,
    "sync.resource": resource,
    ...detailAttributes(detail),
    ...(event.error ? { "sync.error": event.error } : {}),
  };
  // Topic dead letters carry the consumer instead of the run key.
  const key = detailString(detail, "key") ?? (kind === "topic" ? detailString(detail, "consumer") : undefined);
  const consumer = kind === "topic" ? key : undefined;
  // Per-schedule and per-consumer names stay readable; job keys are unbounded.
  const name = (kind === "scheduler" || kind === "topic") && key ? key : resource;
  const base = { name, source: resource, appId, category, kind: "consumer" as const };

  switch (event.type) {
    case "handler_started": {
      const id = detailString(detail, "id");
      if (!id) return;
      await start({ ...base, spanKey: syncSpanKey(kind, resource, id, consumer), attributes, startedAt: event.at }, true);
      return;
    }
    case "handler_settled": {
      const id = detailString(detail, "id");
      if (!id) return;
      const spanKey = syncSpanKey(kind, resource, id, consumer);
      const status = detailString(detail, "status");
      const attempt = detailNumber(detail, "attempt");
      const durationMs = detailNumber(detail, "durationMs") ?? 0;
      if (status === "retry") {
        // Topic runs have no started span: materialize the failed run first.
        if (kind === "topic") {
          await complete(
            {
              ...base,
              spanKey,
              status: "error",
              statusMessage: `Retry scheduled after ${attempt ?? "?"} attempt(s)`,
              attributes,
              startedAt: event.at.getTime() - durationMs,
              endedAt: event.at,
            },
            true,
          );
        }
        await record(
          {
            ...base,
            spanKey,
            event: "sync.retry",
            severity: "warn",
            status: "error",
            attributes,
            occurredAt: event.at,
          },
          true,
        );
        return;
      }
      await complete(
        {
          ...base,
          spanKey,
          status: status === "success" ? "ok" : "error",
          statusMessage: status === "success" ? undefined : `Dead-lettered after ${attempt ?? "?"} attempt(s)`,
          attributes,
          startedAt: event.at.getTime() - durationMs,
          endedAt: event.at,
        },
        true,
      );
      return;
    }
    case "dead_letter": {
      const id = detailString(detail, "messageId") ?? detailString(detail, "eventId");
      if (!id) return;
      const spanKey = syncSpanKey(kind, resource, id, consumer);
      const reason = detailString(detail, "reason") ?? "dead letter";
      // A message can be dead-lettered without a handler run (attempts
      // exhausted on delivery, undecodable payload): the upsert closes the
      // span either way, and the event records the reason.
      await complete(
        {
          ...base,
          spanKey,
          status: "error",
          statusMessage: reason,
          attributes,
          startedAt: event.at,
          endedAt: event.at,
        },
        true,
      );
      await record({ context: newContext(spanKey), event: "sync.dead_letter", severity: "error", attributes, occurredAt: event.at });
      return;
    }
    case "redelivery": {
      // Carries no run id: recorded as its own zero-length span next to the runs.
      await record({ ...base, category: "sync", event: "sync.redelivery", severity: "warn", attributes, occurredAt: event.at });
      return;
    }
    case "pump_run_started": {
      if (!key) return;
      await start({ ...base, spanKey: syncSpanKey("pump", resource, key), attributes, startedAt: event.at }, true);
      return;
    }
    case "pump_run_settled": {
      if (!key) return;
      const status = detailString(detail, "status");
      const durationMs = detailNumber(detail, "durationMs") ?? 0;
      await complete(
        {
          ...base,
          spanKey: syncSpanKey("pump", resource, key),
          status: status === "failed" ? "error" : "ok",
          statusMessage: detailString(detail, "error"),
          attributes,
          summary: { status, dispatched: detailNumber(detail, "dispatched"), failureCount: detailNumber(detail, "failureCount") },
          startedAt: event.at.getTime() - durationMs,
          endedAt: event.at,
        },
        true,
      );
      return;
    }
    default:
      return;
  }
};

// Match Sync's event subscription buffer budget. Observer overload drops
// diagnostics rather than retaining unbounded SQL promises or delaying jobs.
const SYNC_TRACE_PENDING_LIMIT = 1024;
const pendingSyncWrites = new Map<string, Promise<void>>();
let pendingSyncWriteCount = 0;
let reportedSyncOverflow = false;

/** Ordered per-run, bounded, non-blocking adapter for createSync({ observe }). */
export const observeSyncEvent = (event: SyncEvent, application?: string): void => {
  if (!event.resource || !event.kind || !isSyncRunKind(event.kind) || !isTracedSyncEvent(event)) return;
  if (pendingSyncWriteCount >= SYNC_TRACE_PENDING_LIMIT) {
    if (!reportedSyncOverflow) console.error("[logging:trace] sync trace buffer full; dropping diagnostics");
    reportedSyncOverflow = true;
    return;
  }
  const detail = event.detail ?? {};
  const id =
    detailString(detail, "id") ?? detailString(detail, "messageId") ?? detailString(detail, "eventId") ?? detailString(detail, "key") ?? "";
  const consumer = event.kind === "topic" ? (detailString(detail, "key") ?? detailString(detail, "consumer")) : undefined;
  const key = syncSpanKey(event.kind, event.resource, id, consumer);
  pendingSyncWriteCount++;
  const write = (pendingSyncWrites.get(key) ?? Promise.resolve())
    .then(() => traceSyncEvent(event, application))
    .catch((error: unknown) => {
      console.error("[logging:trace] sync event failed:", error instanceof Error ? error.message : String(error));
    })
    .finally(() => {
      pendingSyncWriteCount--;
      if (pendingSyncWrites.get(key) === write) pendingSyncWrites.delete(key);
      if (pendingSyncWriteCount === 0) reportedSyncOverflow = false;
    });
  pendingSyncWrites.set(key, write);
};

/** Flush diagnostics after Sync workers stop producing events during shutdown. */
export const flushSyncTraceEvents = async (): Promise<void> => {
  while (pendingSyncWrites.size > 0) await Promise.all(pendingSyncWrites.values());
};

/** Awaitable form of {@link observeSyncEvent} for tests. */
export { traceSyncEvent };

export const trace = {
  start,
  complete,
  record,
  end,
  withSpan,
  list,
  getSpan,
  stats,
  sourceGroups,
  events,
  sources,
  summary,
  cleanup,
  syncSpanKey,
};
