import { sql } from "bun";
import type { PaginationParams } from "../../contracts/shared";
import { escapeLikePattern, parsePgJsonRecord, toPgTextArray } from "../postgres";
import { registerSettings } from "../settings/defaults";
import { redactMetadata } from "./redaction";
import { observeSyncEvent, TRACE_STUCK_AFTER_MS, trace } from "./trace";

export type {
  TraceAttributes,
  TraceAttributeValue,
  TraceCategory,
  TraceContext,
  TraceEvent,
  TraceListFilter,
  TraceRunStats,
  TraceSeverity,
  TraceSourceGroup,
  TraceSpan,
  TraceSpanKind,
  TraceStatus,
  TraceSummary,
  TraceWindow,
} from "./trace";
export { observeSyncEvent, TRACE_STUCK_AFTER_MS, trace };

// ── Settings Registration ──────────────────────────────────────────────

registerSettings([
  {
    key: "logs.retention_days",
    kind: "number",
    default: 30,
    description: "Automatically delete log entries older than this many days",
    group: "logs",
  },
  {
    key: "logs.trace_retention_days",
    kind: "number",
    default: 30,
    description: "Automatically delete completed traces older than this many days",
    group: "logs",
  },
]);

// ==========================
// Types
// ==========================

type LogLevel = "debug" | "info" | "warn" | "error";

type WriteParams = {
  level: LogLevel;
  source: string;
  message: string;
  metadata?: Record<string, unknown>;
};

type Logger = {
  debug: (message: string, metadata?: Record<string, unknown>) => void;
  info: (message: string, metadata?: Record<string, unknown>) => void;
  warn: (message: string, metadata?: Record<string, unknown>) => void;
  error: (message: string, metadata?: Record<string, unknown>) => void;
};

export type LogEntry = {
  id: string;
  level: LogLevel;
  source: string;
  message: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
};

type DbLogRow = {
  id: string | number;
  level: string;
  source: string;
  message: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
};

export type LogStatsGroupBy = "source" | "level";

export type LogStatsRow = {
  key: string;
  count: number;
};

export type LogTimeseriesPoint = {
  at: Date;
  debug: number;
  info: number;
  warn: number;
  error: number;
  total: number;
};

// ==========================
// Helpers
// ==========================

/**
 * Maps one logging row to the public log entry shape.
 */
const mapRow = (row: DbLogRow): LogEntry => ({
  id: String(row.id),
  level: row.level as LogLevel,
  source: row.source,
  message: row.message,
  metadata: parsePgJsonRecord(row.metadata),
  createdAt: row.created_at,
});

// ==========================
// Core: Write + Logger
// ==========================

/** Fire-and-forget write — mirrors to console, then inserts to DB async. */
function write(params: WriteParams): void {
  const safeMetadata = params.metadata ? (redactMetadata(params.metadata) as Record<string, unknown>) : undefined;
  const prefix = `[${params.source}]`;
  const consoleFn = params.level === "error" ? console.error : params.level === "warn" ? console.warn : console.log;
  consoleFn(prefix, params.message, ...(safeMetadata ? [safeMetadata] : []));

  sql`
    INSERT INTO logging.entries (level, source, message, metadata)
    VALUES (
      ${params.level},
      ${params.source},
      ${params.message},
      ${safeMetadata ? JSON.stringify(safeMetadata) : null}::jsonb
    )
  `.catch((err: Error) => console.error("[logging] DB write failed:", err.message));
}

/**
 * Stateless logger factory. Creates an object with .debug/.info/.warn/.error methods
 * bound to the given source. Can be called inline or cached — no state is held.
 *
 * @example
 * // Inline
 * logger("yjs").info("Document loaded", { noteId });
 *
 * // Cached
 * const log = logger("weather");
 * log.error("API error", { status: 500 });
 */
export function logger(source: string): Logger {
  return {
    debug: (msg, meta) => write({ level: "debug", source, message: msg, metadata: meta }),
    info: (msg, meta) => write({ level: "info", source, message: msg, metadata: meta }),
    warn: (msg, meta) => write({ level: "warn", source, message: msg, metadata: meta }),
    error: (msg, meta) => write({ level: "error", source, message: msg, metadata: meta }),
  };
}

// ==========================
// Admin: List / Sources / Cleanup
// ==========================

