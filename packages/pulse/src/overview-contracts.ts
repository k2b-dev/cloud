import { z } from "zod";
import { OverviewNumberSchema } from "./overview-number";

const at = z.string().datetime();
export const OverviewTileSchema = z.object({
  queryId: z.string(),
  name: z.string(),
  revision: z.number().int().positive(),
  status: z.enum(["ready", "refreshing", "deferred", "no_data", "error"]),
  errorCode: z.string().nullable(),
  lastAttemptAt: at.nullable(),
  nextRefreshAt: at,
  lastGood: z.object({ evaluatedAt: at, windowFrom: at, windowTo: at, data: OverviewNumberSchema }).nullable(),
});
export const OverviewAttentionSchema = z.object({
  id: z.string(),
  kind: z.enum(["alert", "source"]),
  reference: z.string(),
  name: z.string(),
  state: z.enum(["firing", "error", "no_data", "stale"]),
  severity: z.enum(["warn", "critical"]).nullable(),
  since: at,
  lastCheckedAt: at.nullable(),
  errorCode: z.string().nullable(),
  key: z.string().nullable(),
  value: z.number().nullable(),
  comparison: z.enum(["above", "below"]).nullable(),
  threshold: z.number().nullable(),
  newestDataAt: at.nullable(),
  expectEverySeconds: z.number().nullable(),
  expectDailyBy: z.string().nullable(),
});
export const OverviewActivitySchema = z.object({
  id: z.uuid(),
  at,
  kind: z.string(),
  actor: z.object({ kind: z.enum(["user", "service_account"]), id: z.string(), name: z.string() }).nullable(),
  data: z.record(z.string(), z.unknown()),
});
export const OverviewSchema = z.object({
  baseId: z.string(),
  name: z.string(),
  timezone: z.string(),
  readAt: at,
  storeUnavailable: z.boolean(),
  sources: z.object({ total: z.number().int(), current: z.number().int() }),
  attention: z.object({ items: z.array(OverviewAttentionSchema), total: z.number().int(), nextOffset: z.number().int().nullable() }),
  numbers: z.array(OverviewTileSchema).max(4),
  activity: z.object({ items: z.array(OverviewActivitySchema), nextCursor: z.string().nullable() }),
});
export type Overview = z.infer<typeof OverviewSchema>;
export type OverviewAttention = z.infer<typeof OverviewAttentionSchema>;
export type OverviewActivity = z.infer<typeof OverviewActivitySchema>;
