import { err, fail, ok, type Result } from "@k2b/cloud/server";
import { decryptSecret, logger } from "@k2b/cloud/services";
import { sql } from "bun";
import { METRIC_TYPES, type MetricType, type PulseIngestBatch, type PulseMetric } from "../contracts";

const MAX_SCRAPE_RESPONSE_BYTES = 10 * 1024 * 1024;
const MAX_SCRAPE_SAMPLES = 50_000;
const PROMETHEUS_TYPE_LINE = /^# TYPE\s+(\S+)\s+(\S+)/;
const PROMETHEUS_SAMPLE_LINE =
  /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{([^}]*)\})?\s+(-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?|NaN|Inf|\+Inf|-Inf)(?:\s+\d+)?$/i;
const PROMETHEUS_METRIC_TYPES = new Set<string>(METRIC_TYPES);
const log = logger("pulse:metrics-scraper");

type IngestCounts = { metrics: number; events: number; states: number };
type MetricsScraperDeps = {
  ingestBatch: (params: { baseId: string; sourceId?: string | null; batch: PulseIngestBatch }) => Promise<Result<IngestCounts>>;
};
type MetricsSourceConfig = {
  endpointUrl: string;
  bearerTokenEncrypted: string | null;
};

const markSourceError = async (params: { sourceId: string; message: string | null }): Promise<void> => {
  await sql`
    UPDATE pulse.sources
    SET last_error = ${params.message}, last_error_at = CASE WHEN ${params.message}::text IS NULL THEN NULL ELSE now() END, updated_at = now()
    WHERE id = ${params.sourceId}::uuid
  `;
};

const scrapeCounts = (counts: IngestCounts | undefined): IngestCounts => ({
  metrics: counts?.metrics ?? 0,
  events: counts?.events ?? 0,
  states: counts?.states ?? 0,
});

const logSourceScrapeRecordFailure = (params: { baseId: string; sourceId: string; error: unknown }): void => {
  log.warn("Failed to record Pulse source scrape", {
    baseId: params.baseId,
    sourceId: params.sourceId,
    error: params.error instanceof Error ? params.error.message : String(params.error),
  });
};

const recordFailedSourceScrape = async (params: { baseId: string; sourceId: string; startedAt: Date; message: string }): Promise<void> => {
  await recordSourceScrape({
    baseId: params.baseId,
    sourceId: params.sourceId,
    startedAt: params.startedAt,
    success: false,
    errorMessage: params.message,
  });
  await markSourceError({ sourceId: params.sourceId, message: params.message });
};

const recordIngestResult = async (params: {
  baseId: string;
  sourceId: string;
  startedAt: Date;
  result: Result<IngestCounts>;
}): Promise<void> => {
  if (params.result.ok) {
    await recordSourceScrape({
      baseId: params.baseId,
      sourceId: params.sourceId,
      startedAt: params.startedAt,
      success: true,
      counts: params.result.data,
    });
    await markSourceError({ sourceId: params.sourceId, message: null });
    return;
  }
  await recordFailedSourceScrape({
    baseId: params.baseId,
    sourceId: params.sourceId,
    startedAt: params.startedAt,
    message: params.result.error.message,
  });
};

const recordSourceScrape = async (params: {
  baseId: string;
  sourceId: string;
  startedAt: Date;
  success: boolean;
  counts?: IngestCounts;
  errorMessage?: string | null;
}): Promise<void> => {
  const finishedAt = new Date();
  const durationMs = Math.max(0, finishedAt.getTime() - params.startedAt.getTime());
  const counts = scrapeCounts(params.counts);
  try {
    await sql`
      INSERT INTO pulse.source_scrapes (
        base_id,
        source_id,
        started_at,
        finished_at,
        duration_ms,
        success,
        metrics_count,
        events_count,
        states_count,
        error_message
      )
      VALUES (
        ${params.baseId}::uuid,
        ${params.sourceId}::uuid,
        ${params.startedAt},
        ${finishedAt},
        ${durationMs},
        ${params.success},
        ${counts.metrics},
        ${counts.events},
        ${counts.states},
        ${params.errorMessage ?? null}
      )
    `;
  } catch (error) {
    // Scrape history is diagnostic; never make the scrape itself fail because
    // the audit row could not be persisted.
    logSourceScrapeRecordFailure({ baseId: params.baseId, sourceId: params.sourceId, error });
  }
};

const readScrapeResponseText = async (response: Response): Promise<Result<string>> => {
  if (!response.body) return ok(await response.text());
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  const chunks: string[] = [];
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > MAX_SCRAPE_RESPONSE_BYTES) {
      await reader.cancel();
      return fail(err.badInput(`Metrics endpoint response exceeds ${Math.round(MAX_SCRAPE_RESPONSE_BYTES / 1024 / 1024)} MB`));
    }
    chunks.push(decoder.decode(chunk.value, { stream: true }));
  }
  chunks.push(decoder.decode());
  return ok(chunks.join(""));
};

