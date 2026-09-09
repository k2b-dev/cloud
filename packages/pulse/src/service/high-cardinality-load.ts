import type { ServiceAccount } from "@k2b/cloud/contracts";
import { sql } from "bun";
import type { EventQuery, PulseEvent } from "../contracts";
import { newShortId } from "../lib/short-id";
import { migrate } from "../migrate";
import { ingestByApiKey } from "./ingest-writer";
import { queryEventAggregateData } from "./query-execution";
import { runRetentionBatch } from "./runtime";
import { PULSE_APP_ID, PULSE_INGEST_SCOPE, PULSE_SOURCE_RESOURCE_TYPE } from "./source-management";

// Destructive production-scale gate. Point DATABASE_URL at a dedicated
// `pulse_load_test` database, set REDIS_URL, then run `bun run test:load`.
const REQUIRED_DATABASE = "pulse_load_test";
const DEFAULT_EVENT_COUNT = 10_000_000;
const INSERT_BATCH_SIZE = 100_000;
const WRITER_EVENT_COUNT = 500;
const QUERY_RUNS = 5;

type SizeRow = {
  table_bytes: number | string;
  index_bytes: number | string;
  total_bytes: number | string;
};

type CountRow = {
  events: number | string;
  actors: number | string;
  sessions: number | string;
  ip_hashes: number | string;
};

const numeric = (value: number | string | null | undefined): number => Number(value ?? 0);

const requiredEventCount = (): number => {
  const configured = Number(process.env.PULSE_LOAD_EVENT_COUNT ?? DEFAULT_EVENT_COUNT);
  if (!Number.isInteger(configured) || configured < WRITER_EVENT_COUNT) {
    throw new Error(`PULSE_LOAD_EVENT_COUNT must be an integer of at least ${WRITER_EVENT_COUNT}`);
  }
  if (configured < DEFAULT_EVENT_COUNT && process.env.PULSE_LOAD_ALLOW_SMALL !== "1") {
    throw new Error(`Set PULSE_LOAD_ALLOW_SMALL=1 for a smoke run below ${DEFAULT_EVENT_COUNT} events`);
  }
  return configured;
};

const countPulseKeys = async (): Promise<number> => {
  let cursor = "0";
  let count = 0;
  do {
    const result = await Bun.redis.send("SCAN", [cursor, "MATCH", "cloud:pulse:*", "COUNT", "1000"]);
    if (!Array.isArray(result)) throw new Error("Valkey SCAN returned an unexpected response");
    cursor = String(result[0] ?? "0");
    const keys = Array.isArray(result[1]) ? result[1] : [];
    count += keys.length;
  } while (cursor !== "0");
  return count;
};

const percentile95 = (values: number[]): number => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
};

const measureQuery = async <T>(run: () => Promise<T>): Promise<{ value: T; p95Ms: number }> => {
  await run();
  const durations: number[] = [];
  let value = await run();
  for (let index = 0; index < QUERY_RUNS; index += 1) {
    const started = performance.now();
    value = await run();
    durations.push(performance.now() - started);
  }
  return { value, p95Ms: percentile95(durations) };
};

const eventQuery = (baseId: string, aggregation: EventQuery["aggregation"], groupBy: string[]): EventQuery => ({
  kind: "events",
  baseId,
  event: "page.viewed",
  since: "30d",
  dimensions: {},
  bucket: "1d",
  groupBy,
  aggregation,
  limit: 2_000,
});

const writerEvents = (): PulseEvent[] =>
  Array.from({ length: WRITER_EVENT_COUNT }, (_, index) => ({
    kind: index % 5 === 0 ? "qr.opened" : "page.viewed",
    ts: new Date(Date.now() - index * 1_000).toISOString(),
    actorId: `actor-${index % 100_000}`,
    sessionId: `session-${index % 200_000}`,
    correlationId: `request-${index}`,
    dimensions: {
      campaign: `campaign-${index % 20}`,
      country: `country-${index % 20}`,
      channel: index % 5 === 0 ? "qr" : "web",
    },
    attributes: {
      url: `https://example.test/page/${index}`,
      landing_path: `/page/${index}`,
    },
    sensitive: {
      ip_hash: `ip-${index}`,
    },
  }));

const requireDedicatedDatabase = async (): Promise<void> => {
  const [database] = await sql<{ name: string }[]>`SELECT current_database() AS name`;
  if (database?.name !== REQUIRED_DATABASE) {
    throw new Error(`Refusing destructive load test on database ${database?.name ?? "unknown"}; use ${REQUIRED_DATABASE}`);
  }
};

