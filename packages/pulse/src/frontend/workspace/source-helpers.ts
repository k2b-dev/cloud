import type { PulseSource } from "../../contracts";

export const normalizeEndpointInput = (value: string): string =>
  /^https?:\/\//i.test(value.trim()) ? value.trim() : `https://${value.trim()}`;

export const formatIngestCounts = (counts: { metrics: number; events: number; states: number }): string =>
  [
    `${counts.metrics} metric${counts.metrics === 1 ? "" : "s"}`,
    `${counts.events} event${counts.events === 1 ? "" : "s"}`,
    `${counts.states} state${counts.states === 1 ? "" : "s"}`,
  ].join(", ");

export const parseScrapeInterval = (value: string | null | undefined): number => {
  const parsed = Number(value?.trim() || "60");
  if (!Number.isFinite(parsed)) return 60;
  return Math.min(86_400, Math.max(10, Math.round(parsed)));
};

export const sourceKindIcon = (kind: PulseSource["kind"]): string => {
  if (kind === "http_ingest") return "ti ti-webhook";
  if (kind === "metrics") return "ti ti-plug";
  return "ti ti-database-share";
};

export const sourceStatus = (
  source: PulseSource,
  labels = { paused: "Paused", error: "Error", healthy: "Healthy", waiting: "Waiting" },
) => {
  if (!source.enabled) return { label: labels.paused, dot: "bg-zinc-400", text: "text-dimmed", icon: "ti ti-player-pause" };
  if (source.lastError) return { label: labels.error, dot: "bg-red-500", text: "text-red-600 dark:text-red-300", icon: "ti ti-alert-circle" };
  if (source.lastSeenAt)
    return { label: labels.healthy, dot: "bg-emerald-500", text: "text-emerald-700 dark:text-emerald-300", icon: "ti ti-check" };
  return { label: labels.waiting, dot: "bg-amber-500", text: "text-amber-700 dark:text-amber-300", icon: "ti ti-clock" };
};
