import { escapeLikePattern, logging, toPgTextArray } from "@k2b/cloud/services";
import { readQuery } from "@k2b/cloud/services/logging/read";
import { err, type PageParams, type Paginated, paginate, tryCatch } from "@k2b/stdlib";
import type { LogLevel } from "./contracts";
import { LOG_LEVELS, LOGS_PER_PAGE, type LogSearch } from "./query";

type LogEntry = Awaited<ReturnType<typeof logging.list>>["entries"][number];

export type LogSearchResult = {
  entries: LogEntry[];
  total: number;
  /** Matching entries per level over the whole result, not only this page. */
  levels: Record<LogLevel, number>;
};

type Row = { id: string | number; level: LogLevel; source: string; message: string; metadata: unknown; created_at: string };

const pattern = (text: string | undefined) => (text ? `%${escapeLikePattern(text)}%` : null);
const textArray = (values: readonly string[] | undefined) => (values && values.length > 0 ? toPgTextArray([...values]) : null);

/**
 * Two statements, as the list had before v2: one count per level for the total and the status row, then one page
 * of rows. Both read through the observability read budget.
 */
const search = async (filter: LogSearch, pagination: { perPage: number; offset: number }): Promise<LogSearchResult> => {
  const until = filter.until ?? null;
  const levels = textArray(filter.levels);
  const sources = textArray(filter.sources);
  const text = pattern(filter.search);
  const request = pattern(filter.request);
  const counts: { level: LogLevel; count: number }[] = await readQuery(
    (db) => db`
      SELECT level, COUNT(*)::int AS count
      FROM logging.entries
      WHERE created_at >= ${filter.since}
        AND (${until}::timestamptz IS NULL OR created_at < ${until}::timestamptz)
        AND (${levels}::text[] IS NULL OR level = ANY(${levels}::text[]))
        AND (${sources}::text[] IS NULL OR source = ANY(${sources}::text[]))
        AND (${text}::text IS NULL OR message ILIKE ${text} ESCAPE '\\' OR metadata::text ILIKE ${text} ESCAPE '\\')
        AND (${request}::text IS NULL OR metadata::text ILIKE ${request} ESCAPE '\\')
      GROUP BY level
    `,
  );
  const byLevel = Object.fromEntries(LOG_LEVELS.map((level) => [level, 0])) as Record<LogLevel, number>;
  let total = 0;
  for (const row of counts) {
    total += row.count;
    if (Object.hasOwn(byLevel, row.level)) byLevel[row.level] = row.count;
  }
  if (total === 0 || pagination.offset >= total) return { entries: [], total, levels: byLevel };
  const rows: Row[] = await readQuery(
    (db) => db`
      SELECT id, level, source, message, metadata, created_at
      FROM logging.entries
      WHERE created_at >= ${filter.since}
        AND (${until}::timestamptz IS NULL OR created_at < ${until}::timestamptz)
        AND (${levels}::text[] IS NULL OR level = ANY(${levels}::text[]))
        AND (${sources}::text[] IS NULL OR source = ANY(${sources}::text[]))
        AND (${text}::text IS NULL OR message ILIKE ${text} ESCAPE '\\' OR metadata::text ILIKE ${text} ESCAPE '\\')
        AND (${request}::text IS NULL OR metadata::text ILIKE ${request} ESCAPE '\\')
      ORDER BY created_at DESC, id DESC
      LIMIT ${pagination.perPage} OFFSET ${pagination.offset}
    `,
  );
  return {
    entries: rows.map((row) => ({
      id: String(row.id),
      level: row.level,
      source: row.source,
      message: row.message,
      metadata: parseMetadata(row.metadata),
      createdAt: new Date(row.created_at).toISOString(),
    })),
    total,
    levels: byLevel,
  };
};

/** Metadata is a JSON object; anything else (a string from an old driver, null) reads as no metadata. */
const parseMetadata = (value: unknown): Record<string, unknown> | null => {
  const parsed = typeof value === "string" ? safeJson(value) : value;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
};
const safeJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

/**
 * Builds the shared paginated response shape from logging service list results.
 */
const toPaginated = <T>(items: T[], total: number, pagination: { page: number; perPage: number }): Paginated<T> => ({
  items,
  page: pagination.page,
  perPage: pagination.perPage,
  total,
  hasNext: pagination.page * pagination.perPage < total,
});

export const loggingService = {
  entry: {
    /** One page of the log list for the state of its address, newest first. */
    search: async (filter: LogSearch, page = 1, perPage = LOGS_PER_PAGE) => search(filter, { perPage, offset: (page - 1) * perPage }),
    list: async (config: {
      pagination?: PageParams;
      filter?: { source?: string; sources?: string[]; level?: string; search?: string; sinceHours?: number };
    }) => {
      const { page, perPage, offset } = paginate(config.pagination);
      const result = await logging.list(
        { page, perPage, offset },
        {
          source: config.filter?.source,
          sources: config.filter?.sources,
          level: config.filter?.level,
          search: config.filter?.search,
          sinceHours: config.filter?.sinceHours,
        },
      );
      return toPaginated<LogEntry>(result.entries, result.total, { page, perPage });
    },
    cleanup: async (config: { days: number }) =>
      tryCatch(
        () => logging.cleanup(config.days),
        (error) => err.internal(error instanceof Error ? error.message : String(error)),
      ),
    get: async (config: { id: string }) => logging.getById(config.id),
  },
  source: {
    list: async (sinceHours = 24) => logging.getSources(sinceHours),
  },
  stats: {
    summary: async () => logging.summary(),
    by: async (config: {
      groupBy: "source" | "level";
      sinceHours?: number;
      limit?: number;
      sources?: string[];
      level?: string;
      search?: string;
    }) => logging.statsBy(config.groupBy, config),
    timeseries: async (config: { sinceHours: number; sources?: string[]; level?: string; search?: string }) => logging.timeseries(config),
  },
};

export type LoggingService = typeof loggingService;
