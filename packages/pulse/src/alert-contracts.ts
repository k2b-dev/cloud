import { z } from "zod";

export const ALERT_MAX_KEYS = 100;
export const ALERT_MIN_INTERVAL_SECONDS = 300;
export const ALERT_MAX_EXECUTION_MS = 10_000;
// Twenty rules × twelve checks; edits and replacements spend the same budget.
export const ALERT_CHECKS_PER_HOUR = 240;
export const ALERT_STATES = ["ok", "pending", "firing", "no_data", "error"] as const;
export type AlertStateName = (typeof ALERT_STATES)[number];
export type AlertSeverity = "warn" | "critical";

export const AlertThresholdSchema = z
  .object({
    comparison: z.enum(["above", "below"]),
    warn: z.number().finite().nullable(),
    critical: z.number().finite().nullable(),
    minDurationSeconds: z.number().int().min(0).max(2_147_483_647),
    intervalSeconds: z.number().int().min(ALERT_MIN_INTERVAL_SECONDS).max(2_147_483_647),
  })
  .superRefine((rule, context) => {
    if (rule.warn === null && rule.critical === null)
      context.addIssue({ code: "custom", message: "Set a warning or critical threshold", path: ["warn"] });
    if (
      rule.warn !== null &&
      rule.critical !== null &&
      (rule.comparison === "above" ? rule.critical < rule.warn : rule.critical > rule.warn)
    )
      context.addIssue({ code: "custom", message: "The critical threshold must be at least as severe as the warning", path: ["critical"] });
  });

export type AlertThresholds = z.infer<typeof AlertThresholdSchema>;
export type AlertKeyState = {
  key: string;
  state: AlertStateName;
  severity: AlertSeverity | null;
  value: number | null;
  since: string;
  pendingSince: string | null;
  incidentOpen: boolean;
  lastCheckedAt: string;
  lastError: string | null;
};

export type AlertRule = AlertThresholds & {
  id: string;
  baseId: string;
  name: string;
  sql: string;
  params: Record<string, string>;
  revision: number;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
};
