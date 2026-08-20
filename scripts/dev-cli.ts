/**
 * Shared helpers for the `dev:*` per-app CLI suite.
 *
 * Public surface used by the verb scripts (start, stop, rebuild, logs,
 * status, help):
 *
 *   COMPOSE_FILE          path to the dev compose file
 *   compose(...args)      wrap `docker compose -f … --profile extra <args>`
 *   composeUpAndWait(...) start services and require their healthchecks
 *   listAppServices()     all app-* services declared in the compose file
 *   listRunningDevServices() services with running containers
 *   resolveApps(inputs)   normalize / validate caller args, exit on bad input
 *   color                 ANSI helpers — empty strings on non-TTY
 *   formatRelative(date)  "2h 1m ago" / "—" for null
 *   formatUptime(status)  parse compose ps `Status` string → "2h 1m"
 *   helpFor(name, lines)  print a per-command help block
 *
 * Design notes (rationale lives close to the code that needs it):
 *
 *  - Output is plain text by design. Pretty for humans, scannable for
 *    LLM agents. No --json flag — the cost of a second output mode (drift
 *    risk + token noise in the json case) wasn't worth it for the
 *    actual consumers (humans + agents that read prose fine).
 *
 *  - Stable wording in the state column: `running` / `stopped` /
 *    `never built`. These are matched by the agent skill docs, so don't
 *    rename them casually.
 *
 *  - Colors only on TTY. When `dev:status` is piped (e.g. into a tool or
 *    captured by an agent), no ANSI escapes leak into the output.
 */
import { $ } from "bun";

export const COMPOSE_FILE = "compose.dev.yml";

/** Always include `--profile extra` so all app services are visible even
 *  before they're explicitly started. The base profile alone would
 *  hide the optional apps and break validation for any extra service. */
export const compose = (args: string[]) => $`docker compose -f ${COMPOSE_FILE} --profile extra ${args}`;

const startupFailurePattern = /\b(?:error|failed|failure|enoent|exception|panic|cannot|could not)\b/i;

export const findStartupFailure = (logs: string): string | undefined => {
  const lines = logs
    .split("\n")
    .map((line) => line.replace(/^\S+\s+\|\s?/, "").trim())
    .filter(Boolean);
  return [...lines].reverse().find((line) => startupFailurePattern.test(line)) ?? lines.at(-1);
};

export const composeUpAndWait = async (args: string[], services: string[]): Promise<void> => {
  try {
    await compose(["up", ...args, "-d", "--wait", "--wait-timeout", "180", ...services]);
  } catch (error) {
    console.error(`${color.red}Services did not become ready:${color.reset}`);
    for (const service of services) {
      const logs = await compose(["logs", "--tail", "100", "--no-color", service])
        .text()
        .catch(() => "");
      console.error(`  ${shortName(service)}: ${findStartupFailure(logs) ?? "no startup error in recent logs"}`);
    }
    console.error(`Run ${color.cyan}bun run dev:status <app>${color.reset} for details.`);
    throw error;
  }
};

// =============================================================================
// Service discovery / validation
// =============================================================================

/** Pull every addressable service in the dev compose project. Two groups
 *  show up here:
 *
 *    - `app-*` services — the workspace apps (notebooks, files, …)
 *    - `gateway` — the reverse-proxy entry point at :3000
 *
 *  Both kinds are user-targetable: `dev:rebuild gateway` is a real use
 *  case after gateway source changes, just like `dev:rebuild notebooks`.
 *  Anything else compose lists (none today, but defensive against future
 *  additions like a build container) also flows through.
 *
 *  Cached for the duration of one script invocation. */
let _servicesCache: string[] | undefined;
let _coreServicesCache: string[] | undefined;

export const listDevServices = async (): Promise<string[]> => {
  if (_servicesCache) return _servicesCache;
  const raw = await compose(["config", "--services"]).text();
  _servicesCache = raw.trim().split("\n").filter(Boolean).sort();
  return _servicesCache;
};

/** Pull only services without an opt-in Compose profile. This keeps summary
 *  counts in `dev:help` aligned with the compose file as services move between
 *  the core stack and `profiles: [extra]`. */
export const listCoreDevServices = async (): Promise<string[]> => {
  if (_coreServicesCache) return _coreServicesCache;
  const raw = await $`docker compose -f ${COMPOSE_FILE} config --services`.text();
  _coreServicesCache = raw.trim().split("\n").filter(Boolean).sort();
  return _coreServicesCache;
};

