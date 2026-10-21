import { z } from "zod";
import { READ_PROFILE_NAMES } from "../store/admin-contracts";

export const SqlLimitsSchema = z.object({
  profile: z.enum(READ_PROFILE_NAMES),
  memoryBytes: z.number(),
  timeSeconds: z.number(),
  maxRows: z.number(),
  maxResultBytes: z.number(),
  queriesUsed: z.number(),
  queriesPerHour: z.number(),
  resetAt: z.string(),
  baseSlots: z.number(),
  cloudSlots: z.number(),
  maxWaiting: z.number(),
  waitMs: z.number(),
});
export const SqlResultSchema = z.object({
  runId: z.uuid(),
  columns: z.array(z.object({ name: z.string(), type: z.string() })),
  rows: z.array(z.array(z.unknown())),
  rowCount: z.number(),
  truncated: z.boolean(),
  stats: z.object({ elapsedMs: z.number(), readRows: z.number(), readBytes: z.number(), memoryBytes: z.number().optional() }),
  limits: SqlLimitsSchema,
});
export const SavedQuerySchema = z.object({
  id: z.string(),
  baseId: z.string(),
  name: z.string(),
  sql: z.string(),
  params: z.record(z.string(), z.string()),
  revision: z.number().int(),
  createdBy: z.string().nullable(),
  updatedBy: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export const SavedQueriesPageSchema = z.object({ items: z.array(SavedQuerySchema), total: z.number(), nextOffset: z.number().nullable() });
