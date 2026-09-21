/** HTTP acceptance probe for an isolated, already running Pulse app.
 * Fixture credentials are read from an owner-only temporary file, never printed.
 * DATABASE_URL must target pulse_load_test. See the production acceptance report.
 */
import { parseArgs } from "node:util";
import { sql } from "bun";
import { z } from "zod";
import { MetricQueryResultSchema } from "../src/api/schemas";

const fixtureSchema = z.object({
  url: z.string().url(),
  cookie: z.string().min(1),
  base: z.object({ id: z.string().uuid(), short_id: z.string().length(6) }),
  sources: z
    .array(
      z.object({
        id: z.string().uuid(),
        token: z.string(),
        kind: z.enum(["server", "website"]),
        index: z.number(),
      }),
    )
    .length(60),
});
const { values: options } = parseArgs({
  args: Bun.argv.slice(2),
  options: { fixture: { type: "string" }, rounds: { type: "string", default: "3" }, help: { type: "boolean", default: false } },
});
if (options.help) {
  console.log(`Usage: bun packages/pulse/scripts/http-load.ts --fixture <path> [--rounds <n>]

HTTP acceptance probe against a running, isolated Pulse app whose DATABASE_URL targets pulse_load_test.

Options:
  --fixture <path>   Owner-only JSON fixture with url, cookie, base and sources (never printed)
  --rounds <n>       Ingest rounds, 3 to 60 (default 3)
  --help             Show this help
`);
  process.exit(0);
}
const path = options.fixture;
if (!path) throw Error("--fixture is required");
const fixture = fixtureSchema.parse(await Bun.file(path).json());
const databaseTarget = new URL(process.env.DATABASE_URL ?? "");
if (!["localhost", "127.0.0.1", "[::1]"].includes(databaseTarget.hostname) || databaseTarget.pathname !== "/pulse_load_test") {
  throw Error("Acceptance probes require loopback pulse_load_test");
}
const [database] = await sql`SELECT current_database() AS name`;
if (database?.name !== "pulse_load_test") throw Error("HTTP load proof requires pulse_load_test");
if (
  fixture.sources.some((source, index) => source.index !== index || source.kind !== (index < 50 ? "server" : "website")) ||
  new Set(fixture.sources.map((source) => source.id)).size !== 60
)
  throw Error("Fixture must contain 50 unique server sources followed by 10 unique website sources with matching indices");
const [basePolicy] =
  await sql`SELECT retention_days FROM pulse.bases WHERE id=${fixture.base.id}::uuid AND short_id=${fixture.base.short_id}`;
