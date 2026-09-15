/** Read-only authenticated HTTP queries against the completed SQL volume fixture.
 * Start the application separately. Credentials stay in PULSE_LOAD_FIXTURE outside Git.
 * First observations and three repeated rounds are reported separately; this is not an ingest benchmark.
 */
import { sql } from "bun";
import { z } from "zod";
import { MetricQueryResultSchema } from "../src/api/schemas";

const fixturePath = process.env.PULSE_LOAD_FIXTURE;
const metadataPath = process.env.PULSE_VOLUME_OUTPUT;
if (!fixturePath || !metadataPath) throw Error("PULSE_LOAD_FIXTURE and PULSE_VOLUME_OUTPUT are required");
const fixture = z
  .object({
    url: z.string().url(),
    cookie: z.string().min(1),
    base: z.object({ id: z.string().uuid(), short_id: z.string().length(6) }),
    sources: z.array(z.object({ id: z.string().uuid(), index: z.number().int(), kind: z.enum(["server", "website"]) })).length(60),
  })
  .parse(await Bun.file(fixturePath).json());
const metadata = z
  .object({
    phase: z.literal("sql-volume-complete"),
    baseId: z.string().uuid(),
    from: z.string().datetime(),
    to: z.string().datetime(),
    addedMetrics: z.literal(43_200_000),
    addedEvents: z.literal(4_320_000),
    rollups: z.literal(720_000),
    baseline: z.object({ metrics: z.literal(0), events: z.literal(0) }),
  })
  .parse(await Bun.file(metadataPath).json());
const origin = new URL(fixture.url);
if (!["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)) throw Error("Probe requires a loopback fixture");
if (metadata.baseId !== fixture.base.id || Date.parse(metadata.to) - Date.parse(metadata.from) !== 30 * 86_400_000) {
  throw Error("Metadata must describe the matching complete 30-day fixture");
}
if (
  new Set(fixture.sources.map((source) => source.id)).size !== 60 ||
  fixture.sources.some((source, index) => source.index !== index || source.kind !== (index < 50 ? "server" : "website"))
)
  throw Error("Unexpected source scenario");
const databaseTarget = new URL(process.env.DATABASE_URL ?? "");
if (!["localhost", "127.0.0.1", "[::1]"].includes(databaseTarget.hostname) || databaseTarget.pathname !== "/pulse_load_test") {
  throw Error("Acceptance probes require loopback pulse_load_test");
}
const [database] = await sql`SELECT current_database() AS name`;
if (database?.name !== "pulse_load_test") throw Error("Probe requires disposable pulse_load_test");
const [state] = await sql`SELECT v.range_from,v.range_to,v.completed_at,b.retention_days
  FROM public.pulse_volume_fixture v JOIN pulse.bases b ON b.id=v.base_id WHERE v.base_id=${fixture.base.id}::uuid`;
if (
  !state?.completed_at ||
  state.retention_days !== 30 ||
  new Date(state.range_from).getTime() !== Date.parse(metadata.from) ||
  new Date(state.range_to).getTime() !== Date.parse(metadata.to)
) {
  throw Error("Database does not match a completed fixture with 30-day retention");
}
const sources = await sql<{ id: string; short_id: string }[]>`SELECT id,short_id FROM pulse.sources WHERE base_id=${fixture.base.id}::uuid`;
const sourceSelector = (index: number) => {
  const fixtureSource = fixture.sources.find((source) => source.index === index);
  const source = sources.find((source) => source.id === fixtureSource?.id);
  if (!source || !/^[A-Za-z0-9]{6}$/.test(source.short_id)) throw Error("Missing public source selector");
  return source.short_id;
};
await sql.close();
// Excluding the oldest day avoids exact retention-boundary drift during the long seed.
const fromMs = Date.parse(metadata.from) + 86_400_000;
const toMs = Date.parse(metadata.to);
if (fromMs < Date.now() - 30 * 86_400_000 || toMs > Date.now()) throw Error("Fixture query window is outside current raw retention");
const from = new Date(fromMs).toISOString();
const range = `from ${from} to ${metadata.to}`;
const hours = (toMs - fromMs) / 3_600_000;
const eventCount = hours * 600 * 10;
type Point = z.infer<typeof MetricQueryResultSchema>["points"][number];
type Case = { name: string; query: string; check: (points: Point[]) => void };
const singleValue = (expected: number) => (points: Point[]) => {
  if (points.length !== 1 || points[0]?.value !== expected) throw Error(`Expected one aggregate value ${expected}`);
};
const metricValues = (sourceAverage: number) => (points: Point[]) => {
  if (points.length !== hours) throw Error(`Expected ${hours} metric buckets`);
  for (let hour = 0; hour < hours; hour++) {
    const point = points[hour];
    const minuteStart = (24 + hour) * 60;
    let total = 0;
    for (let minute = 0; minute < 60; minute++) total += (minuteStart + minute) % 100;
    const expected = sourceAverage + total / 60;
    if (
      !point ||
      Date.parse(point.bucket) !== fromMs + hour * 3_600_000 ||
      point.value === null ||
      Math.abs(point.value - expected) > 1e-9
    ) {
      throw Error(`Metric bucket ${hour} differs from deterministic fixture arithmetic`);
    }
  }
};
// Derive local dates from each seeded UTC hour, including partial first/last days.
// Europe/Berlin midnight and DST transitions align with UTC-hour boundaries.
const berlinDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Berlin",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const berlinClock = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Berlin",
  hourCycle: "h23",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});
