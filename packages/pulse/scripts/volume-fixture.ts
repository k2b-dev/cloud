/** Prepare accumulated SQL volume, never report this as HTTP ingest throughput.
 * Only the disposable pulse_load_test database is accepted. Existing samples are preserved.
 * Run once per fixture, without concurrent ingestion/retention; a failed run requires a new disposable fixture.
 */
import { createHash } from "node:crypto";
import { sql } from "bun";
import { z } from "zod";
import { requireBaseActive } from "../src/service/access-control";
import { markMetricHoursDirty, runHourlyRollup } from "../src/service/metric-rollups";

const HOURS = 720;
const fixturePath = process.env.PULSE_LOAD_FIXTURE;
if (!fixturePath) throw Error("PULSE_LOAD_FIXTURE is required");
const fixture = z
  .object({
    url: z.string().url(),
    base: z.object({ id: z.string().uuid(), short_id: z.string().length(6) }),
    sources: z.array(z.object({ id: z.string().uuid(), kind: z.enum(["server", "website"]), index: z.number().int() })).length(60),
  })
  .parse(await Bun.file(fixturePath).json());
if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(fixture.url).hostname)) throw Error("Fixture must be loopback");
const databaseTarget = new URL(process.env.DATABASE_URL ?? "");
if (!["localhost", "127.0.0.1", "[::1]"].includes(databaseTarget.hostname) || databaseTarget.pathname !== "/pulse_load_test") {
  throw Error("Acceptance probes require loopback pulse_load_test");
}
const [database] = await sql`SELECT current_database() AS name`;
if (database?.name !== "pulse_load_test") throw Error("Volume fixture requires disposable pulse_load_test");
// Bound a stalled fixture operation; configure these only on the disposable database before opening this process.
const budgets = await sql<
  { name: string; setting: string }[]
>`SELECT name,setting FROM pg_settings WHERE name IN ('statement_timeout','lock_timeout')`;
for (const name of ["statement_timeout", "lock_timeout"]) {
  const value = Number(budgets.find((row) => row.name === name)?.setting);
  const maximum = name === "statement_timeout" ? 120_000 : 30_000;
  if (!(value > 0 && value <= maximum))
    throw Error(`Set disposable database ${name} between 1 and ${maximum} milliseconds before running the fixture`);
}

if (
  new Set(fixture.sources.map((source) => source.id)).size !== 60 ||
  fixture.sources.some((source, index) => source.index !== index || source.kind !== (index < 50 ? "server" : "website"))
)
  throw Error("Expected 50 server sources then 10 website sources with unique IDs and ordered indices");
const baseId = fixture.base.id;
const [policy] = await sql`SELECT retention_days FROM pulse.bases WHERE id=${baseId}::uuid AND short_id=${fixture.base.short_id}`;
if (policy?.retention_days !== 30) throw Error("Fixture requires 30-day raw retention");
const [extension] = await sql`SELECT EXISTS(SELECT 1 FROM pg_extension WHERE extname='timescaledb') AS enabled`;
if (!extension?.enabled) throw Error("Fixture requires TimescaleDB");
const sources = await sql<
  { id: string; enabled: boolean; kind: string }[]
>`SELECT id,enabled,kind::text AS kind FROM pulse.sources WHERE base_id=${baseId}::uuid`;
if (
  sources.length !== 60 ||
  sources.some(
    (source) => !source.enabled || source.kind !== "http_ingest" || !fixture.sources.some((expected) => expected.id === source.id),
  )
) {
  throw Error("Database sources differ from the enabled fixture sources");
}
const series = await sql<{ id: string; source_id: string; name: string; resource_key: string; type: string }[]>`
  SELECT s.id,s.source_id,d.name,s.resource_key,d.type::text AS type FROM pulse.metric_series s
  JOIN pulse.metric_defs d ON d.id=s.metric_id WHERE s.base_id=${baseId}::uuid
`;
if (series.length !== 1000) throw Error("Expected exactly 1,000 series created through HTTP ingestion");
const metricRows = fixture.sources
  .filter((source) => source.kind === "server")
  .flatMap((source) => {
    const owned = series.filter((row) => row.source_id === source.id);
    if (owned.length !== 20) throw Error(`Expected 20 series for server index ${source.index}`);
    return Array.from({ length: 20 }, (_, metric) => {
      const name = metric === 0 ? "cpu" : `server.metric_${metric}`;
      const matches = owned.filter((row) => row.name === name && row.resource_key === `server:${source.index}` && row.type === "gauge");
      if (matches.length !== 1) throw Error(`Unexpected series contract for server index ${source.index}, metric ${metric}`);
      const matched = matches[0];
      if (!matched) throw Error("Missing series after validation");
      return { id: matched.id, sourceIndex: source.index, metric };
    });
  });