/** List log entries with pagination and optional filters. */
const list = async (
  pagination: PaginationParams,
  options?: {
    source?: string;
    sources?: string[];
    level?: string;
    search?: string;
    sinceHours?: number;
  },
): Promise<{ entries: LogEntry[]; total: number }> => {
  const { offset, perPage } = pagination;
  const { source, sources, level, search, sinceHours } = options ?? {};

  const searchPattern = search ? `%${escapeLikePattern(search)}%` : null;
  const filterSource = source && source !== "all" ? source : null;
  const filterSources =
    !filterSource && Array.isArray(sources) && sources.length > 0
      ? [...new Set(sources.map((value) => value.trim()).filter(Boolean))]
      : null;
  const filterSourcesLiteral = filterSources ? toPgTextArray(filterSources) : null;
  const filterLevel = level && level !== "all" ? level : null;
  const hasSourceList = !!filterSources && filterSources.length > 0;
  const filterSinceHours = Number.isFinite(sinceHours) && sinceHours && sinceHours > 0 ? Math.trunc(sinceHours) : null;

  let countRows: Array<{ count: number }> = [];
  let dataRows: DbLogRow[] = [];

  if (filterSource) {
    countRows = await sql`
      SELECT COUNT(*)::int as count
      FROM logging.entries
      WHERE source = ${filterSource}
        AND (${filterLevel}::text IS NULL OR level = ${filterLevel})
        AND (${filterSinceHours}::int IS NULL OR created_at >= now() - (${filterSinceHours}::int * INTERVAL '1 hour'))
        AND (${searchPattern}::text IS NULL OR message ILIKE ${searchPattern} ESCAPE '\' OR metadata::text ILIKE ${searchPattern} ESCAPE '\')
    `;

    dataRows = await sql`
      SELECT id, level, source, message, metadata, created_at
      FROM logging.entries
      WHERE source = ${filterSource}
        AND (${filterLevel}::text IS NULL OR level = ${filterLevel})
        AND (${filterSinceHours}::int IS NULL OR created_at >= now() - (${filterSinceHours}::int * INTERVAL '1 hour'))
        AND (${searchPattern}::text IS NULL OR message ILIKE ${searchPattern} ESCAPE '\' OR metadata::text ILIKE ${searchPattern} ESCAPE '\')
      ORDER BY created_at DESC
      LIMIT ${perPage} OFFSET ${offset}
    `;
  } else if (hasSourceList) {
    countRows = await sql`
      SELECT COUNT(*)::int as count
      FROM logging.entries
      WHERE source = ANY(${filterSourcesLiteral}::text[])
        AND (${filterLevel}::text IS NULL OR level = ${filterLevel})
        AND (${filterSinceHours}::int IS NULL OR created_at >= now() - (${filterSinceHours}::int * INTERVAL '1 hour'))
        AND (${searchPattern}::text IS NULL OR message ILIKE ${searchPattern} ESCAPE '\' OR metadata::text ILIKE ${searchPattern} ESCAPE '\')
    `;

    dataRows = await sql`
      SELECT id, level, source, message, metadata, created_at
      FROM logging.entries
      WHERE source = ANY(${filterSourcesLiteral}::text[])
        AND (${filterLevel}::text IS NULL OR level = ${filterLevel})
        AND (${filterSinceHours}::int IS NULL OR created_at >= now() - (${filterSinceHours}::int * INTERVAL '1 hour'))
        AND (${searchPattern}::text IS NULL OR message ILIKE ${searchPattern} ESCAPE '\' OR metadata::text ILIKE ${searchPattern} ESCAPE '\')
      ORDER BY created_at DESC
      LIMIT ${perPage} OFFSET ${offset}
    `;
  } else {
    countRows = await sql`
      SELECT COUNT(*)::int as count
      FROM logging.entries
      WHERE (${filterLevel}::text IS NULL OR level = ${filterLevel})
        AND (${filterSinceHours}::int IS NULL OR created_at >= now() - (${filterSinceHours}::int * INTERVAL '1 hour'))
        AND (${searchPattern}::text IS NULL OR message ILIKE ${searchPattern} ESCAPE '\' OR metadata::text ILIKE ${searchPattern} ESCAPE '\')
    `;

    dataRows = await sql`
      SELECT id, level, source, message, metadata, created_at
      FROM logging.entries
      WHERE (${filterLevel}::text IS NULL OR level = ${filterLevel})
        AND (${filterSinceHours}::int IS NULL OR created_at >= now() - (${filterSinceHours}::int * INTERVAL '1 hour'))
        AND (${searchPattern}::text IS NULL OR message ILIKE ${searchPattern} ESCAPE '\' OR metadata::text ILIKE ${searchPattern} ESCAPE '\')
      ORDER BY created_at DESC
      LIMIT ${perPage} OFFSET ${offset}
    `;
  }

  return {
    entries: dataRows.map((row: DbLogRow) => mapRow(row)),
    total: countRows[0]?.count ?? 0,
  };
};

