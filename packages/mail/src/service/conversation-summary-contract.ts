import { z } from "zod";
import type { ConversationContentSummary } from "./conversation-summary";

const source = z.object({ id: z.string(), name: z.string() });
const allowance = z.object({ unlimited: z.boolean(), usedPercent: z.number().min(0).max(100).nullable(), resetsAt: z.string().nullable() });
export const conversationSummaryStateSchema = z.object({
  summary: z.string().nullable(),
  summaryRevision: z.number().int().positive(),
  conversationRevision: z.number().int().positive(),
  source: z.enum(["person", "workflow", "manual_ai"]).nullable(),
  author: source.extend({ kind: z.enum(["user", "workflow"]) }).nullable(),
  ai: z.boolean(),
  generatedAt: z.string().nullable(),
  coveredMessageCount: z.number().int().nonnegative().nullable(),
  truncated: z.boolean(),
  nextStep: z.object({ text: z.string(), due: z.string().nullable() }).nullable(),
  newMessagesSince: z.number().int().nonnegative(),
  status: z.enum(["idle", "pending", "writing", "failed", "limited"]),
  failure: z
    .object({
      code: z.enum(["timeout", "provider_unavailable", "input_too_large", "allowance_exhausted", "internal"]),
      attempts: z.number().int().nonnegative(),
      lastAttemptAt: z.string(),
      workflow: source.nullable(),
    })
    .nullable(),
  limit: z
    .object({
      scope: z.enum(["rule", "mailbox"]),
      workflow: source.nullable(),
      limit: z.number().int().nonnegative(),
      resetsAt: z.string(),
    })
    .nullable(),
  allowance: allowance.nullable(),
  canGenerate: z.boolean(),
}) satisfies z.ZodType<ConversationContentSummary>;
