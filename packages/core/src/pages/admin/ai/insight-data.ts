import { aiModelCatalog, aiQuotas, aiUsage, quotaAdminConfig, quotaReport } from "@k2b/cloud/ai/admin";
import { AiQuotaReportQuerySchema, AiUsageQuerySchema } from "@k2b/cloud/shared";
import type { AiPageInput } from "./page-input";

/**
 * The usage explorer's report for the filters in the address; `null` when the address holds no valid filters. Which
 * table the comparison shows (`compare=models`) and the open run or rating (`run`, `rating`) stay in the address too;
 * the open entry is one of the report's rows, so it needs no read of its own.
 */
export const loadAiUsage = async (input: AiPageInput) => {
  const parsed = AiUsageQuerySchema.safeParse(input.query);
  if (!parsed.success) return null;
  return {
    report: await aiUsage.report(parsed.data.range, parsed.data),
    compare: input.query.compare === "models" ? ("models" as const) : ("users" as const),
    open: { run: input.query.run ?? null, feedback: input.query.feedback ?? null },
    timeZone: input.dates.timeZone,
  };
};

/**
 * Use per person under Budgets: the budget configuration, the models a rule names, the people report, and for the
 * person the address names (`identity`, `identityType`) their current allowances, read on the server like the rest.
 */
export const loadAiPeople = async (input: AiPageInput) => {
  const query = AiQuotaReportQuerySchema.safeParse({ ...input.query, view: "users" });
  const identity = query.success ? query.data.identity : undefined;
  const type = query.success ? query.data.identityType : "user";
  const [config, models, report, balance] = await Promise.all([
    quotaAdminConfig(),
    aiModelCatalog.models(),
    quotaReport({ ...input.query, view: "users" }),
    identity
      ? aiQuotas
          .snapshot(type === "user" ? { type: "user", userId: identity } : { type: "service_account", serviceAccountId: identity })
          .catch(() => null)
      : Promise.resolve(null),
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
    balance,
    timeZone: input.dates.timeZone,
  };
};

export type AiUsageData = NonNullable<Awaited<ReturnType<typeof loadAiUsage>>>;
export type AiPeopleData = Awaited<ReturnType<typeof loadAiPeople>>;
