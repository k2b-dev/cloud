import { z } from "zod";
import { AlertThresholdSchema } from "../alert-contracts";

export const AlertSaveSchema = AlertThresholdSchema.safeExtend({
  name: z.string().trim().min(1).max(120),
  sql: z.string(),
  params: z.record(z.string(), z.string()).optional(),
}).strict();
export const AlertRuleSchema = AlertSaveSchema.safeExtend({
  id: z.string(),
  baseId: z.string(),
  params: z.record(z.string(), z.string()),
  revision: z.number().int().positive(),
  createdBy: z.string().nullable(),
  updatedBy: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export const AlertRulesPageSchema = z.object({
  items: z.array(AlertRuleSchema),
  total: z.number().int(),
  nextOffset: z.number().int().nullable(),
});
