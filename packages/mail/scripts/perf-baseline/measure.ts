import { brotliCompressSync } from "node:zlib";
import type { SQL } from "bun";
import { z } from "zod";
import { decodeAttribute, validatePage } from "../../../../scripts/perf-baseline/model";
import { command, type Runtime, waitFor } from "../../../../scripts/perf-baseline/runtime";
import type { Api } from "../../../../scripts/perf-baseline/seed";
import { type DatabaseMeasurement, planSchema, type Sample, type Scenario } from "./model";

export const postgresLog = "/var/lib/postgresql/data/perf-logs/mail-perf.json";
const observerRole = "mail_perf_observer";

// log_min_duration uses ALTER SYSTEM below; a -c override would prevent toggling it.
export const postgresArgs = [
  "shared_preload_libraries=pg_stat_statements,auto_explain",
  "pg_stat_statements.track=all",
  "pg_stat_statements.max=10000",
  "compute_query_id=on",
  "auto_explain.log_analyze=on",
  "auto_explain.log_buffers=on",
  "auto_explain.log_verbose=on",
  "auto_explain.log_nested_statements=on",
  "auto_explain.log_format=json",
  "logging_collector=on",
  "log_destination=jsonlog",
  "log_directory=/var/lib/postgresql/data/perf-logs",
  "log_filename=mail-perf.log",
  "log_rotation_age=0",
  "log_rotation_size=0",
  "track_io_timing=on",
].flatMap((value) => ["-c", value]);
export const emptySample = (): Sample => ({ totalMs: 0, ttfbMs: 0, rawBytes: 0, brotliBytes: 0, propsBytes: 0, requests: [] });
// Epoch-based performance time is comparable across host processes, unlike Bun's process-relative hrtime.
export const monotonicMs = () => performance.timeOrigin + performance.now();
export function assertRunUrl(url: string, port: number | undefined, protocol: string, database?: string) {
  const parsed = new URL(url);
  if (
    !port ||
    port === 3000 ||
    parsed.hostname !== "127.0.0.1" ||
    Number(parsed.port) !== port ||
    parsed.protocol !== protocol ||
    (database !== undefined && parsed.pathname !== `/${database}`)
  )
    throw new Error("Refusing host service URL outside this run's published loopback port/database");
  return url;
}
export async function propsBytes(html: string) {
  let bytes = 0;
  await new HTMLRewriter()
    .on("solid-island, solid-client", {
      element(e) {
        bytes += Buffer.byteLength(decodeAttribute(e.getAttribute("data-props") ?? ""));
      },
    })
    .transform(new Response(html))
    .text();
  return bytes;
}
export function parseServerTiming(header: string | null) {
  const phases: Record<string, number> = {};
  for (const part of header?.split(",") ?? []) {
    const match = /^\s*([\w-]+)\s*;\s*dur=([\d.]+)/.exec(part);
    if (match && Number.isFinite(Number(match[2]))) phases[match[1]!] = Number(match[2]);
  }
  return phases;
}
export async function request(api: Api, sample: Sample, path: string, input?: unknown, ssr = false) {
  const started = performance.now();
  const response = await api.response(path, input === undefined ? "GET" : "POST", input);
  const ttfbMs = performance.now() - started;
  const body = Buffer.from(await response.arrayBuffer());
  const totalMs = performance.now() - started;
  const text = body.toString("utf8");
  const measurement = {
    path,
    method: input === undefined ? "GET" : "POST",
    status: response.status,
    totalMs,
    ttfbMs,
    rawBytes: body.length,
    brotliBytes: brotliCompressSync(body).length,
    propsBytes: ssr ? await propsBytes(text) : 0,
    serverTiming: parseServerTiming(response.headers.get("server-timing")),
  };
  sample.requests.push(measurement);
  for (const key of ["totalMs", "ttfbMs", "rawBytes", "brotliBytes", "propsBytes"] as const) sample[key] += measurement[key];
  if (response.status !== 200)
    throw new Error(`${measurement.method} ${path} returned HTTP ${response.status}; expected 200 (redirects refused)`);
  if (ssr) {
    validatePage(response.status, new URL(path, api.origin).href, response.url, text);
    if (/ConsentForm|<title>[^<]*consent/i.test(text)) throw new Error("SSR returned a legal consent page");
    return undefined;
  }
  const json: unknown = JSON.parse(text);
  // Workspace aggregates deliberately carry visible partial failures in a 200 response.
  const errors = z
    .object({
      listError: z.string().nullable().optional(),
      draftsError: z.string().nullable().optional(),
      scheduledError: z.string().nullable().optional(),
      detailError: z.string().nullable().optional(),
      collaborationError: z.string().nullable().optional(),
      detailErrors: z.record(z.string(), z.string().nullable()).optional(),
    })
    .parse(json);
  const { detailErrors, ...topLevelErrors } = errors;
  if ([...Object.values(topLevelErrors), ...Object.values(detailErrors ?? {})].some((error) => error != null))
    throw new Error(`Workspace returned a partial read failure: ${JSON.stringify(errors)}`);
  return json;
}
export async function reset(db: SQL) {
  await db`SELECT pg_stat_statements_reset()`;
}
export async function readDatabase(db: SQL, started: number, runs: number): Promise<DatabaseMeasurement> {
  const windowMs = performance.now() - started;
  const rows = await db<
    {
      query: string;
      queryid: string;
      calls: string;
      total_exec_time: number;
      mean_exec_time: number;
      rows: string;
      shared_blks_hit: string;
      shared_blks_read: string;
    }[]
  >`
    SELECT query, queryid::text AS queryid, calls, total_exec_time, mean_exec_time, rows, shared_blks_hit, shared_blks_read
    FROM pg_stat_statements WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
      AND userid <> (SELECT oid FROM pg_roles WHERE rolname = current_user)
      AND query NOT ILIKE '%pg_stat_statements%'
    ORDER BY total_exec_time DESC`;
  const statements = rows.map((r) => ({
    query: r.query,
    queryid: r.queryid,
    calls: Number(r.calls),
    totalMs: Number(r.total_exec_time),
    meanMs: Number(r.mean_exec_time),
    rows: Number(r.rows),
    hits: Number(r.shared_blks_hit),
    reads: Number(r.shared_blks_read),
  }));
  const calls = statements.reduce((n, r) => n + r.calls, 0),
    totalMs = statements.reduce((n, r) => n + r.totalMs, 0);
  return { windowMs, calls, totalMs, callsPerRun: calls / runs, msPerRun: totalMs / runs, statements };
}

