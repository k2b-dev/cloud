import { err, fail, ok, type Result } from "@k2b/cloud/server";
import { decryptSecret, logger } from "@k2b/cloud/services";
import { sql } from "bun";
import type { MetricType, PulseIngestBatch, PulseMetric } from "../contracts";
import { metricFamilyIncluded } from "../metric-filters";
import { requireBaseWritable } from "./access-control";
import type { IngestResult } from "./ingest-writer";
import { type MetricsHttpDeps, requestMetrics } from "./metrics-http";
import { baseScrapeAllowlist } from "./scrape-target";

const MAX_SCRAPE_SAMPLES = 50_000;
const PROMETHEUS_TYPE_LINE = /^# TYPE\s+(\S+)\s+(\S+)/;
const PROMETHEUS_SAMPLE_LINE =
  /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{([^}]*)\})?\s+(-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?|NaN|Inf|\+Inf|-Inf)(?:\s+\d+)?$/i;
type PrometheusType = MetricType | "histogram" | "summary" | "untyped";
const PROMETHEUS_METRIC_TYPES = new Set<string>(["gauge", "counter", "histogram", "summary", "untyped"]);
export type RefusedHistogram = { family: string; reason: "missing_inf" | "not_cumulative" | "count_mismatch" | "negative_sum" };
type ParsedMetrics = {
  metrics: PulseMetric[];
  skippedSamples: number;
  skippedSummaries: number;
  refusedHistograms: RefusedHistogram[];
  sampleCount: number;
};
const log = logger("pulse:metrics-scraper");

type IngestCounts = { metrics: number; events: number; states: number };
type MetricsScraperDeps = {
  database?: typeof sql;
  clock?: () => Date;
  http?: MetricsHttpDeps;
  ingestBatch: (params: { baseId: string; sourceId: string; batch: PulseIngestBatch }) => Promise<IngestResult>;
};
type MetricsSourceConfig = {
  endpointUrl: string;
  bearerTokenEncrypted: string | null;
  metricFilters?: string[];
};

const markSourceError = async (
  params: { sourceId: string; message: string | null },
  db: typeof sql,
  clock: () => Date = () => new Date(),
): Promise<void> => {
  const now = clock();
  await db`
    UPDATE pulse.sources
    SET last_error = ${params.message}, last_error_at = CASE WHEN ${params.message}::text IS NULL THEN NULL ELSE ${now}::timestamptz END, updated_at = ${now}
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
  db: typeof sql,
  clock: () => Date = () => new Date(),
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
    clock,
  );
  await markSourceError({ sourceId: params.sourceId, message: params.message }, db, clock);
};

const recordIngestResult = async (
  params: {
    baseId: string;
    sourceId: string;
    startedAt: Date;
    result: IngestResult;
    warning?: string | null;
  },
  db: typeof sql,
  clock: () => Date = () => new Date(),
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
      clock,
    );
    await markSourceError({ sourceId: params.sourceId, message: params.warning ?? null }, db, clock);
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
    clock,
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
  db: typeof sql,
  clock: () => Date = () => new Date(),
): Promise<void> => {
  const finishedAt = clock();
  const durationMs = Math.max(0, finishedAt.getTime() - params.startedAt.getTime());
  const counts = scrapeCounts(params.counts);
  try {
    await db`
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
  db: typeof sql,
): Promise<MetricsSourceConfig | null> => {
  const [source] = await db<{ endpoint_url: string | null; bearer_token_encrypted: string | null; config: { metricFilters?: string[] } }[]>`
    SELECT s.endpoint_url, s.bearer_token_encrypted, s.config
    FROM pulse.sources s
    JOIN pulse.bases b ON b.id = s.base_id
    WHERE s.id = ${params.sourceId}::uuid
      AND s.base_id = ${params.baseId}::uuid
      AND s.kind = 'metrics'::pulse.source_kind
      AND s.enabled = TRUE
      AND EXISTS(SELECT 1 FROM pulse.base_stores store WHERE store.base_id=b.id AND store.state='active' AND store.write_block_reason IS NULL) AND b.deletion_started_at IS NULL
      AND (
        b.data_clear_started_at IS NULL
        OR b.data_clear_completed_at IS NOT NULL
      )
  `;
  return source?.endpoint_url
    ? {
        endpointUrl: source.endpoint_url,
        bearerTokenEncrypted: source.bearer_token_encrypted,
        metricFilters: source.config.metricFilters ?? [],
      }
    : null;
};

