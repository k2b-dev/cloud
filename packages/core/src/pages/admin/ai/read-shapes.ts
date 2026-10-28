import { AiModelSchema, AiProviderSchema, AiQuotaConfigSchema, AiQuotaRuleSchema } from "@k2b/cloud/shared";
import { z } from "zod";

/** Read snapshots include the presentation data returned by the conflict endpoints. */
export const AiProviderDetailSchema = AiProviderSchema.extend({ models: z.array(AiModelSchema) });
export const AiQuotaAdminConfigSchema = AiQuotaConfigSchema.safeExtend({
  rules: z.array(AiQuotaRuleSchema.extend({ peopleAtLimit: z.number().optional() })).max(256),
});