/** The collector serializes one jsonlog object per line, including multiline plan messages. */
export function slowestPlan(log: string, statements: Pick<DatabaseMeasurement["statements"][number], "queryid">[]) {
  const queryids = new Set(statements.flatMap((s) => (s.queryid === undefined ? [] : [s.queryid])));
  const candidates: z.infer<typeof planSchema>[] = [];
  let unparsedPlans = 0;
  for (const line of log.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = z.object({ user_name: z.string().optional(), message: z.string() }).parse(JSON.parse(line));
      if (entry.user_name === observerRole) continue;
      const match = /^duration:\s*([\d.]+)\s*ms\s+plan:\s*([\s\S]*)$/.exec(entry.message);
      if (!match) continue;
      const parsed = z
        .object({ "Query Text": z.string(), "Query Identifier": z.string().optional(), Plan: z.record(z.string(), z.json()) })
        .parse(
          // JSON numeric tokens must retain all 64 bits, including adjacent IDs above 2^53.
          JSON.parse(match[2]!, (key: string, value: unknown, context?: { source?: string }) =>
            key === "Query Identifier" && typeof value === "number" ? z.string().parse(context?.source) : value,
          ),
        );
      const plan = parsed.Plan;
      // Bound embedded payloads and plan fanout without producing invalid JSON.
      const trim = (value: z.infer<ReturnType<typeof z.json>>, level = 0): z.infer<ReturnType<typeof z.json>> => {
        if (level > 12) return "[depth limit]";
        if (typeof value === "string") return value.slice(0, 1000);
        if (Array.isArray(value)) return value.slice(0, 30).map((v) => trim(v, level + 1));
        if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, trim(v, level + 1)]));
        return value;
      };
      candidates.push(
        planSchema.parse({
          query: parsed["Query Text"],
          matched: parsed["Query Identifier"] !== undefined && queryids.has(parsed["Query Identifier"]),
          durationMs: Number(match[1]),
          node: plan["Node Type"],
          totalMs: plan["Actual Total Time"],
          hits: plan["Shared Hit Blocks"] ?? 0,
          reads: plan["Shared Read Blocks"] ?? 0,
          plan: trim(parsed),
        }),
      );
    } catch {
      // A damaged log entry must never discard otherwise valid measurements.
      unparsedPlans++;
    }
  }
  const sorted = candidates.toSorted((a, b) => b.durationMs - a.durationMs);
  return { plan: sorted.find((plan) => plan.matched) ?? sorted[0] ?? null, unparsedPlans };
}

/** Explain diagnostics are optional; timing and attribution failures are handled separately. */
export async function capturePlan(scenario: Scenario, capture: () => Promise<ReturnType<typeof slowestPlan>>) {
  try {
    const captured = await capture();
    scenario.plan = captured.plan;
    scenario.unparsedPlans = captured.unparsedPlans;
    if (!scenario.plan) scenario.planError = "auto_explain pass produced no request plan";
  } catch (error) {
    scenario.planError = String(error);
  }
}
/** Command-line -c wins over ALTER SYSTEM: this one setting must be reloadable. */
export async function setExplainDuration(db: SQL, duration: -1 | 0) {
  const [setting] = await db<{ source: string }[]>`SELECT source FROM pg_settings WHERE name = 'auto_explain.log_min_duration'`;
  if (!setting || setting.source === "command line")
    throw new Error("auto_explain.log_min_duration must be reloadable; do not pin it with a startup -c flag");
  if (duration === 0) await db`ALTER SYSTEM SET auto_explain.log_min_duration = '0'`;
  else await db`ALTER SYSTEM SET auto_explain.log_min_duration = '-1'`;
  await db`SELECT pg_reload_conf()`;
  await waitFor(
    "auto_explain threshold reload",
    async () => {
      const [row] = await db<{ setting: string }[]>`SELECT setting FROM pg_settings WHERE name = 'auto_explain.log_min_duration'`;
      return row?.setting === String(duration);
    },
    AbortSignal.timeout(5000),
    5000,
  );
}
export async function explain(db: SQL, runtime: Runtime, statements: DatabaseMeasurement["statements"], pass: () => Promise<void>) {
  const exec = (...args: string[]) => command(["docker", "exec", runtime.name("postgres"), ...args], { signal: runtime.signal });
  const offset = Number(await exec("stat", "-c", "%s", postgresLog));
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid PostgreSQL jsonlog byte offset");
  try {
    await setExplainDuration(db, 0);
    // The setting is read by existing backends at their next command boundary.
    await pass();
  } finally {
    await setExplainDuration(db, -1);
  }
  return slowestPlan(await exec("tail", "-c", `+${offset + 1}`, postgresLog), statements);
}
