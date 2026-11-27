import { aiModelCatalog, aiUsage, quotaAdminConfig, quotaReport } from "@k2b/cloud/ai/admin";
import { AiUsageQuerySchema } from "@k2b/cloud/shared";
import type { AiPageInput } from "./page-input";

/** The usage explorer's report for the filters in the address; `null` when the address holds no valid filters. */
export const loadAiUsage = async (input: AiPageInput) => {
  const parsed = AiUsageQuerySchema.safeParse(input.query);
  if (!parsed.success) return null;
  return { report: await aiUsage.report(parsed.data.range, parsed.data) };
};

/** Use per person under Budgets: the budget configuration, the models a rule names, and the people report. */
export const loadAiPeople = async (input: AiPageInput) => {
  const [config, models, report] = await Promise.all([
    quotaAdminConfig(),
    aiModelCatalog.models(),
    quotaReport({ ...input.query, view: "users" }),
  ]);
  return {
    config,
    models: models.map((model) => ({
      id: model.id,
      label: model.label,
      pricing: model.pricing ?? undefined,
      enabled: model.enabled,
      capabilities: model.kind === "transcription" ? ["transcription"] : [...model.capabilities],
    })),
    report,
  };
};

export type AiUsageData = NonNullable<Awaited<ReturnType<typeof loadAiUsage>>>;
export type AiPeopleData = Awaited<ReturnType<typeof loadAiPeople>>;
