import { err, fail, ok, type Result } from "@k2b/cloud/server";
import { decryptSecret, logger } from "@k2b/cloud/services";
import { sql, type TransactionSQL } from "bun";
import type { MetricType, PulseIngestBatch, PulseMetric } from "../contracts";

import { requireBaseActive } from "./access-control";

const MAX_SCRAPE_RESPONSE_BYTES = 10 * 1024 * 1024;
const MAX_SCRAPE_SAMPLES = 50_000;
const PROMETHEUS_TYPE_LINE = /^# TYPE\s+(\S+)\s+(\S+)/;
const PROMETHEUS_SAMPLE_LINE =
  /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{([^}]*)\})?\s+(-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?|NaN|Inf|\+Inf|-Inf)(?:\s+\d+)?$/i;
type PrometheusType = MetricType | "histogram" | "summary" | "untyped";
const PROMETHEUS_METRIC_TYPES = new Set<string>(["gauge", "counter", "histogram", "summary", "untyped"]);
type ParsedMetrics = { metrics: PulseMetric[]; skippedSamples: number };
const log = logger("pulse:metrics-scraper");

type IngestCounts = { metrics: number; events: number; states: number };
type MetricsScraperDeps = {
  database?: typeof sql;
  ingestBatch: (params: {
    baseId: string;
    sourceId: string;
    batch: PulseIngestBatch;
    transaction: TransactionSQL;
  }) => Promise<Result<IngestCounts>>;
};
type MetricsSourceConfig = {
  endpointUrl: string;
  bearerTokenEncrypted: string | null;
};

const markSourceError = async (params: { sourceId: string; message: string | null }, db: TransactionSQL): Promise<void> => {
  await db`
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

const recordFailedSourceScrape = async (
  params: { baseId: string; sourceId: string; startedAt: Date; message: string },
  db: TransactionSQL,
): Promise<void> => {
  await recordSourceScrape(
    {
      baseId: params.baseId,
      sourceId: params.sourceId,
      startedAt: params.startedAt,
      success: false,
      errorMessage: params.message,
    },
    db,
  );
  await markSourceError({ sourceId: params.sourceId, message: params.message }, db);
};

const recordIngestResult = async (
  params: {
    baseId: string;
    sourceId: string;
    startedAt: Date;
    result: Result<IngestCounts>;
    warning?: string | null;
  },
  db: TransactionSQL,
): Promise<void> => {
  if (params.result.ok) {
    await recordSourceScrape(
      {
        baseId: params.baseId,
        sourceId: params.sourceId,
        startedAt: params.startedAt,
        success: true,
        counts: params.result.data,
        errorMessage: params.warning,
      },
      db,
    );
    await markSourceError({ sourceId: params.sourceId, message: params.warning ?? null }, db);
    return;
  }
  await recordFailedSourceScrape(
    {
      baseId: params.baseId,
      sourceId: params.sourceId,
      startedAt: params.startedAt,
      message: params.result.error.message,
    },
    db,
  );
};

const recordSourceScrape = async (
  params: {
    baseId: string;
    sourceId: string;
    startedAt: Date;
    success: boolean;
    counts?: IngestCounts;
    errorMessage?: string | null;
  },
  db: TransactionSQL,
): Promise<void> => {
  const finishedAt = new Date();
  const durationMs = Math.max(0, finishedAt.getTime() - params.startedAt.getTime());
  const counts = scrapeCounts(params.counts);
  try {
    await db.savepoint(async (tx) => {
      await tx`
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
    });
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

const isPrometheusType = (value: string | undefined): value is PrometheusType => Boolean(value && PROMETHEUS_METRIC_TYPES.has(value));
const parsePrometheusTypeLine = (line: string): { name: string; type: PrometheusType } | null => {
  const [, name, type] = line.match(PROMETHEUS_TYPE_LINE) ?? [];
  return name && isPrometheusType(type) ? { name, type } : null;
};

const parsePrometheusValue = (rawValue: string | undefined): number | null => {
  if (!rawValue) return null;
  const value = Number(rawValue.replace("+Inf", "Infinity").replace("Inf", "Infinity"));
  return Number.isFinite(value) ? value : null;
};

const resourceKeyFromDimensions = (dimensions: Record<string, string>): string | null =>
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

