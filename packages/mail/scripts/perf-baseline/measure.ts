import { brotliCompressSync } from "node:zlib";
import type { SQL } from "bun";
import { z } from "zod";
import { decodeAttribute, validatePage } from "../../../../scripts/perf-baseline/model";
import { command, type Runtime, waitFor } from "../../../../scripts/perf-baseline/runtime";
import type { Api } from "../../../../scripts/perf-baseline/seed";
import { type DatabaseMeasurement, planSchema, type Sample } from "./model";

// log_min_duration uses ALTER SYSTEM below; a -c override would prevent toggling it.
export const postgresArgs = [
  "shared_preload_libraries=pg_stat_statements,auto_explain",
  "pg_stat_statements.track=all",
  "pg_stat_statements.max=10000",
  "auto_explain.log_analyze=on",
  "auto_explain.log_buffers=on",
  "auto_explain.log_nested_statements=on",
  "auto_explain.log_format=json",
  "track_io_timing=on",
].flatMap((value) => ["-c", value]);
export const emptySample = (): Sample => ({ totalMs: 0, ttfbMs: 0, rawBytes: 0, brotliBytes: 0, propsBytes: 0, requests: [] });
// CLOCK_MONOTONIC is shared by these host processes; wall-clock changes cannot skew IPC timing.
export const monotonicMs = () => Number(process.hrtime.bigint()) / 1e6;
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
    })
    .parse(json);
  if (Object.values(errors).some(Boolean)) throw new Error(`Workspace returned a partial read failure: ${JSON.stringify(errors)}`);
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
      calls: string;
      total_exec_time: number;
      mean_exec_time: number;
      rows: string;
      shared_blks_hit: string;
      shared_blks_read: string;
    }[]
  >`
    SELECT query, calls, total_exec_time, mean_exec_time, rows, shared_blks_hit, shared_blks_read
    FROM pg_stat_statements WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
      AND userid <> (SELECT oid FROM pg_roles WHERE rolname = current_user)
      AND query NOT ILIKE '%pg_stat_statements%'
    ORDER BY total_exec_time DESC`;
  const statements = rows.map((r) => ({
    query: normalizeQuery(r.query),
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

function normalizeQuery(query: string) {
  return query
    .replace(/\s+/g, " ")
    .trim()
    .replace(/(?:;\s*)+$/, "")
    .trim();
}

/** Postgres logs auto_explain as a multiline JSON object following `plan:`. */
export function slowestPlan(log: string, statements: Pick<DatabaseMeasurement["statements"][number], "query">[]) {
  const queries = new Set(statements.map((s) => normalizeQuery(s.query)));
  const candidates: z.infer<typeof planSchema>[] = [];
  for (const match of log.matchAll(/duration:\s*([\d.]+)\s*ms\s+plan:\s*\n?\s*(\{)/g)) {
    const start = (match.index ?? 0) + match[0].lastIndexOf("{");
    let depth = 0,
      quoted = false,
      escaped = false;
    for (let i = start; i < log.length; i++) {
      const c = log[i];
      if (quoted) {
        if (escaped) escaped = false;
        else if (c === "\\") escaped = true;
        else if (c === '"') quoted = false;
      } else if (c === '"') quoted = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) {
        const raw: unknown = JSON.parse(log.slice(start, i + 1));
        const parsed = z.object({ "Query Text": z.string(), Plan: z.record(z.string(), z.json()) }).parse(raw);
        if (/pg_stat_statements|pg_reload_conf|pg_settings|ALTER SYSTEM|pg_roles|current_database/.test(parsed["Query Text"])) break;
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
            query: normalizeQuery(parsed["Query Text"]),
            matched: queries.has(normalizeQuery(parsed["Query Text"])),
            durationMs: Number(match[1]),
            node: plan["Node Type"],
            totalMs: plan["Actual Total Time"],
            hits: plan["Shared Hit Blocks"] ?? 0,
            reads: plan["Shared Read Blocks"] ?? 0,
            plan: trim(parsed),
          }),
        );
        break;
      }
    }
  }
  const sorted = candidates.toSorted((a, b) => b.durationMs - a.durationMs);
  return sorted.find((plan) => plan.matched) ?? sorted[0] ?? null;
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
  const since = new Date().toISOString();
  try {
    await setExplainDuration(db, 0);
    // The setting is read by existing backends at their next command boundary.
    await pass();
  } finally {
    await setExplainDuration(db, -1);
  }
  const until = new Date().toISOString();
  return slowestPlan(
    await command(["docker", "logs", "--since", since, "--until", until, runtime.name("postgres")], {
      includeStderr: true,
      signal: runtime.signal,
    }),
    statements,
  );
}