const unescapePrometheusLabelValue = (value: string): string =>
  value
    .replace(/\\\\/g, "\u0000")
    .replace(/\\"/g, '"')
    .replace(/\\n/g, "\n")
    .replace(/\u0000/g, "\\");

const skipPrometheusLabelSeparators = (labelText: string, index: number): number => {
  let nextIndex = index;
  while (/\s|,/.test(labelText[nextIndex] ?? "")) nextIndex += 1;
  return nextIndex;
};

const readPrometheusLabelKey = (labelText: string, index: number): { key: string; valueStart: number } | null => {
  const keyMatch = labelText.slice(index).match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*"/);
  return keyMatch?.[1] ? { key: keyMatch[1], valueStart: index + keyMatch[0].length } : null;
};

const readEscapedPrometheusLabelChar = (labelText: string, index: number): { value: string; nextIndex: number } | null => {
  if (labelText[index] !== "\\") return null;
  const nextChar = labelText[index + 1];
  return nextChar ? { value: `\\${nextChar}`, nextIndex: index + 2 } : { value: "\\", nextIndex: index + 1 };
};

const readPrometheusLabelValue = (labelText: string, index: number): { value: string; nextIndex: number } => {
  let nextIndex = index;
  let value = "";
  while (nextIndex < labelText.length) {
    const escaped = readEscapedPrometheusLabelChar(labelText, nextIndex);
    if (escaped) {
      value += escaped.value;
      nextIndex = escaped.nextIndex;
      continue;
    }
    const char = labelText[nextIndex]!;
    nextIndex += 1;
    if (char === '"') break;
    value += char;
  }
  return { value, nextIndex };
};

const parsePrometheusLabels = (labelText: string): Record<string, string> => {
  const labels: Record<string, string> = {};
  let index = 0;
  while (index < labelText.length) {
    index = skipPrometheusLabelSeparators(labelText, index);
    const key = readPrometheusLabelKey(labelText, index);
    if (!key) break;
    const value = readPrometheusLabelValue(labelText, key.valueStart);
    labels[key.key] = unescapePrometheusLabelValue(value.value);
    index = value.nextIndex;
    while (/\s/.test(labelText[index] ?? "")) index += 1;
    if (labelText[index] === ",") index += 1;
  }
  return labels;
};

const inferPrometheusMetricType = (name: string, explicit?: MetricType): MetricType => {
  if (explicit) return explicit;
  if (name.endsWith("_bucket")) return "histogram";
  if (name.endsWith("_sum") || name.endsWith("_count") || name.endsWith("_total")) return "counter";
  return "gauge";
};

const isMetricType = (value: string | undefined): value is MetricType => Boolean(value && PROMETHEUS_METRIC_TYPES.has(value));

const parsePrometheusTypeLine = (line: string): { name: string; type: MetricType } | null => {
  const [, name, type] = line.match(PROMETHEUS_TYPE_LINE) ?? [];
  return name && isMetricType(type) ? { name, type } : null;
};

const parsePrometheusValue = (rawValue: string | undefined): number | null => {
  if (!rawValue) return null;
  const value = Number(rawValue.replace("+Inf", "Infinity").replace("Inf", "Infinity"));
  return Number.isFinite(value) ? value : null;
};

const entityIdFromDimensions = (dimensions: Record<string, string>): string | null =>
  dimensions.instance ?? dimensions.host ?? dimensions.node ?? null;

const parsePrometheusSampleLine = (line: string): { name: string; value: number; dimensions: Record<string, string> } | null => {
  const [, name, labelText, rawValue] = line.match(PROMETHEUS_SAMPLE_LINE) ?? [];
  const value = parsePrometheusValue(rawValue);
  if (!name || value === null) return null;
  return {
    name,
    value,
    dimensions: labelText ? parsePrometheusLabels(labelText) : {},
  };
};

const prometheusSampleToMetric = (
  sample: { name: string; value: number; dimensions: Record<string, string> },
  typeByName: Map<string, MetricType>,
): PulseMetric => {
  const entityId = entityIdFromDimensions(sample.dimensions);
  return {
    name: sample.name,
    value: sample.value,
    type: inferPrometheusMetricType(sample.name, typeByName.get(sample.name)),
    entityId,
    entityType: entityId ? "target" : null,
    dimensions: sample.dimensions,
  };
};

const fetchWithTimeout = async (url: string, init: RequestInit, timeoutMs: number): Promise<Response> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
};

