import type { DashboardRefreshInterval, PulsePublicCurrentState, PulsePublicRecordedEvent } from "../contracts";

type PublicDashboardTheme = "light" | "dark";
export type PublicDashboardDisplayHeight = "scroll" | "full";

const PUBLIC_DASHBOARD_DEFAULT_REFRESH_SECONDS = 5;
const PUBLIC_DASHBOARD_MAX_REFRESH_DELAY_MS = 60_000;
const PUBLIC_DASHBOARD_REFRESH_JITTER_MS = 350;

export const parsePublicDashboardTheme = (value: string | null | undefined): PublicDashboardTheme => (value === "dark" ? "dark" : "light");

export const parsePublicDashboardDisplayHeight = (value: string | null | undefined): PublicDashboardDisplayHeight =>
  value === "full" ? "full" : "scroll";

export const resolvePublicDashboardRefreshSeconds = (configured: DashboardRefreshInterval | null | undefined): number | null =>
  configured === null ? null : (configured ?? PUBLIC_DASHBOARD_DEFAULT_REFRESH_SECONDS);

export const publicDashboardRefreshBackoffMs = (intervalSeconds: number, failures: number): number =>
  Math.min(PUBLIC_DASHBOARD_MAX_REFRESH_DELAY_MS, intervalSeconds * 1000 * Math.max(1, 2 ** failures));

export const publicDashboardRefreshJitterMs = (randomValue: number): number =>
  Math.floor(Math.max(0, Math.min(randomValue, 0.999)) * PUBLIC_DASHBOARD_REFRESH_JITTER_MS);

export const publicDashboardRefreshDelayMs = (intervalSeconds: number, failures: number, randomValue: number): number =>
  publicDashboardRefreshBackoffMs(intervalSeconds, failures) + publicDashboardRefreshJitterMs(randomValue);

export const publicDashboardEventSubject = (event: PulsePublicRecordedEvent): string => event.resourceKey || event.resourceType || "-";

export const publicDashboardStateRowId = (state: PulsePublicCurrentState): string => JSON.stringify([state.key, state.variantKey]);

export const sanitizePublicDashboardMarkdown = (input: string): string =>
  input.replace(/!\[[^\]]*]\(\s*https?:\/\/[^)]+\)/gi, "").replace(/<img\b[^>]*>/gi, "");