const websites = fixture.sources.filter((source) => source.kind === "website").map(({ id, index }) => ({ id, index }));
const paths = Array.from({ length: 5 }, (_, index) => {
  const dimensions = { path: `/page/${index}` };
  return { index, dimensions, hash: createHash("sha256").update(JSON.stringify(dimensions)).digest("hex") };
});
const [anchor] = await sql<{ until: Date }[]>`SELECT date_bin('1 hour',now(),'1970-01-01'::timestamptz) AS until`;
if (!anchor) throw Error("Missing database clock");
const until = anchor.until;
const from = new Date(until.getTime() - HOURS * 3_600_000);
// A durable claim makes accidental repeat/partial restart fail closed, without deleting baseline data.
await sql`CREATE TABLE IF NOT EXISTS public.pulse_volume_fixture (
  base_id uuid PRIMARY KEY, started_at timestamptz NOT NULL DEFAULT now(),
  range_from timestamptz NOT NULL, range_to timestamptz NOT NULL, completed_at timestamptz
)`.simple();
const claimed = await sql`INSERT INTO public.pulse_volume_fixture(base_id,range_from,range_to)
  VALUES (${baseId}::uuid,${from},${until}) ON CONFLICT DO NOTHING RETURNING base_id`;
if (claimed.length !== 1) throw Error("Volume fixture already claimed; use a new disposable fixture after failed or completed runs");
const countRange = async () => {
  const [row] = await sql`SELECT
    (SELECT count(*) FROM pulse.metric_samples WHERE base_id=${baseId}::uuid AND ts>=${from} AND ts<${until}) AS metrics,
    (SELECT count(*) FROM pulse.events WHERE base_id=${baseId}::uuid AND ts>=${from} AND ts<${until}) AS events`;
  return { metrics: Number(row?.metrics), events: Number(row?.events) };
};
const before = await countRange();
const started = performance.now();
let addedMetrics = 0;
let addedEvents = 0;
for (let hour = 0; hour < HOURS; hour++) {
  const timestamp = new Date(from.getTime() + hour * 3_600_000);
  const phaseStarted = performance.now();
  await sql.begin(async (tx) => {
    const active = await requireBaseActive(baseId, tx);
    if (!active.ok) throw Error("Fixture base is inactive");
    await markMetricHoursDirty(baseId, [timestamp.toISOString()], tx);
    const metrics = await tx`
      INSERT INTO pulse.metric_samples(base_id,series_id,ts,value)
      SELECT ${baseId}::uuid,s.id::uuid,${timestamp}::timestamptz + make_interval(secs => minute*60+1),
        s."sourceIndex" + s.metric + ((${hour}*60+minute)%100)
      FROM generate_series(0,59) minute CROSS JOIN
        jsonb_to_recordset((${JSON.stringify(metricRows)}::jsonb #>> '{}')::jsonb) AS s(id text,"sourceIndex" int,metric int)
      ORDER BY minute,s.id
    `;
    const events = await tx`
      INSERT INTO pulse.events(base_id,source_id,source_identity,ts,kind,actor_id,session_id,
        resource_key,resource_type,resource_id,dimensions_hash,dimensions,attributes)
      SELECT ${baseId}::uuid,s.id::uuid,s.id::uuid,
        ${timestamp}::timestamptz+make_interval(secs => (item/10)*60+item%10),'page.viewed',
        'volume-visitor-'||((${hour}*600+item)%5000),
        'volume-session-'||((${hour}*600+item)%10000),
        'website:'||s.index,'website',s.index::text,p.hash,p.dimensions,
        jsonb_build_object('volume_fixture',true)
      FROM generate_series(0,599) item CROSS JOIN
        jsonb_to_recordset((${JSON.stringify(websites)}::jsonb #>> '{}')::jsonb) AS s(id text,index int)
      JOIN jsonb_to_recordset((${JSON.stringify(paths)}::jsonb #>> '{}')::jsonb) AS p(index int,hash text,dimensions jsonb)
        ON p.index=item%5
      ORDER BY item,s.index
    `;
    if (metrics.count !== 60_000 || events.count !== 6_000) throw Error("Unexpected inserted hour row counts");
  });
  addedMetrics += 60_000;
  addedEvents += 6_000;
  if (hour === 0 || (hour + 1) % 24 === 0 || hour === HOURS - 1) {
    console.log(
      JSON.stringify({
        phase: "sql-volume-seed",
        hours: hour + 1,
        addedMetrics,
        addedEvents,
        lastHourMs: Math.round(performance.now() - phaseStarted),
        elapsedMs: Math.round(performance.now() - started),
      }),
    );
  }
}
const seedMs = performance.now() - started;
const after = await countRange();
if (after.metrics - before.metrics !== 43_200_000 || after.events - before.events !== 4_320_000) {
  throw Error("Seed row delta differs from the scenario; concurrent writes/retention invalidate this fixture run");
}
const rollupStarted = performance.now();
let rollupCalls = 0;
for (;;) {
  const result = await runHourlyRollup(baseId);
  rollupCalls++;
  if (result.done) break;
  if (rollupCalls > HOURS + 24) throw Error("Rollups did not converge; concurrent writers may be modifying the fixture");
  if (rollupCalls % 24 === 0)
    console.log(
      JSON.stringify({ phase: "real-hourly-rollups", calls: rollupCalls, elapsedMs: Math.round(performance.now() - rollupStarted) }),
    );
}
const [rollups] = await sql`SELECT count(*) AS count,sum(sample_count) AS samples FROM pulse.metric_rollups_hourly
  WHERE base_id=${baseId}::uuid AND bucket>=${from} AND bucket<${until}`;