/** Get all unique source names (for filter dropdown). */
const getSources = async (): Promise<string[]> => {
  const rows = await sql`
    SELECT DISTINCT source FROM logging.entries ORDER BY source
  `;
  return rows.map((row: { source: string }) => row.source);
};

const normalizeSinceHours = (sinceHours: number | undefined): number | null =>
  Number.isFinite(sinceHours) && sinceHours && sinceHours > 0 ? Math.trunc(sinceHours) : null;

const normalizeStatsLimit = (limit: number | undefined): number => Math.min(Math.max(Math.trunc(limit ?? 50), 1), 200);

const logBucketMinutes = (sinceHours: number): number => {
  if (sinceHours <= 1) return 5;
  if (sinceHours <= 24) return 60;
  if (sinceHours <= 168) return 360;
  return 1_440;
};

/**
 * Gap-filled log volume by level for operator charts.
 *
 * The lookback is capped at 30 days and the bucket ladder keeps the response
 * between 12 and 31 points for every window exposed by Gateway Ops.
 */
const timeseries = async (
  options: { source?: string; sources?: string[]; level?: string; search?: string; sinceHours?: number } = {},
): Promise<LogTimeseriesPoint[]> => {
  const sinceHours = Math.min(720, Math.max(1, normalizeSinceHours(options.sinceHours) ?? 24));
  const bucketMinutes = logBucketMinutes(sinceHours);
  const requestedSources = options.source
    ? [options.source]
    : [...new Set((options.sources ?? []).map((value) => value.trim()).filter(Boolean))].slice(0, 100);
  const hasSources = requestedSources.length > 0;
  const sourceLiteral = toPgTextArray(requestedSources);
  const level = options.level && options.level !== "all" ? options.level : null;
  const search = options.search?.trim().slice(0, 200);
  const searchPattern = search ? `%${escapeLikePattern(search)}%` : null;

  return sql<LogTimeseriesPoint[]>`
    WITH bounds AS (
      SELECT
        now() AS end_at,
        now() - (${sinceHours}::int * INTERVAL '1 hour') AS start_at,
        ${bucketMinutes}::int * INTERVAL '1 minute' AS bucket
    ),
    buckets AS (
      SELECT generate_series(
        date_bin(bucket, start_at, TIMESTAMPTZ '1970-01-01 00:00:00+00'),
        date_bin(bucket, end_at, TIMESTAMPTZ '1970-01-01 00:00:00+00'),
        bucket
      ) AS at
      FROM bounds
    ),
    counts AS (
      SELECT
        date_bin(bounds.bucket, entries.created_at, TIMESTAMPTZ '1970-01-01 00:00:00+00') AS at,
        entries.level,
        COUNT(*)::int AS count
      FROM logging.entries AS entries
      CROSS JOIN bounds
      WHERE entries.created_at >= bounds.start_at
        AND entries.created_at <= bounds.end_at
        AND (${hasSources}::boolean = false OR entries.source = ANY(${sourceLiteral}::text[]))
        AND (${level}::text IS NULL OR entries.level = ${level})
        AND (
          ${searchPattern}::text IS NULL
          OR entries.message ILIKE ${searchPattern} ESCAPE '\'
          OR entries.metadata::text ILIKE ${searchPattern} ESCAPE '\'
        )
      GROUP BY at, entries.level
    )
    SELECT
      buckets.at,
      COALESCE(SUM(counts.count) FILTER (WHERE counts.level = 'debug'), 0)::int AS debug,
      COALESCE(SUM(counts.count) FILTER (WHERE counts.level = 'info'), 0)::int AS info,
      COALESCE(SUM(counts.count) FILTER (WHERE counts.level = 'warn'), 0)::int AS warn,
      COALESCE(SUM(counts.count) FILTER (WHERE counts.level = 'error'), 0)::int AS error,
      COALESCE(SUM(counts.count), 0)::int AS total
    FROM buckets
    LEFT JOIN counts USING (at)
    GROUP BY buckets.at
    ORDER BY buckets.at
  `;
};

