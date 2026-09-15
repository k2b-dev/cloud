import { z } from "zod";
import { PrincipalSchema } from "../contracts/shared";

export const AiQuotaRuleSchema = z
  .object({
    scope: z.string().min(1).max(128),
    hours: z.number().int().min(1).max(8760),
    anchor: z.iso.datetime(),
    grants: z
      .array(
        z
          .object({
            principal: PrincipalSchema.refine((p) => p.type !== "public", "Chat quotas require an identity."),
            displayName: z.string().max(300).optional(),
            limit: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
          })
          .strict(),
      )
      .max(1000)
      .refine((grants) => new Set(grants.map((g) => JSON.stringify(g.principal))).size === grants.length, "Duplicate quota principal."),
  })
  .strict();
export const AiQuotaConfigSchema = z
  .object({
    enabled: z.boolean(),
    revision: z.number().int().nonnegative(),
    rules: z.array(AiQuotaRuleSchema).max(256),
  })
  .strict()
  .refine((c) => new Set(c.rules.map((r) => r.scope)).size === c.rules.length, "Duplicate quota scope.");
export type AiQuotaConfig = z.infer<typeof AiQuotaConfigSchema>;
export type AiQuotaRule = z.infer<typeof AiQuotaRuleSchema>;
export type AiQuotaBalance = {
  scope: string;
  limit: number | null;
  input: number;
  output: number;
  used: number;
  unknown: number;
  estimated?: number;
  resetsAt: string;
  sources: string[];
  bypassed: boolean;
};
export type AiQuotaSnapshot = {
  enabled: boolean;
  balances: AiQuotaBalance[];
  usage: { model: string; input: number; output: number; unknown: number }[];
};
export type AiQuotaIdentity = { type: "user" | "service_account"; id: string; label: string; lastUsed: string | null };
export const AiQuotaIdentitySchema = z.object({ type: z.enum(["user", "service_account"]), id: z.uuid() });
export const AiQuotaResetSchema = AiQuotaIdentitySchema.extend({ scope: z.string().min(1).max(128), requestId: z.uuid() }).strict();
export const AiQuotaUsersQuerySchema = z
  .object({
    search: z.string().max(200).default(""),
    page: z.coerce.number().int().positive().default(1),
  })
  .strict();

export type AiChatQuotaSnapshot = { enabled: boolean; balances: Omit<AiQuotaBalance, "sources">[] };

export const AiQuotaReportQuerySchema = z.object({
  view: z.enum(["users", "rules"]).default("users"),
  range: z.enum(["24h", "7d", "30d", "90d"]).default("30d"),
  until: z.iso.datetime({ offset: true }).optional(),
  search: z.string().trim().max(200).default(""),
  model: z.string().max(128).default(""),
  status: z.enum(["all", "available", "exhausted", "unknown", "unlimited", "disabled"]).default("all"),
  sort: z.enum(["label", "tokens", "lastUsed"]).default("lastUsed"),
  direction: z.enum(["asc", "desc"]).default("desc"),
  page: z.coerce.number().int().min(1).max(1000000).default(1),
  identity: z.uuid().optional(),
  identityType: z.enum(["user", "service_account"]).default("user"),
});
export type AiQuotaReportQuery = z.infer<typeof AiQuotaReportQuerySchema>;
export type AiQuotaStatus = Exclude<AiQuotaReportQuery["status"], "all">;
export type AiQuotaReportRow = AiQuotaIdentity & {
  input: number;
  output: number;
  calls: number;
  measured: number;
  estimated: number;
  unknown: number;
  status: AiQuotaStatus;
  scopes: number;
  exhausted: number;
};
export type AiQuotaReport = {
  query: AiQuotaReportQuery;
  since: string;
  until: string;
  asOf: string;
  overview: { accounts: number; input: number; output: number; calls: number; measured: number; estimated: number; unknown: number };
  timeline: { at: string; input: number; output: number; calls: number; measured: number; unknown: number }[];
  models: { model: string; input: number; output: number; calls: number; measured: number; unknown: number }[];
  selected: AiQuotaIdentity | null;
  items: AiQuotaReportRow[];
  total: number;
  page: number;
  perPage: number;
};
export const aiQuotaHref = (query: Partial<AiQuotaReportQuery>) => {
  const params = new URLSearchParams({ tab: "ai-quotas" });
  for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== "") params.set(key, String(value));
  return `/admin/settings?${params}`;
};