const [hours] = await sql`SELECT count(*) AS count FROM pulse.metric_hours
  WHERE base_id=${baseId}::uuid AND hour>=${from} AND hour<${until} AND state='clean'`;
if (Number(rollups?.count) !== 720_000 || Number(rollups?.samples) !== after.metrics || Number(hours?.count) !== 720) {
  throw Error("Expected 720 clean hours, 720,000 rollups, and an exact raw-sample total");
}
const [storage] = await sql`SELECT
  (SELECT total_bytes FROM hypertable_detailed_size('pulse.metric_samples')) AS metric_bytes,
  (SELECT total_bytes FROM hypertable_detailed_size('pulse.events')) AS event_bytes,
  (SELECT total_bytes FROM hypertable_detailed_size('pulse.metric_rollups_hourly')) AS rollup_bytes`;
const metadata = {
  phase: "sql-volume-complete",
  baseId,
  from: from.toISOString(),
  to: until.toISOString(),
  addedMetrics,
  addedEvents,
  baseline: before,
  rangeTotals: after,
  rollups: Number(rollups?.count),
  seedMs,
  rollupMs: performance.now() - rollupStarted,
  storage,
  assumptions: {
    servers: 50,
    seriesPerServer: 20,
    websites: 10,
    eventsPerWebsitePerMinute: 10,
    metricValue: "sourceIndex + metricIndex + (minuteSinceFrom % 100)",
    seededUniqueActors: 50_000,
    seededUniqueSessions: 100_000,
    actorPrefix: "volume-visitor-",
    sessionPrefix: "volume-session-",
  },
};
await sql`UPDATE public.pulse_volume_fixture SET completed_at=now() WHERE base_id=${baseId}::uuid`;
if (process.env.PULSE_VOLUME_OUTPUT) await Bun.write(process.env.PULSE_VOLUME_OUTPUT, JSON.stringify(metadata, null, 2));
console.log(JSON.stringify(metadata));
await sql.close();
