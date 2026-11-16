/**
 * The maintenance signals every open page reads, without schemas: the shell watches for them on every page and must
 * not load the validators in `./maintenance` for that. `./maintenance` re-exports everything here.
 */

/** Public, unauthenticated gateway status that the maintenance page polls; answered from gateway memory. */
export const GATEWAY_STATUS_PATH = "/_cloud/gateway/status";

/** Core's admin API for the switch. The gateway passes exactly this path and its subpaths to Core during maintenance. */
export const MAINTENANCE_ADMIN_API_PATH = "/api/admin/maintenance";

/** Stable problem codes; `cld` and other machine clients branch on these, never on the title. */
export const MAINTENANCE_PROBLEM_CODES = ["maintenance", "app_unavailable"] as const;
export type MaintenanceProblemCode = (typeof MAINTENANCE_PROBLEM_CODES)[number];

/** Why an app is away: it deregistered cleanly on shutdown ("updating"), or anything else ("unavailable"). */
export type AppUnavailableReason = "updating" | "unavailable";

/**
 * Request header the gateway sets to `1` on a request it lets past the maintenance wall with a valid admin bypass
 * cookie. The gateway removes it from every incoming request, so only the gateway can set it; apps read it to show
 * that only this person sees the Cloud.
 */
export const MAINTENANCE_BYPASS_HEADER = "X-Cloud-Maintenance-Bypass";

/**
 * `GET /_cloud/gateway/status[?app=<id>]`. `bypass` is present only on the Cloud host for a browser whose admin
 * bypass link is valid for the running maintenance: it sees the Cloud while everyone else sees the page.
 */
export type GatewayStatus = {
  maintenance: { active: true; until: string | null; bypass?: true } | null;
  app?: { available: boolean };
};

/** What is being waited for: the whole Cloud in maintenance, or one app restarting. */
export type MaintenancePollKind = "cloud" | "app";

/**
 * Status polling of the maintenance page and of open pages: `[from elapsed ms, delay ms]`, the last step whose start
 * has passed wins. Each delay varies by ±20 %, so open pages do not all ask at the same moment.
 */
export const MAINTENANCE_POLL_STEPS: Record<MaintenancePollKind, readonly (readonly [number, number])[]> = {
  cloud: [
    [0, 5_000],
    [120_000, 15_000],
    [600_000, 30_000],
  ],
  app: [
    [0, 2_000],
    [30_000, 5_000],
    [120_000, 15_000],
  ],
};

/** Delay before the next status check, `elapsedMs` after waiting began; `random` in [0, 1). */
export const maintenancePollDelay = (kind: MaintenancePollKind, elapsedMs: number, random: number): number => {
  let delay = 0;
  for (const [from, ms] of MAINTENANCE_POLL_STEPS[kind]) if (elapsedMs >= from || delay === 0) delay = ms;
  return delay * (0.8 + 0.4 * random);
};
