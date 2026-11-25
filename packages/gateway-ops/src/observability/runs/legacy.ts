/**
 * The Jobs and Deliveries pages became the runs list. Their addresses still work: these functions turn them into the
 * runs address with the same filters. A parameter without a counterpart is carried over, so the list names it as not
 * applied instead of dropping it silently.
 */
import { RUNS_PATH } from "./query";

const JOB_WINDOWS: Record<string, string> = { "10m": "last-10m", "1h": "last-1h", "12h": "last-12h", "7d": "last-7d", "30d": "last-30d" };
const JOB_HEALTH: Record<string, string> = { failed: "failed", running: "running", stuck: "running", healthy: "succeeded" };
const DELIVERY_STATUS: Record<string, string> = {
  failed: "failed",
  sending: "running",
  pending: "waiting",
  deferred: "waiting",
  delivered: "succeeded",
  suppressed: "canceled",
};
/** The run-now feedback of the old Jobs page: it said what happened once and has no place in a list address. */
const JOB_FEEDBACK = new Set(["job_action", "job_message", "successPage"]);

const href = (params: URLSearchParams) => {
  const text = params.toString().replace(/%(?:2C|3A|2F|40)/gi, (escape) => decodeURIComponent(escape));
  return text ? `${RUNS_PATH}?${text}` : RUNS_PATH;
};

/** `/admin/observability/jobs?…` as a runs address: job runs with the same window, health, type, duration and search. */
export const legacyJobsHref = (params: URLSearchParams): string => {
  const next = new URLSearchParams({ kind: "job" });
  for (const [name, value] of params) {
    if (JOB_FEEDBACK.has(name)) continue;
    if (name === "window") {
      if (JOB_WINDOWS[value]) next.set("time", JOB_WINDOWS[value]);
      else if (value !== "24h") next.append("window", value);
    } else if (name === "health") {
      if (JOB_HEALTH[value]) next.set("status", JOB_HEALTH[value]);
      else if (value !== "all") next.append("health", value);
    } else if (name === "type") {
      if (value !== "all") next.set("category", value);
    } else if (name === "duration") {
      if (value !== "all") next.set("duration", value);
    } else if (name === "search") {
      if (value.trim()) next.set("q", value.trim());
    } else if (name === "run") {
      next.set("run", `job:${value}`);
    } else next.append(name, value);
  }
  return href(next);
};

/**
 * `/admin/observability/deliveries?…` as a runs address, for the deliveries view. The notification definitions and the
 * earlier notifications (`view=registry`, `view=legacy`) stay on their page: this returns null for them.
 */
export const legacyDeliveriesHref = (params: URLSearchParams): string | null => {
  const view = params.get("view");
  if (view === "registry" || view === "legacy") return null;
  const next = new URLSearchParams({ kind: "delivery" });
  for (const [name, value] of params) {
    if (name === "view") continue;
    if (name === "status") {
      if (DELIVERY_STATUS[value]) next.set("status", DELIVERY_STATUS[value]);
      else if (value !== "all") next.append("status", value);
    } else if (name === "apps" || name === "channels") {
      // The runs list filters one app and one channel; further ones are carried over and named as not applied.
      const [first, ...rest] = value.split(",").map((part) => part.trim()).filter(Boolean);
      if (first) next.set(name === "apps" ? "app" : "channel", first);
      if (rest.length > 0) next.append(name, rest.join(","));
    } else if (name === "search") {
      if (value.trim()) next.set("q", value.trim());
    } else next.append(name, value);
  }
  return href(next);
};