/** Group log volume by source or level for admin diagnostics. */
const statsBy = async (
  groupBy: LogStatsGroupBy,
  options?: {
    sinceHours?: number;
    limit?: number;
    sources?: string[];
    level?: string;
    search?: string;
  },
): Promise<LogStatsRow[]> => {
  const filterSinceHours = normalizeSinceHours(options?.sinceHours);
  const limit = normalizeStatsLimit(options?.limit);
  const sources = [...new Set((options?.sources ?? []).map((value) => value.trim()).filter(Boolean))].slice(0, 100);
  const hasSources = sources.length > 0;
  const sourceLiteral = toPgTextArray(sources);
  const level = options?.level && options.level !== "all" ? options.level : null;
  const search = options?.search?.trim().slice(0, 200);
  const searchPattern = search ? `%${escapeLikePattern(search)}%` : null;

  if (groupBy === "level") {
    const rows = await sql<{ key: string; count: number }[]>`
      SELECT level as key, COUNT(*)::int as count
      FROM logging.entries
      WHERE (${filterSinceHours}::int IS NULL OR created_at >= now() - (${filterSinceHours}::int * INTERVAL '1 hour'))
        AND (${hasSources}::boolean = false OR source = ANY(${sourceLiteral}::text[]))
        AND (${level}::text IS NULL OR level = ${level})
        AND (
          ${searchPattern}::text IS NULL
          OR message ILIKE ${searchPattern} ESCAPE '\'
          OR metadata::text ILIKE ${searchPattern} ESCAPE '\'
        )
      GROUP BY level
      ORDER BY count DESC, key ASC
      LIMIT ${limit}
    `;
    return rows;
  }

  const rows = await sql<{ key: string; count: number }[]>`
    SELECT source as key, COUNT(*)::int as count
    FROM logging.entries
    WHERE (${filterSinceHours}::int IS NULL OR created_at >= now() - (${filterSinceHours}::int * INTERVAL '1 hour'))
      AND (${hasSources}::boolean = false OR source = ANY(${sourceLiteral}::text[]))
      AND (${level}::text IS NULL OR level = ${level})
      AND (
        ${searchPattern}::text IS NULL
        OR message ILIKE ${searchPattern} ESCAPE '\'
        OR metadata::text ILIKE ${searchPattern} ESCAPE '\'
      )
    GROUP BY source
    ORDER BY count DESC, key ASC
    LIMIT ${limit}
  `;
  return rows;
};

/** Get a single log entry by id. */
const getById = async (id: string): Promise<LogEntry | null> => {
  const rows = await sql<DbLogRow[]>`
    SELECT id, level, source, message, metadata, created_at
    FROM logging.entries
    WHERE id = ${id}::bigint
  `;
  return rows[0] ? mapRow(rows[0]) : null;
};

/** Delete log entries older than the given number of days. */
const cleanup = async (olderThanDays: number): Promise<{ deleted: number }> => {
  const rows = await sql`
    DELETE FROM logging.entries
    WHERE created_at < now() - ${olderThanDays + " days"}::interval
  `;
  return { deleted: rows.count };
};

export type LogSummary = {
  total: number;
  errors24h: number;
  warnings24h: number;
  total24h: number;
  sources: number;
  lastErrorAt: string | null;
};

/**
 * Aggregated stats for the admin dashboard. Single SQL roundtrip, but split
 * into independent subqueries so each one can use `idx_logging_entries_level`
 * and `idx_logging_level_created_at` (composite, see migration). The original
 * `COUNT(*) FILTER (...)` form forced a full-table scan because there was no
 * top-level `WHERE`.
 *
 * `last_error_at::text` because `bun.sql` returns timestamps as `Date` and the
 * `LogSummary.lastErrorAt: string | null` contract expects an ISO-ish string.
 */
const summary = async (): Promise<LogSummary> => {
  const [row] = await sql<
    {
      total: number;
      total_24h: number;
      errors_24h: number;
      warnings_24h: number;
      sources: number;
      last_error_at: string | null;
    }[]
  >`
    SELECT
      (SELECT COUNT(*)::int FROM logging.entries)                                                                AS total,
      (SELECT COUNT(*)::int FROM logging.entries WHERE created_at > now() - interval '24 hours')                 AS total_24h,
      (SELECT COUNT(*)::int FROM logging.entries WHERE level = 'error' AND created_at > now() - interval '24 hours') AS errors_24h,
      (SELECT COUNT(*)::int FROM logging.entries WHERE level = 'warn'  AND created_at > now() - interval '24 hours') AS warnings_24h,
      (SELECT COUNT(*)::int FROM (SELECT DISTINCT source FROM logging.entries) s)                                AS sources,
      (SELECT created_at::text FROM logging.entries WHERE level = 'error' ORDER BY created_at DESC LIMIT 1)      AS last_error_at
  `;
  return {
    total: row?.total ?? 0,
    errors24h: row?.errors_24h ?? 0,
    warnings24h: row?.warnings_24h ?? 0,
    total24h: row?.total_24h ?? 0,
    sources: row?.sources ?? 0,
    lastErrorAt: row?.last_error_at ?? null,
  };
};

/** Admin service object for querying/managing logs. */
export const logging = {
  list,
  getById,
  getSources,
  cleanup,
  summary,
  statsBy,
  timeseries,
  trace,
};