const loadMetricsSourceConfig = async (params: { baseId: string; sourceId: string }): Promise<MetricsSourceConfig | null> => {
  const [source] = await sql<{ endpoint_url: string | null; bearer_token_encrypted: string | null }[]>`
    SELECT s.endpoint_url, s.bearer_token_encrypted
    FROM pulse.sources s
    JOIN pulse.bases b ON b.id = s.base_id
    WHERE s.id = ${params.sourceId}::uuid
      AND s.base_id = ${params.baseId}::uuid
      AND s.kind = 'metrics'::pulse.source_kind
      AND s.enabled = TRUE
      AND b.deletion_started_at IS NULL
      AND (
        b.data_clear_started_at IS NULL
        OR b.data_clear_completed_at IS NOT NULL
        OR b.data_clear_failed_at IS NOT NULL
      )
  `;
  return source?.endpoint_url ? { endpointUrl: source.endpoint_url, bearerTokenEncrypted: source.bearer_token_encrypted } : null;
};

const buildMetricsScrapeHeaders = async (bearerTokenEncrypted: string | null): Promise<Record<string, string>> => {
  const headers: Record<string, string> = { "User-Agent": "Pulse/1.0 metrics scraper" };
  if (bearerTokenEncrypted) {
    const token = await decryptSecret<string>(bearerTokenEncrypted);
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  return headers;
};

const fetchPrometheusMetrics = async (source: MetricsSourceConfig): Promise<Result<PulseMetric[]>> => {
  const headers = await buildMetricsScrapeHeaders(source.bearerTokenEncrypted);
  const response = await fetchWithTimeout(source.endpointUrl, { headers }, 15_000);
  if (!response.ok) return fail(err.internal(`Metrics endpoint returned HTTP ${response.status}`));

  const textResult = await readScrapeResponseText(response);
  if (!textResult.ok) return fail(textResult.error);

  const metrics = parsePrometheusMetrics(textResult.data);
  if (metrics.length === 0) return fail(err.badInput("Metrics endpoint returned no parseable samples"));
  if (metrics.length > MAX_SCRAPE_SAMPLES) {
    return fail(err.badInput(`Metrics endpoint returned ${metrics.length} samples, above the ${MAX_SCRAPE_SAMPLES} sample limit`));
  }
  return ok(metrics);
};

const metricsScrapeErrorMessage = (scrapeError: unknown): string => {
  if (scrapeError instanceof DOMException && scrapeError.name === "AbortError") return "Metrics scrape timed out after 15 seconds";
  if (scrapeError instanceof Error) return scrapeError.message;
  return "Metrics scrape failed";
};

export const parsePrometheusMetrics = (text: string): PulseMetric[] => {
  const metrics: PulseMetric[] = [];
  const typeByName = new Map<string, MetricType>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("# TYPE ")) {
      const typeLine = parsePrometheusTypeLine(line);
      if (typeLine) typeByName.set(typeLine.name, typeLine.type);
      continue;
    }
    if (line.startsWith("#")) continue;
    const sample = parsePrometheusSampleLine(line);
    if (sample) metrics.push(prometheusSampleToMetric(sample, typeByName));
  }
  return metrics;
};

export const runMetricsSourceScrape = async (
  params: {
    baseId: string;
    sourceId: string;
  },
  deps: MetricsScraperDeps,
): Promise<Result<IngestCounts>> => {
  const startedAt = new Date();
  const source = await loadMetricsSourceConfig(params);
  if (!source) {
    const message = "Metrics source is missing or disabled";
    await recordFailedSourceScrape({ baseId: params.baseId, sourceId: params.sourceId, startedAt, message });
    return fail(err.notFound("Metrics source"));
  }

  // Endpoint-side failures (unreachable, timeout, HTTP status, unparseable
  // body) are scrape outcomes: recorded on the source and returned as `fail`.
  let metricsResult: Result<PulseMetric[]>;
  try {
    metricsResult = await fetchPrometheusMetrics(source);
  } catch (scrapeError) {
    metricsResult = fail(err.internal(metricsScrapeErrorMessage(scrapeError)));
  }
  if (!metricsResult.ok) {
    await recordFailedSourceScrape({ baseId: params.baseId, sourceId: params.sourceId, startedAt, message: metricsResult.error.message });
    return fail(metricsResult.error);
  }
  const metrics = metricsResult.data.map((metric) => ({ ...metric, sourceId: params.sourceId }));
  const result = await deps.ingestBatch({ baseId: params.baseId, sourceId: params.sourceId, batch: { metrics } });
  // The ingest writer turns database failures into internal errors. Those are
  // infrastructure, not a property of the endpoint: throw so the job retries
  // instead of recording them as a scrape outcome.
  if (!result.ok && result.error.status >= 500) throw new Error(`Metrics ingest failed: ${result.error.message}`);
  await recordIngestResult({ baseId: params.baseId, sourceId: params.sourceId, startedAt, result });
  return result;
};