/** Keep only services declared by this Compose file. `compose ps` can include
 *  separately composed infrastructure as orphans when both files share the
 *  default project name. */
export const filterDeclaredServices = (services: string[], declared: string[]): string[] => {
  const allowed = new Set(declared);
  return [...new Set(services.filter((service) => allowed.has(service)))].sort();
};

/** Return only declared Cloud services whose containers are currently running. */
export const listRunningDevServices = async (): Promise<string[]> => {
  const [raw, declared] = await Promise.all([compose(["ps", "--status", "running", "--services"]).text(), listDevServices()]);
  return filterDeclaredServices(raw.trim().split("\n").filter(Boolean), declared);
};

/** Strip the `app-` prefix to get the short name humans type. Non-app
 *  services (e.g. `gateway`) pass through unchanged. */
export const shortName = (service: string): string => (service.startsWith("app-") ? service.slice(4) : service);

/** Normalize + validate caller-supplied names. Each input is tried first
 *  as an exact match (covers `gateway`, `app-notebooks`), then with an
 *  `app-` prefix (covers `notebooks` → `app-notebooks`). On unknown:
 *  print a helpful error listing available short names and exit 1. */
export const resolveApps = async (inputs: string[]): Promise<string[]> => {
  const available = await listDevServices();
  const out: string[] = [];
  for (const raw of inputs) {
    if (available.includes(raw)) {
      out.push(raw);
    } else if (available.includes(`app-${raw}`)) {
      out.push(`app-${raw}`);
    } else {
      const shorts = available.map(shortName).join(" ");
      console.error(`${color.red}Error:${color.reset} unknown service "${raw}".`);
      console.error(`Available: ${shorts}`);
      process.exit(1);
    }
  }
  return out;
};

// =============================================================================
// Output styling
// =============================================================================

/** ANSI colors — empty strings when stdout isn't a TTY so piped output
 *  (e.g. an agent capturing `dev:status`) stays clean. */
const isTty = Boolean(process.stdout.isTTY);
const ansi = (code: string) => (isTty ? `\x1b[${code}m` : "");

export const color = {
  reset: ansi("0"),
  bold: ansi("1"),
  dim: ansi("2"),
  red: ansi("31"),
  green: ansi("32"),
  yellow: ansi("33"),
  blue: ansi("34"),
  cyan: ansi("36"),
  gray: ansi("90"),
};

// =============================================================================
// Time formatting
// =============================================================================

/** "2h 1m" / "5m 12s" / "12s" / "—". Compact and stable so an LLM agent
 *  can match the unit pattern without parsing English. */
export const formatDurationSec = (sec: number): string => {
  if (sec <= 0 || !Number.isFinite(sec)) return "—";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return s > 0 ? `${m}m ${s}s` : `${m}m`;
  return `${s}s`;
};

/** "2h ago" / "9h 7m ago" / "—". Returns "—" for `null` so the calling
 *  table layout doesn't need its own empty-cell logic. */
export const formatRelative = (date: Date | null): string => {
  if (!date) return "—";
  const diffSec = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
  return `${formatDurationSec(diffSec)} ago`;
};

/** Compose's `Status` field looks like "Up 2 hours" or "Up 5 minutes
 *  (healthy)" for running containers, or "Exited (0) 3 hours ago" for
 *  stopped ones. Pull the duration out and re-emit in our compact
 *  format. Falls back to "—" when the string doesn't match. */
export const formatUptimeFromStatus = (status: string): string => {
  const match = status.match(/^Up ([^(]+?)(?:\s*\(.+\))?$/);
  if (!match) return "—";
  const human = match[1]!.trim(); // e.g. "2 hours", "5 minutes", "About a minute"
  const num = Number.parseInt(human, 10);
  if (human.includes("second")) return Number.isFinite(num) ? `${num}s` : "<1m";
  if (human.includes("minute")) return Number.isFinite(num) ? `${num}m` : "<1m";
  if (human.includes("hour")) return Number.isFinite(num) ? `${num}h` : "1h";
  if (human.includes("day")) return Number.isFinite(num) ? `${num}d` : "1d";
  return human;
};

// =============================================================================
// Help printer
// =============================================================================

/** Print a usage block for a single verb. Called when a verb is invoked
 *  without arguments — discoverability over failure. */
export const helpFor = (name: string, lines: string[]) => {
  console.log(`${color.bold}${name}${color.reset}`);
  for (const l of lines) console.log(`  ${l}`);
  console.log("");
  console.log(`See all commands: ${color.cyan}bun run dev:help${color.reset}`);
};