const prepareSchema = async (): Promise<void> => {
  await sql`DROP SCHEMA IF EXISTS pulse CASCADE`.simple();
  await sql`CREATE SCHEMA IF NOT EXISTS auth`.simple();
  await sql`CREATE TABLE IF NOT EXISTS auth.users (id uuid PRIMARY KEY)`.simple();
  await sql`CREATE TABLE IF NOT EXISTS auth.access (id uuid PRIMARY KEY)`.simple();
  await migrate();
  const [timescale] = await sql<{ enabled: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') AS enabled
  `;
  if (!timescale?.enabled) throw new Error("The full Pulse load gate requires TimescaleDB");
};

const seedThroughWriter = async (baseId: string, sourceId: string, sourceShortId: string): Promise<void> => {
  const serviceAccount: ServiceAccount = {
    id: crypto.randomUUID(),
    name: "Pulse load source",
    kind: "resource_bound",
    status: "active",
    delegatedUserId: null,
    appId: PULSE_APP_ID,
    resourceType: PULSE_SOURCE_RESOURCE_TYPE,
    resourceId: sourceShortId,
    createdBy: null,
    createdAt: new Date().toISOString(),
  };
  const batch = { events: writerEvents() };
  const first = await ingestByApiKey({
    serviceAccount,
    scopes: [PULSE_INGEST_SCOPE],
    batch,
    idempotencyKey: "pulse-load-seed",
  });
  if (!first.ok || first.data.events !== WRITER_EVENT_COUNT) throw new Error("Initial idempotent ingest failed");
  const second = await ingestByApiKey({
    serviceAccount,
    scopes: [PULSE_INGEST_SCOPE],
    batch,
    idempotencyKey: "pulse-load-seed",
  });
  if (!second.ok || second.data.events !== WRITER_EVENT_COUNT) throw new Error("Idempotent replay failed");
  const [count] = await sql<{ count: number }[]>`
    SELECT COUNT(*)::int AS count FROM pulse.events WHERE base_id = ${baseId}::uuid
  `;
  if (count?.count !== WRITER_EVENT_COUNT) throw new Error("Idempotent replay inserted duplicate events");
};

const insertScaleRows = async (baseId: string, sourceId: string, eventCount: number): Promise<number> => {
  const started = performance.now();
  for (let first = WRITER_EVENT_COUNT; first < eventCount; first += INSERT_BATCH_SIZE) {
    const last = Math.min(eventCount - 1, first + INSERT_BATCH_SIZE - 1);
    await sql`
      WITH generated AS (
        SELECT
          item,
          CASE WHEN item % 5 = 0 THEN 'qr.opened' ELSE 'page.viewed' END AS kind,
          jsonb_build_object(
            'campaign', 'campaign-' || (item % 20),
            'country', 'country-' || (item % 20),
            'channel', CASE WHEN item % 5 = 0 THEN 'qr' ELSE 'web' END
          ) AS dimensions
        FROM generate_series(${first}::bigint, ${last}::bigint) AS item
      )
      INSERT INTO pulse.events (
        base_id, source_id, ts, kind, actor_id, session_id, correlation_id,
        dimensions_hash, dimensions, attributes, sensitive, payload
      )
      SELECT
        ${baseId}::uuid,
        ${sourceId}::uuid,
        now() - make_interval(secs => (item % 2592000)::int),
        kind,
        'actor-' || (item % 100000),
        'session-' || (item % 200000),
        'request-' || item,
        md5(dimensions::text),
        dimensions,
        jsonb_build_object(
          'url', 'https://example.test/page/' || item,
          'landing_path', '/page/' || item
        ),
        jsonb_build_object('ip_hash', md5('ip-' || (item % 1000000))),
        '{}'::jsonb
      FROM generated
    `;
  }
  return performance.now() - started;
};

const runRetention = async (
  baseId: string,
): Promise<{ durationMs: number; batches: number; remaining: number; remainingSensitive: number }> => {
  const started = performance.now();
  let batches = 0;
  while (batches < 1_000) {
    const result = await runRetentionBatch(baseId);
    batches += 1;
    if (result.done) break;
  }
  if (batches >= 1_000) throw new Error("Retention did not converge within 1,000 batches");
  const [remaining] = await sql<{ count: number | string; sensitive: number | string }[]>`
    SELECT
      COUNT(*) AS count,
      COUNT(*) FILTER (WHERE sensitive <> '{}'::jsonb) AS sensitive
    FROM pulse.events
    WHERE base_id = ${baseId}::uuid
  `;
  return {
    durationMs: performance.now() - started,
    batches,
    remaining: numeric(remaining?.count),
    remainingSensitive: numeric(remaining?.sensitive),
  };
};

const main = async (): Promise<void> => {
  const eventCount = requiredEventCount();
  await requireDedicatedDatabase();
  const valkeyBefore = await countPulseKeys();
  await prepareSchema();

  const baseId = crypto.randomUUID();
  const sourceId = crypto.randomUUID();
  const sourceShortId = newShortId();
  await sql`
    INSERT INTO pulse.bases (id, short_id, name, retention_days, rollup_retention_days, sensitive_retention_hours)
    VALUES (${baseId}::uuid, ${newShortId()}, 'High-cardinality load', 1, 365, 1)
  `;
  await sql`
    INSERT INTO pulse.sources (id, short_id, base_id, kind, name)
    VALUES (${sourceId}::uuid, ${sourceShortId}, ${baseId}::uuid, 'http_ingest'::pulse.source_kind, 'Load source')
  `;

  try {
    await seedThroughWriter(baseId, sourceId, sourceShortId);
    const insertDurationMs = await insertScaleRows(baseId, sourceId, eventCount);
    const [counts] = await sql<CountRow[]>`
      SELECT
        COUNT(*) AS events,
        COUNT(DISTINCT actor_id) AS actors,
        COUNT(DISTINCT session_id) AS sessions,
        COUNT(DISTINCT sensitive ->> 'ip_hash') AS ip_hashes
      FROM pulse.events
      WHERE base_id = ${baseId}::uuid
    `;
    const [size] = await sql<SizeRow[]>`
      SELECT
        SUM(table_bytes)::bigint AS table_bytes,
        SUM(index_bytes)::bigint AS index_bytes,
        SUM(total_bytes)::bigint AS total_bytes
      FROM hypertable_detailed_size('pulse.events'::regclass)
    `;
    const grouped = await measureQuery(async () => {
      const result = await queryEventAggregateData(eventQuery(baseId, "count", ["campaign"]));
      if (!result.ok) throw new Error(result.error.message);
      return result.data;
    });
    const uniqueActors = await measureQuery(async () => {
      const result = await queryEventAggregateData(eventQuery(baseId, "unique_actor", []));
      if (!result.ok) throw new Error(result.error.message);
      return result.data;
    });
    const [catalog] = await sql<{ fields: number; resources: number; series: number; idempotency: number }[]>`
      SELECT
        (SELECT COUNT(*)::int FROM pulse.signal_fields WHERE base_id = ${baseId}::uuid) AS fields,
        (SELECT COUNT(*)::int FROM pulse.observed_resources WHERE base_id = ${baseId}::uuid) AS resources,
        (SELECT COUNT(*)::int FROM pulse.metric_series WHERE base_id = ${baseId}::uuid) AS series,
        (SELECT COUNT(*)::int FROM pulse.ingest_idempotency WHERE source_id = ${sourceId}::uuid) AS idempotency
    `;

    if (numeric(counts?.events) !== eventCount) throw new Error("Event row count does not match the requested load");
    if (numeric(counts?.actors) < 100_000 || numeric(counts?.sessions) < 100_000) throw new Error("Identity cardinality is too low");
    if (numeric(counts?.ip_hashes) < Math.min(eventCount, 1_000_000)) throw new Error("Attribute cardinality is too low");
    if (catalog?.fields !== 12 || catalog.resources !== 0 || catalog.series !== 0 || catalog.idempotency !== 1) {
      throw new Error("Bounded catalog, resource, series, or idempotency invariant failed");
    }
    if (grouped.p95Ms > 30_000 || uniqueActors.p95Ms > 30_000) throw new Error("Event aggregate query exceeded 30 seconds");

    const retention = await runRetention(baseId);
    if (retention.remaining <= 0 || retention.remaining >= eventCount) throw new Error("Retention did not preserve only the active window");
    if (retention.remainingSensitive <= 0 || retention.remainingSensitive >= retention.remaining) {
      throw new Error("Sensitive retention did not preserve only the shorter active window");
    }
    const valkeyAfter = await countPulseKeys();
    if (valkeyAfter !== valkeyBefore) throw new Error("Pulse load changed Valkey key count");

    console.log(
      JSON.stringify(
        {
          eventCount,
          actors: numeric(counts?.actors),
          sessions: numeric(counts?.sessions),
          ipHashes: numeric(counts?.ip_hashes),
          insertDurationMs,
          ingestEventsPerSecond: Math.round((eventCount / insertDurationMs) * 1_000),
          tableBytes: numeric(size?.table_bytes),
          indexBytes: numeric(size?.index_bytes),
          totalBytes: numeric(size?.total_bytes),
          groupedCountP95Ms: grouped.p95Ms,
          uniqueActorP95Ms: uniqueActors.p95Ms,
          retention,
          valkeyKeysBefore: valkeyBefore,
          valkeyKeysAfter: valkeyAfter,
        },
        null,
        2,
      ),
    );
  } finally {
    await sql`DROP SCHEMA IF EXISTS pulse CASCADE`.simple();
  }
};

await main();