const loadMetricsSourceConfig = async (
  params: { baseId: string; sourceId: string },
  db: TransactionSQL,
): Promise<MetricsSourceConfig | null> => {
  const [source] = await db<{ endpoint_url: string | null; bearer_token_encrypted: string | null }[]>`
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

export const fetchPrometheusMetrics = async (source: MetricsSourceConfig, timeoutMs = 15_000): Promise<Result<ParsedMetrics>> => {
  const headers = await buildMetricsScrapeHeaders(source.bearerTokenEncrypted);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(source.endpointUrl, { headers, signal: controller.signal });
    if (!response.ok) {
      await response.body?.cancel();
      return fail(err.internal(`Metrics endpoint returned HTTP ${response.status}`));
    }
    const textResult = await readScrapeResponseText(response);
    if (!textResult.ok) return fail(textResult.error);
    const parsed = parsePrometheusMetrics(textResult.data, new URL(source.endpointUrl).host);
    if (parsed.metrics.length === 0)
      return fail(err.badInput(`Metrics endpoint returned no supported samples (${parsed.skippedSamples} skipped)`));
    if (parsed.metrics.length + parsed.skippedSamples > MAX_SCRAPE_SAMPLES) {
      return fail(err.badInput(`Metrics endpoint exceeds the ${MAX_SCRAPE_SAMPLES} sample limit`));
    }
    return ok(parsed);
  } finally {
    clearTimeout(timeout);
  }
};

const metricsScrapeErrorMessage = (scrapeError: unknown): string => {
  if (scrapeError instanceof DOMException && scrapeError.name === "AbortError") return "Metrics scrape timed out after 15 seconds";
  if (scrapeError instanceof Error) return scrapeError.message;
  return "Metrics scrape failed";
};

export const parsePrometheusMetrics = (text: string, defaultTarget?: string): ParsedMetrics => {
  const metrics: PulseMetric[] = [];
  const typeByName = new Map<string, PrometheusType>();
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  let skippedSamples = 0;
  for (const line of lines) {
    const declaration = parsePrometheusTypeLine(line);
    if (declaration) typeByName.set(declaration.name, declaration.type);
  }
  for (const line of lines) {
    if (!line || line.startsWith("#")) continue;
    const sample = parsePrometheusSampleLine(line);
    if (!sample) {
      skippedSamples += 1;
      continue;
    }
    const family = sample.name.replace(/_(bucket|sum|count)$/, "");
    const type = typeByName.get(sample.name) ?? typeByName.get(family);
    if (type !== "gauge" && type !== "counter") {
      skippedSamples += 1;
      continue;
    }
    const target = resourceKeyFromDimensions(sample.dimensions) ?? defaultTarget;
    metrics.push({ ...sample, type, resource: target ? { type: "target", id: target } : null });
  }
  return { metrics, skippedSamples };
};

const scrapeSource = async (
  params: {
    baseId: string;
    sourceId: string;
    slotTs?: number;
  },
  deps: MetricsScraperDeps,
  db: TransactionSQL,
): Promise<Result<IngestCounts>> => {
  const startedAt = new Date();
  const source = await loadMetricsSourceConfig(params, db);
  if (!source) {
    const message = "Metrics source is missing or disabled";
    await recordFailedSourceScrape({ baseId: params.baseId, sourceId: params.sourceId, startedAt, message }, db);
    return fail(err.notFound("Metrics source"));
  }

  const slot = new Date(params.slotTs ?? Math.floor(startedAt.getTime() / 60_000) * 60_000);
  await db`UPDATE pulse.sources SET last_scrape_slot_at = GREATEST(last_scrape_slot_at, ${slot}) WHERE id = ${params.sourceId}::uuid`;
  // Endpoint-side failures (unreachable, timeout, HTTP status, unparseable
  // body) are scrape outcomes: recorded on the source and returned as `fail`.
  let metricsResult: Result<ParsedMetrics>;
  try {
    metricsResult = await fetchPrometheusMetrics(source);
  } catch (scrapeError) {
    metricsResult = fail(err.internal(metricsScrapeErrorMessage(scrapeError)));
  }
  if (!metricsResult.ok) {
    await recordFailedSourceScrape(
      { baseId: params.baseId, sourceId: params.sourceId, startedAt, message: metricsResult.error.message },
      db,
    );
    return fail(metricsResult.error);
  }
  const metrics = metricsResult.data.metrics.map((metric) => ({ ...metric, ts: startedAt.toISOString() }));
  const result = await deps.ingestBatch({ baseId: params.baseId, sourceId: params.sourceId, batch: { metrics }, transaction: db });
  // The ingest writer turns database failures into internal errors. Those are
  // infrastructure, not a property of the endpoint: throw so the job retries
  // instead of recording them as a scrape outcome.
  if (!result.ok && result.error.status >= 500) throw new Error(`Metrics ingest failed: ${result.error.message}`);
  await recordIngestResult(
    {
      baseId: params.baseId,
      sourceId: params.sourceId,
      startedAt,
      result,
      warning: metricsResult.data.skippedSamples
        ? `${metricsResult.data.skippedSamples} unsupported, invalid or nonfinite samples skipped; only declared gauge/counter families are supported`
        : null,
    },
    db,
  );
  return result;
};

export const runMetricsSourceScrape = async (
  params: { baseId: string; sourceId: string; slotTs?: number },
  deps: MetricsScraperDeps,
): Promise<Result<IngestCounts>> =>
  (deps.database ?? sql).begin(async (tx) => {
    const [claim] = await tx<
      { claimed: boolean }[]
    >`SELECT pg_try_advisory_xact_lock(hashtextextended(${`pulse.scrape:${params.sourceId}`}, 0)) AS claimed`;
    if (!claim?.claimed) return fail(err.conflict("A scrape for this source is already running"));
    const active = await requireBaseActive(params.baseId, tx);
    if (!active.ok) return active;
    return scrapeSource(params, deps, tx);
  });
