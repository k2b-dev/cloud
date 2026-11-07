import { sql } from "../../runtime/clients";
import { redactLinkTokens } from "./redaction";
import type { TraceCategory } from "./trace";

// Powers of two in milliseconds: a bounded histogram, including Sync's 30s
// acknowledgement budget. Percentiles are bucket upper bounds, never exact samples.
export const RUN_DURATION_BOUNDS = [...Array.from({ length: 32 }, (_, index) => 2 ** index), Number.POSITIVE_INFINITY];
export const RUN_MINUTE_MS = 60_000;
// Same cardinality budget as the Sync observer: never buffer one entry per run.
const PENDING_LIMIT = 1024;

export type RunMinute = {
  bucket: Date;
  lastEndedAt: Date;
  source: string;
  appId: string;
  category: TraceCategory;
  name: string;
  count: number;
  totalDurationMs: number;
  maxDurationMs: number;
  durations: number[];
};

export const createRunRollupBuffer = (write: (rows: RunMinute[]) => Promise<void>) => {
  let pending = new Map<string, RunMinute>();
  let writing: Promise<void> | undefined;
  let reportedOverflow = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = async (): Promise<void> => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (writing) await writing;
    if (pending.size === 0) return;
    const rows = [...pending.values()];
    pending = new Map();
    reportedOverflow = false;
    // Diagnostics must never replay domain work. An ambiguous write is not
    // retried: that could double the counts. The next minute recovers normally.
    writing = write(rows).finally(() => {
      writing = undefined;
    });
    await writing;
  };
  return {
    add(input: { at: Date; source: string; appId: string; category: TraceCategory; name: string; durationMs: number }) {
      input = { ...input, source: redactLinkTokens(input.source), name: redactLinkTokens(input.name) };
      const bucket = new Date(Math.floor(input.at.getTime() / RUN_MINUTE_MS) * RUN_MINUTE_MS);
      const key = JSON.stringify([bucket.getTime(), input.source, input.appId, input.category, input.name]);
      let row = pending.get(key);
      if (!row) {
        if (pending.size >= PENDING_LIMIT) {
          if (!reportedOverflow) console.error("[logging:trace] minute aggregate buffer full; dropping diagnostic count");
          reportedOverflow = true;
          return;
        }
        row = {
          ...input,
          bucket,
          lastEndedAt: input.at,
          count: 0,
          totalDurationMs: 0,
          maxDurationMs: 0,
          durations: RUN_DURATION_BOUNDS.map(() => 0),
        };
        pending.set(key, row);
      }
      const duration = Math.max(0, input.durationMs);
      row.count++;
      if (input.at > row.lastEndedAt) row.lastEndedAt = input.at;
      row.totalDurationMs += duration;
      row.maxDurationMs = Math.max(row.maxDurationMs, duration);
      const index = RUN_DURATION_BOUNDS.findIndex((bound) => bound >= duration);
      row.durations[index < 0 ? RUN_DURATION_BOUNDS.length - 1 : index]!++;
      if (!timer) {
        timer = setTimeout(() => void flush().catch(reportRunRollupError), RUN_MINUTE_MS);
        timer.unref();
      }
    },
    flush,
  };
};

export const reportRunRollupError = (error: unknown): void => {
  console.error("[logging:trace] minute aggregate write failed; counts lost:", error instanceof Error ? error.message : String(error));
};

export const runRollups = createRunRollupBuffer(async (rows) => {
  const payload = JSON.stringify(
    rows.map((row) => ({
      bucket: row.bucket.toISOString(),
      last_ended_at: row.lastEndedAt.toISOString(),
      source: redactLinkTokens(row.source),
      app_id: row.appId,
      category: row.category,
      name: redactLinkTokens(row.name),
      run_count: row.count,
      total_duration_ms: row.totalDurationMs,
      max_duration_ms: row.maxDurationMs,
      durations: row.durations,
    })),
  );
  await sql`
    INSERT INTO logging.run_minutes (bucket, last_ended_at, source, app_id, category, name, run_count, total_duration_ms, max_duration_ms, durations)
    SELECT bucket, last_ended_at, source, app_id, category, name, run_count, total_duration_ms, max_duration_ms, durations
    FROM jsonb_to_recordset((${payload}::text)::jsonb) AS r(
      bucket timestamptz, last_ended_at timestamptz, source text, app_id text, category text, name text,
      run_count bigint, total_duration_ms float8, max_duration_ms float8, durations bigint[])
    ON CONFLICT (bucket, source, app_id, category, name) DO UPDATE SET
      run_count = logging.run_minutes.run_count + EXCLUDED.run_count,
      last_ended_at = GREATEST(logging.run_minutes.last_ended_at, EXCLUDED.last_ended_at),
      total_duration_ms = logging.run_minutes.total_duration_ms + EXCLUDED.total_duration_ms,
      max_duration_ms = GREATEST(logging.run_minutes.max_duration_ms, EXCLUDED.max_duration_ms),
      durations = ARRAY(SELECT a + b FROM unnest(logging.run_minutes.durations, EXCLUDED.durations) AS bin(a, b))
  `;
});

export const runPercentile = (durations: number[], percentile: number): number | null => {
  const total = durations.reduce((sum, value) => sum + value, 0);
  if (!total) return null;
  let count = 0;
  for (const [index, value] of durations.entries()) {
    count += value;
    if (count >= Math.ceil(total * percentile)) {
      const bound = RUN_DURATION_BOUNDS[index];
      return bound !== undefined && Number.isFinite(bound) ? bound : null;
    }
  }
  return null;
};
