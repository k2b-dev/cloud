import type { PulseSource } from "../../contracts";
import type { AlertAttention } from "../../service/base-attention";

/**
 * The decisions behind the Sources tab, free of rendering: which state the base page shows, what the status row says
 * and which rows need attention in which order. Render tests pin these rules.
 */

export type BasePageState = "noAccess" | "loading" | "storeDown" | "empty" | "ready";

/** One state per page, most fundamental first: without access nothing else is known; a switch replaces the page. */
export const basePageState = (input: { denied: boolean; switching: boolean; storeDown: boolean; sourceCount: number }): BasePageState =>
  input.denied ? "noAccess" : input.switching ? "loading" : input.storeDown ? "storeDown" : input.sourceCount === 0 ? "empty" : "ready";

export type SourceProblem = "rejected" | "error" | "throttled" | "stale";
export type AttentionTone = "danger" | "warning";

export type AttentionItem =
  | { kind: "source"; id: string; tone: AttentionTone; problem: SourceProblem; since: string | null; source: PulseSource }
  | { kind: "alert"; id: string; tone: AttentionTone; since: string | null; alert: AlertAttention };

/**
 * The most urgent problem of one source, or null. Refused requests come first: the source still sends, but nothing
 * arrives. A paused source never needs attention.
 */
export const sourceProblem = (source: PulseSource): SourceProblem | null => {
  if (!source.enabled) return null;
  if ((source.status.rejected?.last24h ?? 0) > 0) return "rejected";
  if (source.status.lastError) return "error";
  if (source.status.throttled) return "throttled";
  if (source.staleSince) return "stale";
  return null;
};

const problemSince = (source: PulseSource, problem: SourceProblem): string | null =>
  // Refused requests: nothing has arrived since the newest accepted entry.
  problem === "rejected"
    ? (source.status.newestDataAt ?? source.status.rejected?.lastAt ?? null)
    : problem === "error"
      ? (source.status.lastErrorAt ?? source.lastErrorAt)
      : problem === "throttled"
        ? source.status.throttledAt
        : source.staleSince;

const RANK = { error: 0, critical: 1, warn: 2, throttled: 3, stale: 4, alertTrouble: 5 } as const;

const rank = (item: AttentionItem): number => {
  if (item.kind === "source")
    return item.problem === "rejected" || item.problem === "error"
      ? RANK.error
      : item.problem === "throttled"
        ? RANK.throttled
        : RANK.stale;
  if (item.alert.state === "firing") return item.alert.severity === "critical" ? RANK.critical : RANK.warn;
  return RANK.alertTrouble;
};

/**
 * Everything that needs a person, most urgent first: sources that send without arriving, fired critical then warning
 * alerts, throttled and stale sources, then alerts that cannot be checked. Older problems first within one rank.
 */
export const attentionItems = (sources: readonly PulseSource[], alerts: readonly AlertAttention[]): AttentionItem[] => {
  const items: AttentionItem[] = [];
  for (const source of sources) {
    const problem = sourceProblem(source);
    if (!problem) continue;
    items.push({
      kind: "source",
      id: `source:${source.id}`,
      tone: problem === "rejected" || problem === "error" ? "danger" : "warning",
      problem,
      since: problemSince(source, problem),
      source,
    });
  }
  for (const alert of alerts) {
    items.push({
      kind: "alert",
      id: `alert:${alert.reference}`,
      tone: alert.state === "firing" && alert.severity === "critical" ? "danger" : "warning",
      since: alert.since,
      alert,
    });
  }
  return items.sort((a, b) => rank(a) - rank(b) || (a.since ?? "").localeCompare(b.since ?? "") || a.id.localeCompare(b.id));
};

export type SourcesSummary =
  | { kind: "empty" }
  | { kind: "all"; total: number }
  | { kind: "some"; received: number; total: number }
  | { kind: "attention"; count: number };

/** A source receives when it is on, has data, and has no problem. */
export const sourceReceives = (source: PulseSource): boolean =>
  source.enabled && Boolean(source.status.newestDataAt ?? source.lastSeenAt) && sourceProblem(source) === null;

/** The lead statement of the status row: does data arrive? */
export const sourcesSummary = (sources: readonly PulseSource[]): SourcesSummary => {
  if (!sources.length) return { kind: "empty" };
  const troubled = sources.filter((source) => sourceProblem(source) !== null).length;
  if (troubled) return { kind: "attention", count: troubled };
  const received = sources.filter(sourceReceives).length;
  return received === sources.length ? { kind: "all", total: sources.length } : { kind: "some", received, total: sources.length };
};

/** The newest arrival over all sources, for the status row's key figure. */
export const newestArrival = (sources: readonly PulseSource[]): string | null =>
  sources.reduce<string | null>((newest, source) => {
    const at = source.status.newestDataAt ?? source.lastSeenAt;
    return at && (!newest || at > newest) ? at : newest;
  }, null);