const buildMetricsScrapeHeaders = async (bearerTokenEncrypted: string | null): Promise<Record<string, string>> => {
  const headers: Record<string, string> = { "User-Agent": "Pulse/1.0 metrics scraper" };
  if (bearerTokenEncrypted) {
    const token = await decryptSecret<string>(bearerTokenEncrypted);
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  return headers;
};

export const fetchPrometheusMetrics = async (
  source: MetricsSourceConfig,
  timeoutMs = 15_000,
  deps: MetricsHttpDeps = {},
): Promise<Result<ParsedMetrics>> => {
  const headers = await buildMetricsScrapeHeaders(source.bearerTokenEncrypted);
  const response = await requestMetrics(source.endpointUrl, headers.Authorization, timeoutMs, deps);
  if (!response.ok) return response;
  const parsed = parsePrometheusMetrics(response.data, new URL(source.endpointUrl).host, source.metricFilters);
  if (parsed.sampleCount > MAX_SCRAPE_SAMPLES) return fail(err.badInput(`Metrics endpoint exceeds the ${MAX_SCRAPE_SAMPLES} sample limit`));
  // A scrape that keeps nothing is a visible source error, never a silent success.
  if (parsed.metrics.length === 0 && parsed.refusedHistograms.length === 0)
    return fail(
      err.badInput(
        source.metricFilters?.length
          ? `No metric family on the endpoint matches the metric filters (${parsed.skippedSamples} skipped)`
          : `Metrics endpoint returned no supported samples (${parsed.skippedSamples} skipped)`,
      ),
    );
  return ok(parsed);
};

const metricsScrapeErrorMessage = (scrapeError: unknown): string => {
  if (scrapeError instanceof DOMException && scrapeError.name === "AbortError") return "Metrics scrape timed out after 15 seconds";
  return "Metrics scrape failed";
};

type HistogramSample = NonNullable<ReturnType<typeof parsePrometheusSampleLine>>;
const histogramReason = (family: string, samples: HistogramSample[]): RefusedHistogram["reason"] | null => {
  const groups = new Map<string, HistogramSample[]>();
  for (const sample of samples) {
    const labels = Object.entries(sample.dimensions)
      .filter(([key]) => key !== "le")
      .sort(([a], [b]) => a.localeCompare(b));
    const key = JSON.stringify(labels);
    const group = groups.get(key) ?? [];
    group.push(sample);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    const buckets = group.filter((s) => s.name === `${family}_bucket`);
    const inf = buckets.find((s) => s.dimensions.le === "+Inf");
    if (!inf) return "missing_inf";
    const bound = (s: HistogramSample) => (s.dimensions.le === "+Inf" ? Infinity : Number(s.dimensions.le));
    if (buckets.some((s) => (s.dimensions.le !== "+Inf" && !Number.isFinite(bound(s))) || s.value < 0)) return "not_cumulative";
    buckets.sort((a, b) => bound(a) - bound(b));
    if (buckets.some((s, i) => i > 0 && s.value < buckets[i - 1]!.value)) return "not_cumulative";
    if (group.some((s) => s.name === `${family}_count` && s.value !== inf.value)) return "count_mismatch";
    if (group.some((s) => s.name === `${family}_sum` && s.value < 0)) return "negative_sum";
  }
  return null;
};

export const parsePrometheusMetrics = (text: string, defaultTarget?: string, filters: readonly string[] = []): ParsedMetrics => {
  const metrics: PulseMetric[] = [];
  const typeByName = new Map<string, PrometheusType>();
  const histograms = new Map<string, HistogramSample[]>();
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  let skippedSamples = 0,
    skippedSummaries = 0,
    sampleCount = 0;
  for (const line of lines) {
    const declaration = parsePrometheusTypeLine(line);
    if (declaration) typeByName.set(declaration.name, declaration.type);
  }
  const append = (sample: HistogramSample, type: MetricType) => {
    const target = resourceKeyFromDimensions(sample.dimensions) ?? defaultTarget;
    metrics.push({ ...sample, type, resource: target ? { type: "target", id: target } : null });
  };
  for (const line of lines) {
    if (!line || line.startsWith("#")) continue;
    const name = line.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)/)?.[1] ?? "";
    const parent = name.replace(/_(bucket|sum|count)$/, "");
    const family = ["histogram", "summary"].includes(typeByName.get(parent) ?? "") ? parent : name;
    // Filter families before any sample budget or cardinality decision.
    if (!metricFamilyIncluded(family, filters)) continue;
    sampleCount++;
    const type = typeByName.get(family);
    if (type === "summary") {
      skippedSummaries++;
      skippedSamples++;
      continue;
    }
    const sample = parsePrometheusSampleLine(line);
    if (!sample) {
      skippedSamples++;
      continue;
    }
    if (type === "histogram") {
      const values = histograms.get(family) ?? [];
      if (sample.name === `${family}_bucket` && sample.dimensions.le !== "+Inf" && sample.dimensions.le !== undefined) {
        sample.dimensions.le = String(Number(sample.dimensions.le));
      }
      values.push(sample);
      histograms.set(family, values);
    } else if (type === "gauge" || type === "counter") append(sample, type);
    else skippedSamples++;
  }
  const refusedHistograms: RefusedHistogram[] = [];
  for (const [family, samples] of histograms) {
    const reason = histogramReason(family, samples);
    if (reason) {
      if (refusedHistograms.length < 20) refusedHistograms.push({ family, reason });
      skippedSamples += samples.length;
    } else for (const sample of samples) append(sample, "counter");
  }
  return { metrics, skippedSamples, skippedSummaries, refusedHistograms, sampleCount };
};

