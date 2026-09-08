import { z } from "zod";

export const AI_USAGE_RANGES = ["24h", "7d", "30d", "90d"] as const;
export const AI_USAGE_VIEWS = ["overview", "comparisons", "feedback", "runs"] as const;
export const AI_USAGE_REASONS = ["incorrect", "did_not_follow_request", "incomplete", "poor_tool_choice", "too_slow", "other"] as const;
const text = z.string().trim().min(1).max(200).optional();
export const AiUsageQuerySchema = z.object({
  range: z.enum(AI_USAGE_RANGES).default("30d"),
  until: z.iso.datetime({ offset: true }).optional(),
  userId: z.union([z.uuid(), z.literal("unassigned")]).optional(),
  modelProfileId: text,
  providerModel: text,
  appId: text,
  view: z.enum(AI_USAGE_VIEWS).default("overview"),
  kind: z.enum(["chat", "background", "tool"]).optional(),
  status: z
    .enum([
      "completed",
      "failed",
      "aborted",
      "queued",
      "running",
      "waiting_for_action",
      "rejected",
      "pending",
      "waiting_for_approval",
      "waiting_for_frontend",
    ])
    .optional(),
  task: text,
  errorCode: text,
  search: z.string().trim().max(200).optional(),
  rating: z.enum(["up", "down"]).optional(),
  reason: z.enum(AI_USAGE_REASONS).optional(),
  sort: z.enum(["newest", "runs", "tokens", "credits", "errors", "negative", "negativeRate"]).default("runs"),
  page: z.coerce.number().int().min(1).max(1000000).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(50),
});
export type AiUsageQuery = z.infer<typeof AiUsageQuerySchema>;
export type AiUsageRange = AiUsageQuery["range"];
export type AiUsageView = AiUsageQuery["view"];

/** Same URL contract for page navigation, HTTP clients, and CLI. */
export const aiUsageSearchParams = (query: Partial<AiUsageQuery>): URLSearchParams => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== "") params.set(key, String(value));
  return params;
};
export const aiUsageHref = (query: Partial<AiUsageQuery>) => `/admin/settings?tab=ai-usage&${aiUsageSearchParams(query)}`;
