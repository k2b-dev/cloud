import { z } from "zod";

/**
 * Maintenance mode: the contract Core, the gateway and `cld` share.
 *
 * Core writes one state record to a Sync ephemeral next to the app registry
 * (`services/maintenance-state`). The gateway watches it and answers every
 * request by itself while it exists, except the admin API below, which still
 * reaches Core so `cld admin maintenance off` keeps working.
 */

/** Public, unauthenticated gateway status that the maintenance page polls; answered from gateway memory. */
export const GATEWAY_STATUS_PATH = "/_cloud/gateway/status";

/** Core's admin API for the switch. The gateway passes exactly this path and its subpaths to Core during maintenance. */
export const MAINTENANCE_ADMIN_API_PATH = "/api/admin/maintenance";

export const MAINTENANCE_MESSAGE_MAX_LENGTH = 500;

/** `Retry-After` seconds: whole-Cloud maintenance, and one app restarting or unreachable. */
export const MAINTENANCE_RETRY_AFTER_SECONDS = 30;
export const APP_UNAVAILABLE_RETRY_AFTER_SECONDS = 5;

/** Stable problem codes; `cld` and other machine clients branch on these, never on the title. */
export const MAINTENANCE_PROBLEM_CODES = ["maintenance", "app_unavailable"] as const;
export type MaintenanceProblemCode = (typeof MAINTENANCE_PROBLEM_CODES)[number];

const epochMs = z.number().int().positive().max(8.64e15);

/**
 * The stored record. `bypassKey` belongs to the gateway alone (admin bypass link, a later step);
 * no API, page, log or status answer ever exposes it.
 */
export const MaintenanceStateSchema = z.object({
  id: z.string().min(1).max(64),
  startedAt: epochMs,
  startedBy: z.object({ id: z.string().min(1).max(200), label: z.string().max(200) }),
  message: z.string().min(1).max(MAINTENANCE_MESSAGE_MAX_LENGTH).optional(),
  until: epochMs.optional(),
  quiesce: z.boolean(),
  bypassKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});
export type MaintenanceState = z.infer<typeof MaintenanceStateSchema>;

/** A record from the store, or `null` for anything that is not a valid state. Never throws. */
export const parseMaintenanceState = (value: unknown): MaintenanceState | null => {
  const parsed = MaintenanceStateSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
};

/** Normalizes an operator message: trimmed, line breaks kept, empty means none. */
export const normalizeMaintenanceMessage = (value: string | null | undefined): string | undefined => {
  const trimmed = value?.replace(/\r\n?/g, "\n").trim();
  return trimmed ? trimmed : undefined;
};

/** `503` body for API and other non-page requests (`application/problem+json`). */
export const MaintenanceProblemSchema = z.object({
  type: z.literal("about:blank"),
  title: z.string(),
  status: z.literal(503),
  code: z.enum(MAINTENANCE_PROBLEM_CODES),
  until: z.iso.datetime().optional(),
  appId: z.string().optional(),
});
export type MaintenanceProblem = z.infer<typeof MaintenanceProblemSchema>;

/** `GET /_cloud/gateway/status[?app=<id>]`. */
export type GatewayStatus = {
  maintenance: { active: true; until: string | null } | null;
  app?: { available: boolean };
};

/**
 * What one app instance reports while maintenance stage „Ruhe“ (quiesce) is
 * on: the background work it still runs. 0 means quiet.
 */
export const QuietReportSchema = z.object({
  appId: z.string().min(1).max(200),
  instanceId: z.string().min(1).max(64),
  inFlight: z.number().int().min(0).max(1_000_000),
});
export type QuietReport = z.infer<typeof QuietReportSchema>;

/** One running app that is not quiet yet: work still running, or instances that have not reported. */
export const MaintenanceBusyAppSchema = z.object({
  id: z.string(),
  name: z.string(),
  inFlight: z.number().int(),
  unreported: z.number().int(),
});
export type MaintenanceBusyApp = z.infer<typeof MaintenanceBusyAppSchema>;

/** What Core's admin API reports. Person names appear only here, never on the public page. */
export const MaintenanceStatusSchema = z.object({
  active: z.boolean(),
  startedAt: z.iso.datetime().optional(),
  startedBy: z.object({ id: z.string(), label: z.string() }).optional(),
  message: z.string().optional(),
  until: z.iso.datetime().optional(),
  /** Stage „Ruhe“: background work stops while maintenance is on. Present while active. */
  quiesce: z.boolean().optional(),
  /** Running apps whose every instance reports no work in flight, against all running apps. Present while quiesced. */
  quiet: z.object({ quiet: z.number().int(), total: z.number().int(), busy: z.array(MaintenanceBusyAppSchema) }).optional(),
  /** Known apps (Core's catalogue, not removed) against the apps registered right now. */
  apps: z.object({ ready: z.number().int(), total: z.number().int(), starting: z.array(z.string()) }),
});
export type MaintenanceStatus = z.infer<typeof MaintenanceStatusSchema>;

export const MaintenanceOnInputSchema = z
  .object({
    message: z
      .string()
      .max(MAINTENANCE_MESSAGE_MAX_LENGTH * 2)
      .optional(),
    until: z.iso.datetime({ offset: true }).optional(),
    /** Stage „Ruhe“ on or off; omitted keeps the running value (off for a new maintenance). */
    quiesce: z.boolean().optional(),
  })
  .strict();
export type MaintenanceOnInput = z.infer<typeof MaintenanceOnInputSchema>;

export const MaintenanceUntilInputSchema = z.object({ until: z.iso.datetime({ offset: true }) }).strict();
export type MaintenanceUntilInput = z.infer<typeof MaintenanceUntilInputSchema>;