const scrapeSource = async (
  params: {
    baseId: string;
    sourceId: string;
    slotTs?: number;
  },
  deps: MetricsScraperDeps,
  db: typeof sql,
): Promise<Result<IngestCounts>> => {
  const clock = deps.clock ?? (() => new Date());
  const startedAt = clock();
  const source = await loadMetricsSourceConfig(params, db);
  if (!source) {
    const message = "Metrics source is missing or disabled";
    await recordFailedSourceScrape({ baseId: params.baseId, sourceId: params.sourceId, startedAt, message }, db, clock);
    return fail(err.notFound("Metrics source"));
  }

  const slot = new Date(params.slotTs ?? Math.floor(startedAt.getTime() / 60_000) * 60_000);

  // Endpoint-side failures (unreachable, timeout, HTTP status, unparseable
  // body) are scrape outcomes: recorded on the source and returned as `fail`.
  let metricsResult: Result<ParsedMetrics>;
  try {
    metricsResult = await fetchPrometheusMetrics(source, 15_000, {
      ...deps.http,
      readAllowlist: () => baseScrapeAllowlist(params.baseId, db),
    });
  } catch (scrapeError) {
    metricsResult = fail(err.internal(metricsScrapeErrorMessage(scrapeError)));
  }
  if (!metricsResult.ok) {
    await db`UPDATE pulse.sources SET refused_histograms='[]'::jsonb,skipped_summaries=0 WHERE id=${params.sourceId}::uuid`;
    await db`UPDATE pulse.sources SET last_scrape_slot_at = GREATEST(last_scrape_slot_at, ${slot}) WHERE id = ${params.sourceId}::uuid`;
    await recordFailedSourceScrape(
      { baseId: params.baseId, sourceId: params.sourceId, startedAt, message: metricsResult.error.message },
      db,
      clock,
    );
    return fail(metricsResult.error);
  }
  const metrics = metricsResult.data.metrics.map((metric) => ({ ...metric, ts: startedAt.toISOString() }));
  const result = metrics.length
    ? await deps.ingestBatch({ baseId: params.baseId, sourceId: params.sourceId, batch: { metrics } })
    : ok({ metrics: 0, events: 0, states: 0 });
  await db`UPDATE pulse.sources SET refused_histograms=(${JSON.stringify(metricsResult.data.refusedHistograms)}::jsonb #>> '{}')::jsonb,skipped_summaries=${metricsResult.data.skippedSummaries} WHERE id=${params.sourceId}::uuid`;
  await db`UPDATE pulse.sources SET last_scrape_slot_at = GREATEST(last_scrape_slot_at, ${slot}) WHERE id = ${params.sourceId}::uuid`;
  await recordIngestResult(
    {
      baseId: params.baseId,
      sourceId: params.sourceId,
      startedAt,
      result,
      warning: metricsResult.data.skippedSamples
        ? `${metricsResult.data.skippedSamples} unsupported, refused or nonfinite samples skipped; declared gauge, counter and valid histogram families are supported`
        : null,
    },
    db,
    clock,
  );
  return result.ok
    ? ok(result.data)
    : fail({
        code: result.error.code,
        message: result.error.message,
        status: result.error.status === 503 || result.error.status === 429 ? 500 : result.error.status,
      });
};

export const runMetricsSourceScrape = async (
  params: { baseId: string; sourceId: string; slotTs?: number },
  deps: MetricsScraperDeps,
): Promise<Result<IngestCounts>> => {
  const db = deps.database ?? sql;
  const active = await requireBaseWritable(params.baseId, db);
  if (!active.ok) return active;
  const now = (deps.clock ?? (() => new Date()))();
  // The fetch is bounded to 15s and ingest to its existing 10-minute lease.
  // Commit the claim before either operation can need another pooled connection.
  const leaseUntil = new Date(now.getTime() + 15_000 + 10 * 60_000);
  const [claim] = await db`UPDATE pulse.sources SET scrape_lease_until=${leaseUntil}
    WHERE id=${params.sourceId}::uuid AND base_id=${params.baseId}::uuid
      AND (scrape_lease_until IS NULL OR scrape_lease_until<=${now}) RETURNING id`;
  if (!claim) return fail(err.conflict("A scrape for this source is already running"));
  try {
    return await scrapeSource(params, deps, db);
  } finally {
    // An expired claimant must never release a newer scrape's lease.
    await db`UPDATE pulse.sources SET scrape_lease_until=NULL WHERE id=${params.sourceId}::uuid AND scrape_lease_until=${leaseUntil}`;
  }
};
