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
  return Math.min(86_400, Math.max(60, Math.ceil(parsed / 60) * 60));
};

export const sourceKindIcon = (kind: PulseSource["kind"]): string => {
  if (kind === "http_ingest") return "ti ti-webhook";
  if (kind === "metrics") return "ti ti-plug";
  return "ti ti-database-share";
};

type SourceStatusLabels = { paused: string; error: string; healthy: string; waiting: string; throttled: string; throttledDetail: string };
export type SourceStatusTone = "ok" | "warning" | "error" | "neutral";

/** One status per source, most urgent first: a throttled base refuses values even when its last scrape worked. */
export const sourceStatus = (
  source: PulseSource,
  labels: SourceStatusLabels,
): { label: string; tone: SourceStatusTone; title?: string } => {
  if (!source.enabled) return { label: labels.paused, tone: "neutral" };
  if (source.status.throttled) return { label: labels.throttled, tone: "warning", title: labels.throttledDetail };
  if (source.status.lastError) return { label: labels.error, tone: "error" };
  if (source.status.newestDataAt || source.lastSeenAt) return { label: labels.healthy, tone: "ok" };
  return { label: labels.waiting, tone: "neutral" };
};