const expectedDays = new Map<string, number>();
for (let timestamp = fromMs; timestamp < toMs; timestamp += 3_600_000) {
  const day = berlinDate.format(new Date(timestamp));
  expectedDays.set(day, (expectedDays.get(day) ?? 0) + 6_000);
}
const calendarValues = (points: Point[]) => {
  if (points.length !== expectedDays.size) throw Error("Unexpected Berlin calendar bucket count");
  const seen = new Set<string>();
  let previousTimestamp = -Infinity;
  for (const point of points) {
    const timestamp = Date.parse(point.bucket);
    const date = new Date(timestamp);
    if (!Number.isFinite(timestamp) || timestamp <= previousTimestamp) throw Error("Calendar buckets must be strictly ordered");
    const day = berlinDate.format(date);
    if (seen.has(day) || !expectedDays.has(day) || point.value !== expectedDays.get(day)) {
      throw Error("Calendar bucket differs from independently counted seeded UTC hours");
    }
    if (berlinClock.format(date) !== "00:00:00") throw Error("Calendar bucket does not start at Berlin midnight");
    seen.add(day);
    previousTimestamp = timestamp;
  }
};
const cases: Case[] = [
  {
    name: "events-calendar-berlin-29d",
    query: `events page.viewed count every day timezone Europe/Berlin ${range}`,
    check: calendarValues,
  },
  { name: "events-count-29d", query: `events page.viewed count every all ${range}`, check: singleValue(eventCount) },
  { name: "events-actors-29d", query: `events page.viewed unique actor every all ${range}`, check: singleValue(50_000) },
  { name: "events-sessions-29d", query: `events page.viewed unique session every all ${range}`, check: singleValue(100_000) },
  {
    name: "website-50-count",
    query: `events page.viewed count every all ${range} source ${sourceSelector(50)}`,
    check: singleValue(eventCount / 10),
  },
  {
    name: "website-50-actors",
    query: `events page.viewed unique actor every all ${range} source ${sourceSelector(50)}`,
    check: singleValue(5_000),
  },
  {
    name: "website-59-sessions",
    query: `events page.viewed unique session every all ${range} source ${sourceSelector(59)}`,
    check: singleValue(10_000),
  },
  { name: "metric-fleet-hourly-29d", query: `metric cpu avg every 1h ${range}`, check: metricValues(24.5) },
  { name: "metric-server-hourly-29d", query: `metric cpu avg every 1h ${range} source ${sourceSelector(0)}`, check: metricValues(0) },
];
const samples: { name: string; phase: string; durationMs: number; status: number; points: number }[] = [];
const read = async (item: Case, phase: string) => {
  const started = performance.now();
  const response = await fetch(new URL("/api/pulse/query/metric-text", origin), {
    method: "POST",
    headers: { "content-type": "application/json", cookie: fixture.cookie },
    body: JSON.stringify({ baseId: fixture.base.short_id, query: item.query }),
    signal: AbortSignal.timeout(120_000),
  });
  if (response.status !== 200) {
    console.log(JSON.stringify({ phase, name: item.name, status: response.status, durationMs: performance.now() - started }));
    throw Error(`HTTP query ${item.name} failed with status ${response.status}`);
  }
  const result = MetricQueryResultSchema.parse(await response.json());
  if (result.compiled.baseId !== fixture.base.short_id) throw Error("Query returned another base");
  item.check(result.points);
  const sample = { name: item.name, phase, durationMs: performance.now() - started, status: response.status, points: result.points.length };
  samples.push(sample);
  console.log(JSON.stringify(sample));
};
for (const item of cases) await read(item, "first-observation");
for (let round = 0; round < 3; round++) {
  // Bound concurrency at three, matching a dashboard with three simultaneously loading widgets.
  for (let start = 0; start < cases.length; start += 3)
    await Promise.all(cases.slice(start, start + 3).map((item) => read(item, `repeat-${round + 1}`)));
}
console.log(
  JSON.stringify(
    {
      phase: "volume-http-complete",
      from,
      to: metadata.to,
      hours,
      expectedEvents: eventCount,
      assumptions: "29-day immutable seeded interval; no baseline rows in seed range; 3 repeated rounds, concurrency at most 3",
      samples,
    },
    null,
    2,
  ),
);
