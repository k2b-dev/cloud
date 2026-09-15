import { sql } from "bun";

export const PULSE_METRIC_SERIES_LIMIT = 10_000;

type SqlClient = typeof sql;

type SeriesCandidate = {
  metric: string;
  seriesKey: string;
};

export class MetricSeriesLimitError extends Error {
  constructor(
    readonly metric: string,
    readonly limit: number,
  ) {
    super(`Metric ${metric} exceeds the limit of ${limit} series. Move high-cardinality values to events or reduce metric dimensions.`);
  }
}

export const enforceMetricSeriesBudget = async (baseId: string, candidates: SeriesCandidate[], db: SqlClient): Promise<void> => {
  if (candidates.length === 0) return;
  const uniqueCandidates = [
    ...new Map(candidates.map((candidate) => [`${candidate.metric}\u001f${candidate.seriesKey}`, candidate])).values(),
  ];
  // The caller holds the base lifecycle lock, so retained series cannot disappear
  // through catalog cleanup while this transaction updates existing observations.
  const missing = await db<{ metric: string }[]>`
    SELECT DISTINCT input.metric
    FROM jsonb_to_recordset((${JSON.stringify(uniqueCandidates)}::jsonb #>> '{}')::jsonb)
      AS input(metric text,"seriesKey" text)
    JOIN pulse.metric_defs definition ON definition.base_id=${baseId}::uuid AND definition.name=input.metric
    LEFT JOIN pulse.metric_series series ON series.metric_id=definition.id AND series.series_key=input."seriesKey"
    WHERE series.id IS NULL
  `;
  if (missing.length === 0) return;
  const metricNames = missing.map(({ metric }) => metric).sort();

  await db`
    SELECT pg_advisory_xact_lock(hashtextextended(id::text, 0))
    FROM pulse.metric_defs
    WHERE base_id = ${baseId}::uuid
      AND name = ANY(${sql.array(metricNames, "TEXT")})
    ORDER BY id
  `;

  const [violation] = await db<{ metric: string; total_count: number }[]>`
    WITH input AS (
      SELECT DISTINCT metric, "seriesKey"
      FROM jsonb_to_recordset((${JSON.stringify(uniqueCandidates)}::jsonb #>> '{}')::jsonb)
        AS row(metric text, "seriesKey" text)
    ), definitions AS (
      SELECT id, name
      FROM pulse.metric_defs
      WHERE base_id = ${baseId}::uuid
        AND name = ANY(${sql.array(metricNames, "TEXT")})
    ), existing_counts AS (
      SELECT definition.id AS metric_id, definition.name AS metric, COUNT(series.id)::int AS count
      FROM definitions definition
      LEFT JOIN pulse.metric_series series ON series.metric_id = definition.id
      GROUP BY definition.id, definition.name
    ), new_counts AS (
      SELECT definition.id AS metric_id, COUNT(*)::int AS count
      FROM input
      JOIN definitions definition ON definition.name = input.metric
      LEFT JOIN pulse.metric_series series
        ON series.metric_id = definition.id AND series.series_key = input."seriesKey"
      WHERE series.id IS NULL
      GROUP BY definition.id
    )
    SELECT existing.metric, existing.count + COALESCE(incoming.count, 0) AS total_count
    FROM existing_counts existing
    LEFT JOIN new_counts incoming ON incoming.metric_id = existing.metric_id
    WHERE COALESCE(incoming.count, 0) > 0
      AND existing.count + incoming.count > ${PULSE_METRIC_SERIES_LIMIT}
    ORDER BY existing.metric
    LIMIT 1
  `;

  if (violation) throw new MetricSeriesLimitError(violation.metric, PULSE_METRIC_SERIES_LIMIT);
};