if (basePolicy?.retention_days !== 30) throw Error("HTTP load proof requires 30-day raw retention");
const acceptanceFrom = new Date().toISOString();
const origin = new URL(fixture.url);
if (!["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname)) throw Error("HTTP load proof requires a loopback test instance");
const runId = crypto.randomUUID();
const rounds = z.coerce.number().int().min(3).max(60).parse(options.rounds);
const samplesPerServer = 20;
const eventsPerWebsite = 10;
const timings: Record<string, number[]> = {};
const statuses: Record<string, Record<string, number>> = {};
let active = 0,
  peakActive = 0,
  expectedMetrics = 0,
  expectedEvents = 0;
const request = async (phase: string, path: string, init: RequestInit) => {
  const start = performance.now();
  active++;
  peakActive = Math.max(peakActive, active);
  try {
    const response = await fetch(new URL(path, origin), {
      ...init,
      signal: AbortSignal.timeout(60_000),
    });
    const text = await response.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw Error(
        `Non-JSON ${phase} response: status=${response.status}, type=${response.headers.get("content-type")}, bytes=${text.length}`,
      );
    }
    const durationMs = performance.now() - start;
    timings[phase] ??= [];
    timings[phase].push(durationMs);
    if (durationMs >= 5000)
      console.info(
        JSON.stringify({ phase: "slow-request", requestPhase: phase, status: response.status, durationMs, at: new Date().toISOString() }),
      );
    statuses[phase] ??= {};
    const phaseStatuses = statuses[phase];
    phaseStatuses[response.status] = (phaseStatuses[response.status] ?? 0) + 1;
    return { status: response.status, body };
  } finally {
    active--;
  }
};
const counts = async () => {
  const [row] = await sql`SELECT
    (SELECT count(*)::int FROM pulse.metric_samples WHERE base_id=${fixture.base.id}::uuid AND ts>=${acceptanceFrom}::timestamptz) AS metrics,
    (SELECT count(*)::int FROM pulse.events WHERE base_id=${fixture.base.id}::uuid AND ts>=${acceptanceFrom}::timestamptz) AS events`;
  return { metrics: Number(row?.metrics), events: Number(row?.events) };
};
const baseline = await counts();
const ingest = (phase: string, source: (typeof fixture.sources)[number], body: unknown, key: string) =>
  request(phase, "/api/pulse/ingest", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${source.token}`,
      "idempotency-key": key,
    },
    body: JSON.stringify(body),
  });
const batch = (source: (typeof fixture.sources)[number], ts: string, round: number) =>
  source.kind === "server"
    ? {
        metrics: Array.from({ length: samplesPerServer }, (_, metric) => ({
          name: metric === 0 ? "cpu" : `server.metric_${metric}`,
          value: metric === 0 ? round : metric + round,
          ts,
          resource: { type: "server", id: String(source.index) },
        })),
      }
    : {
        events: Array.from({ length: eventsPerWebsite }, (_, event) => ({
          kind: "page.viewed",
          ts,
          actorId: `visitor-${event}`,
          sessionId: `session-${event}`,
          resource: { type: "website", id: String(source.index) },
          dimensions: { path: `/page/${event % 5}` },
          attributes: { request: `${runId}:${round}:${event}` },
        })),
      };
const firstSource = fixture.sources[0]!;
const website = fixture.sources[50]!;
const proofBatch = batch(website, new Date().toISOString(), -1);
const proofKey = `${runId}:replay`;
for (let attempt = 0; attempt < 2; attempt++) {
  const result = await ingest("idempotency", website, proofBatch, proofKey);
  if (result.status !== 200) throw Error(`Idempotent request failed: ${result.status}`);
}
expectedEvents += eventsPerWebsite;
if ((await ingest("conflict", website, { events: [{ kind: "different.event" }] }, proofKey)).status !== 409)
  throw Error("Changed idempotency payload did not conflict");
for (const authorization of [undefined, "Bearer invalid-test-token"]) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (authorization) headers.authorization = authorization;
  const result = await request("unauthorized", "/api/pulse/ingest", {
    method: "POST",
    headers,
    body: JSON.stringify(proofBatch),
  });
  if (result.status !== 401 && result.status !== 403) throw Error(`Invalid token accepted: ${result.status}`);
}
if (
  (await ingest("source-injection", firstSource, { metrics: [{ name: "cpu", value: 1, sourceId: website.id }] }, `${runId}:injection`))
    .status !== 400
)
  throw Error("Source injection was not rejected");
const querySuccessCounts: Record<string, number> = {};
const readQuery = async (phase: string, query: string) => {
  const result = await request(phase, "/api/pulse/query/metric-text", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: fixture.cookie },
    body: JSON.stringify({ baseId: fixture.base.short_id, query }),
  });
  if (result.status === 429 && phase === "burst-query") return null;
  if (result.status !== 200) throw Error(`Query failed: ${result.status}`);
  const parsed = MetricQueryResultSchema.parse(result.body);
  if (parsed.compiled.baseId !== fixture.base.short_id) throw Error("Query returned another base");
  if (phase === "baseline-query") querySuccessCounts[query] = (querySuccessCounts[query] ?? 0) + 1;
  return parsed;
};
let queryPhase = "baseline-query";
let querying = true;
let queryError: unknown;
const dashboardQueries = [
  "metric cpu avg every 1m since 1h",
  "events page.viewed count every day timezone Europe/Berlin since 1h",
  "events page.viewed unique actor every all since 1h",
];
const queryLoop = (async () => {
  while (querying) {
    await Promise.all(dashboardQueries.map((query) => readQuery(queryPhase, query)));
    await Bun.sleep(1000);
  }
})().catch((error) => {
  queryError = error;
  querying = false;
});
const roundDurations: number[] = [];
const started = performance.now();
try {
  for (let round = 0; round < rounds; round++) {
    if (queryError) throw queryError;
    const target = started + round * 60_000;
    while (performance.now() < target) await Bun.sleep(Math.min(1000, target - performance.now()));
    const start = performance.now(),
      ts = new Date().toISOString();
    let cursor = 0;
    await Promise.all(
      Array.from({ length: 8 }, async () => {
        while (cursor < fixture.sources.length) {
          const source = fixture.sources[cursor++]!;
          const result = await ingest("baseline", source, batch(source, ts, round), `${runId}:round:${round}:${source.id}`);
          if (result.status !== 200) throw Error(`Baseline ingest failed: ${result.status}`);
          if (source.kind === "server") expectedMetrics += samplesPerServer;
          else expectedEvents += eventsPerWebsite;
        }
      }),
    );
    const completed = performance.now();
    roundDurations.push(completed - start);
    console.info(
      JSON.stringify({
        phase: "round",
        at: new Date().toISOString(),
        round,
        durationMs: roundDurations.at(-1),
        scheduledLagMs: start - target,
        deadlineMet: completed <= target + 60_000,
      }),
    );
    if (completed > target + 60_000) throw Error(`Fleet cycle ${round} missed its 60-second deadline`);
  }
  if (dashboardQueries.some((query) => !querySuccessCounts[query]))
    throw Error("Baseline did not execute every dashboard query successfully");
  queryPhase = "burst-query";
  // Bounded burst; accepted/rejected requests are counted, then a normal write must recover.
  await Promise.all(
    Array.from({ length: 120 }, async (_, index) => {
      const source = fixture.sources[index % 60]!;
      const result = await ingest(
        "burst",
        source,
        batch(source, new Date(Date.now() + index).toISOString(), 100 + index),
        `${runId}:burst:${index}`,
      );
      if (result.status === 200) {
        if (source.kind === "server") expectedMetrics += samplesPerServer;
        else expectedEvents += eventsPerWebsite;
      } else if (result.status !== 429) throw Error(`Unexpected overload response: ${result.status}`);
    }),
  );
  await Bun.sleep(1500);
  const recovery = await ingest("recovery", website, batch(website, new Date().toISOString(), 999), `${runId}:recovery`);
  if (recovery.status !== 200) throw Error(`Recovery failed: ${recovery.status}`);
  expectedEvents += eventsPerWebsite;
} finally {
  querying = false;
  await queryLoop;
}
if (queryError) throw queryError;
const stored = await counts();
if (stored.metrics - baseline.metrics !== expectedMetrics || stored.events - baseline.events !== expectedEvents)
  throw Error("Accepted and committed counts differ");
const [catalog] = await sql`SELECT
  (SELECT count(*)::int FROM pulse.metric_series WHERE base_id=${fixture.base.id}::uuid) AS series,
  (SELECT count(*)::int FROM pulse.observed_resources WHERE base_id=${fixture.base.id}::uuid) AS resources`;
if (catalog?.series !== 1000 || catalog?.resources !== 60) throw Error("Unexpected fixture series/resource cardinality");
const acceptanceTo = new Date().toISOString();
for (const [aggregation, expected] of [
  ["count", expectedEvents],
  ["unique actor", 100],
  ["unique session", 100],
] as const) {
  const result = await readQuery("correctness", `events page.viewed ${aggregation} every all from ${acceptanceFrom} to ${acceptanceTo}`);
  if (result?.points.length !== 1 || result.points[0]?.value !== expected) throw Error(`Wrong ${aggregation} result`);
}
const [latest] =
  await sql`SELECT sample.value FROM pulse.metric_samples sample JOIN pulse.metric_series series ON series.id=sample.series_id JOIN pulse.metric_defs definition ON definition.id=series.metric_id
  WHERE sample.base_id=${fixture.base.id}::uuid AND series.source_id=${firstSource.id}::uuid AND definition.name='cpu' ORDER BY sample.ts DESC LIMIT 1`;
const metricResult = await readQuery("correctness", "metric cpu latest every 1h since 1h resource server:0");
if (!metricResult?.points.length || metricResult.points.at(-1)?.value !== Number(latest?.value))
  throw Error("Latest CPU result differs from stored fixture value");
const stats = Object.fromEntries(
  Object.entries(timings).map(([phase, values]) => {
    values.sort((a, b) => a - b);
    const percentile = (p: number) => values[Math.max(0, Math.ceil(values.length * p) - 1)];
    return [
      phase,
      {
        count: values.length,
        p50Ms: percentile(0.5),
        p95Ms: percentile(0.95),
        p99Ms: percentile(0.99),
      },
    ];
  }),
);
console.info(
  JSON.stringify(
    {
      runId,
      durationMs: performance.now() - started,
      scenario: {
        servers: 50,
        websites: 10,
        samplesPerServer,
        eventsPerWebsite,
        intervalSeconds: 60,
        rounds,
        rawRetentionDays: 30,
      },
      expectedMetrics,
      expectedEvents,
      committedMetrics: stored.metrics - baseline.metrics,
      committedEvents: stored.events - baseline.events,
      peakActive,
      roundDurations,
      querySuccessCounts,
      catalog,
      statuses,
      stats,
    },
    null,
    2,
  ),
);
await sql.close();
