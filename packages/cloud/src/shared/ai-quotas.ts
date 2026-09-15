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
