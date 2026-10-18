import { z } from "zod";
import { anchor } from "../../test/fixtures/large-mailbox";

export { sortedJson } from "../../../../scripts/perf-baseline/model";

export const help = `Usage: bun --no-env-file packages/mail/scripts/perf-baseline.ts [flags]

Measure Mail server/API performance with isolated production core/mail/gateway
and Caddy HTTPS. No browsers. Requires dependencies and Docker access.
Allow roughly 5–15 minutes for builds/startup plus 2–5 minutes to measure;
slow hosts/downloads can take longer. Takes the machine-wide heavy lock.
Only starts/removes run-owned labelled containers, networks and volumes.
Uses free 127.0.0.1 ports, never port 3000 or the dev/CI database.
No provider connection: example.test persistence fixture, sync disabled.
Plain Postgres uses search fallback; BM25 availability is recorded.

  --messages N       1..100000 (default 20000)
  --conversations N  1..messages (default 3000)
  --folders N        6..1000 (default 30; Inbox/Sent/Archive/Trash/Junk/Drafts)
                     Use --folders 350 to reproduce mailbox scale from #1268.
  --runs N           1..50 warm runs (default 5), always one cold run first
  --seed N           Integer 0..4294967295 (default 20261001)
  --out <dir>        Inside this worktree (default .local/mail-perf/<UTC timestamp>)
                     Reserve result.json + summary.md; never overwrite files.
  --compare <file>   Earlier Mail schemaVersion 1 result.json; median deltas
  --skip-build       Reuse .local/perf-baseline/build/<app>/dist (may be stale)
  --keep             Keep run-owned resources; print exact removal commands
  --help             Usage only: no lock, build or Docker

Cold means first scenario invocation, not flushed database/OS caches. Scenarios
share a seeded installation; background noise is recorded in a 5-second idle
window. One untimed auto_explain pass follows each scenario. Local emulation,
not provider/network performance. Message dates use ${anchor}.
`;
export function parseArgs(args: string[]) {
  const options = {
    help: false,
    messages: 20_000,
    conversations: 3000,
    folders: 30,
    runs: 5,
    seed: 20261001,
    out: undefined as string | undefined,
    compare: undefined as string | undefined,
    skipBuild: false,
    keep: false,
  };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === "--help") options.help = true;
    else if (flag === "--keep") options.keep = true;
    else if (flag === "--skip-build") options.skipBuild = true;
    else if (["--messages", "--conversations", "--folders", "--runs", "--seed", "--out", "--compare"].includes(flag ?? "")) {
      const value = args[++i];
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
      if (flag === "--out") options.out = value;
      else if (flag === "--compare") options.compare = value;
      else {
        if (!/^\d+$/.test(value)) throw new Error(`${flag} expects an integer`);
        const n = Number(value);
        switch (flag) {
          case "--messages":
            options.messages = n;
            break;
          case "--conversations":
            options.conversations = n;
            break;
          case "--folders":
            options.folders = n;
            break;
          case "--runs":
            options.runs = n;
            break;
          case "--seed":
            options.seed = n;
            break;
        }
      }
    } else throw new Error(`Unknown flag: ${flag}`);
  }
  for (const [key, min, max] of [
    ["messages", 1, 100000],
    ["conversations", 1, options.messages],
    ["folders", 6, 1000],
    ["runs", 1, 50],
    ["seed", 0, 4294967295],
  ] as const) {
    if (!Number.isSafeInteger(options[key]) || options[key] < min || options[key] > max) throw new Error(`--${key} must be ${min}..${max}`);
  }
  return options;
}
export type Options = ReturnType<typeof parseArgs>;
const number = z.number().finite().nonnegative();
export const requestSchema = z.object({
  path: z.string(),
  method: z.string(),
  status: z.number(),
  totalMs: number,
  ttfbMs: number,
  rawBytes: number,
  brotliBytes: number,
  propsBytes: number,
  serverTiming: z.record(z.string(), number),
  folderCountsBytes: number.optional(),
});
export type RequestMeasurement = z.infer<typeof requestSchema>;
export const sampleSchema = z.object({
  totalMs: number,
  ttfbMs: number,
  rawBytes: number,
  brotliBytes: number,
  propsBytes: number,
  requests: z.array(requestSchema),
  liveMs: number.optional(),
  visibleMs: number.optional(),
});
export type Sample = z.infer<typeof sampleSchema>;
const statementSchema = z.object({
  query: z.string(),
  // Earlier schemaVersion 1 comparison files did not capture query IDs.
  queryid: z.string().optional(),
  calls: number,
  totalMs: number,
  meanMs: number,
  rows: number,
  hits: number,
  reads: number,
});
export const databaseSchema = z.object({
  windowMs: number,
  calls: number,
  callsPerRun: number,
  totalMs: number,
  msPerRun: number,
  statements: z.array(statementSchema),
});
export type DatabaseMeasurement = z.infer<typeof databaseSchema>;
export const planSchema = z.object({
  query: z.string(),
  matched: z.boolean(),
  durationMs: number,
  node: z.string(),
  totalMs: number,
  hits: number,
  reads: number,
  plan: z.json(),
});
export const scenarioSchema = z.object({
  id: z.string(),
  group: z.string(),
  status: z.enum(["ok", "failed"]),
  errors: z.array(z.string()),
  notes: z.array(z.string()),
  samples: z.array(sampleSchema),
  metrics: z.record(z.string(), z.object({ cold: number, median: number, p95: number })).nullable(),
  database: databaseSchema.nullable(),
  plan: planSchema.nullable(),
  planError: z.string().nullable().default(null),
  unparsedPlans: z.number().int().nonnegative().default(0),
});
export type Scenario = z.infer<typeof scenarioSchema>;
export const resultSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("mail"),
  metadata: z.object({
    commit: z.string(),
    dirty: z.boolean(),
    timestamp: z.string(),
    bunVersion: z.string(),
    runtimeImage: z.string(),
    cpuCount: number,
    cpuModel: z.string(),
    loadAverage: z.object({ start: z.array(z.number()), end: z.array(z.number()) }),
    runs: number,
    fixture: z.object({ seed: number, anchor: z.string(), messages: number, conversations: number, folders: number }),
    fixtureDigest: z.string(),
    shape: z.record(z.string(), z.json()),
    seedDurationMs: number.nullable(),
    bm25: z.boolean().nullable(),
    pgTextsearch: z.boolean().nullable(),
    postgresVersion: z.string().nullable(),
    origin: z.string(),
  }),
  idle: databaseSchema.nullable(),
  scenarios: z.array(scenarioSchema),
  notes: z.array(z.string()),
  errors: z.array(z.string()),
});
export type Result = z.infer<typeof resultSchema>;
export function parsePrevious(value: unknown): Result {
  if (!value || typeof value !== "object" || !("kind" in value) || value.kind !== "mail")
    throw new Error("--compare requires a Mail result (kind: mail), not a page baseline");
  return resultSchema.parse(value);
}
export const metrics = ["totalMs", "ttfbMs", "rawBytes", "brotliBytes", "propsBytes", "liveMs", "visibleMs"] as const;
export function statistics(values: number[]) {
  if (!values.length) return null;
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return {
    median: sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2,
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1]!,
  };
}
export function summarizeSamples(samples: Sample[]) {
  const output: Record<string, { cold: number; median: number; p95: number }> = {};
  for (const key of metrics) {
    const cold = samples[0]?.[key];
    const warm = statistics(samples.slice(1).flatMap((s) => (s[key] === undefined ? [] : [s[key]])));
    if (cold !== undefined && warm) output[key] = { cold, ...warm };
  }
  return output;
}
function metric(s: Scenario, key: (typeof metrics)[number]) {
  return s.status === "ok" ? statistics(s.samples.slice(1).flatMap((sample) => (sample[key] === undefined ? [] : [sample[key]]))) : null;
}
const fmt = (value: number | null | undefined) => (value === undefined || value === null ? "—" : value.toFixed(1));
const escape = (value: string) => value.replaceAll("|", "\\|").replaceAll("\n", " ");
export function renderSummary(result: Result, previous?: Result) {
  const m = result.metadata;
  const lines = [
    "# Mail performance baseline",
    "",
    `Commit: ${m.commit}${m.dirty ? " (dirty)" : ""}; ${m.timestamp}.`,
    `CPU: ${m.cpuModel} × ${m.cpuCount}. Load: ${m.loadAverage.start.join(", ")} → ${m.loadAverage.end.join(", ")}.`,
    `Fixture: ${m.fixture.messages} messages, ${m.fixture.conversations} conversations, ${m.fixture.folders} folders; seed ${m.fixture.seed}, anchor ${m.fixture.anchor}.`,
    `Digest: ${m.fixtureDigest}. Seed: ${fmt(m.seedDurationMs)} ms. PostgreSQL: ${m.postgresVersion ?? "unknown"}. BM25 index: ${m.bm25 ?? "unknown"}; pg_textsearch: ${m.pgTextsearch ?? "unknown"}.`,
    `Warm runs: ${m.runs}. Idle statements/s: ${result.idle ? fmt(result.idle.calls / (result.idle.windowMs / 1000)) : "unknown"}.`,
    "",
    "Times are milliseconds; byte sizes are decoded body bytes and locally recompressed Brotli. Compound scenarios sum request TTFB and bytes. Cold is first invocation; caches are not flushed.",
    "",
  ];
  if (
    previous &&
    (JSON.stringify(previous.metadata.fixture) !== JSON.stringify(m.fixture) || previous.metadata.fixtureDigest !== m.fixtureDigest)
  )
    lines.push("Comparison fixtures differ; deltas are descriptive only.", "");
  for (const group of new Set(result.scenarios.map((s) => s.group))) {
    lines.push(
      `## ${group}`,
      "",
      "| Scenario | Total cold / median / p95 | TTFB cold / median / p95 | Raw / Brotli | Props | Statements/run | DB ms/run |",
      "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    );
    for (const s of result.scenarios.filter((s) => s.group === group)) {
      const triplet = (key: "totalMs" | "ttfbMs") =>
        `${fmt(s.samples[0]?.[key])} / ${fmt(metric(s, key)?.median)} / ${fmt(metric(s, key)?.p95)}`;
      lines.push(
        `| ${s.id}${s.status === "failed" ? " **FAILED**" : ""} | ${triplet("totalMs")} | ${triplet("ttfbMs")} | ${fmt(metric(s, "rawBytes")?.median)} / ${fmt(metric(s, "brotliBytes")?.median)} | ${fmt(metric(s, "propsBytes")?.median)} | ${fmt(s.database?.callsPerRun)} | ${fmt(s.database?.msPerRun)} |`,
      );
    }
    lines.push("");
  }
  if (previous) {
    lines.push(
      "## Median deltas",
      "",
      "Positive time deltas are slower. Each value is current minus earlier.",
      "",
      "| Scenario | Metric | Delta |",
      "| --- | --- | ---: |",
    );
    for (const s of result.scenarios) {
      const old = previous.scenarios.find((p) => p.id === s.id);
      for (const key of metrics) {
        const current = metric(s, key)?.median,
          before = old ? metric(old, key)?.median : undefined;
        lines.push(`| ${s.id} | ${key} | ${fmt(current === undefined || before === undefined ? undefined : current - before)} |`);
      }
      for (const key of ["callsPerRun", "msPerRun"] as const)
        lines.push(
          `| ${s.id} | DB ${key} | ${fmt(s.status === "ok" && old?.status === "ok" && s.database && old.database ? s.database[key] - old.database[key] : undefined)} |`,
        );
    }
    lines.push("");
  }
  for (const s of result.scenarios) {
    lines.push(`## ${s.id}: attribution`, "", `Status: ${s.status}. Window: ${fmt(s.database?.windowMs)} ms.`, "");
    for (const note of s.notes) lines.push(`- ${note}`);
    for (const error of s.errors) lines.push(`- Error: ${escape(error)}`);
    if (s.planError) lines.push(`- Plan error: ${escape(s.planError)}`);
    if (s.unparsedPlans) lines.push(`- Unparsed plan log entries: ${s.unparsedPlans}.`);
    if (s.samples.some((sample) => sample.liveMs !== undefined))
      lines.push(
        `- Commit → live cold/median/p95: ${fmt(s.samples[0]?.liveMs)} / ${fmt(metric(s, "liveMs")?.median)} / ${fmt(metric(s, "liveMs")?.p95)} ms; visible: ${fmt(s.samples[0]?.visibleMs)} / ${fmt(metric(s, "visibleMs")?.median)} / ${fmt(metric(s, "visibleMs")?.p95)} ms.`,
      );
    const folderBytes = s.samples.flatMap((sample) =>
      sample.requests.flatMap((r) => (r.folderCountsBytes === undefined ? [] : [r.folderCountsBytes])),
    );
    if (folderBytes.length) lines.push(`- Folder counts projection: ${fmt(statistics(folderBytes)?.median)} bytes (median).`);
    lines.push(
      "",
      "| Statement (normalized, truncated) | Calls | Total / mean ms | Rows | Buffers hit / read |",
      "| --- | ---: | ---: | ---: | ---: |",
    );
    for (const q of s.database?.statements.slice(0, 20) ?? [])
      lines.push(
        `| ${escape(q.query.slice(0, 1000))} | ${q.calls} | ${fmt(q.totalMs)} / ${fmt(q.meanMs)} | ${q.rows} | ${q.hits} / ${q.reads} |`,
      );
    lines.push(
      "",
      s.plan
        ? `Slowest explain (${s.plan.matched ? "matched" : "unmatched (may be background)"}): ${s.plan.node}, ${fmt(s.plan.totalMs)} ms; buffers hit/read ${s.plan.hits}/${s.plan.reads}. Query: ${escape(s.plan.query.slice(0, 1000))}`
        : "No explain plan captured.",
      "",
    );
  }
  lines.push("## Notes and errors", "");
  for (const note of result.notes) lines.push(`- ${note}`);
  for (const error of result.errors) lines.push(`- Error: ${escape(error)}`);
  return `${lines.join("\n")}\n`;
}
