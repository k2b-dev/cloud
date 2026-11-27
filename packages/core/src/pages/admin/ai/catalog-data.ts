import {
  type AiAdminOverview,
  aiModelCatalog,
  aiModelUsage,
  backgroundCostState,
  quotaAdminConfig,
  quotaReport,
} from "@k2b/cloud/ai/admin";
import { coreSettings } from "@k2b/cloud/services";
import type { AiModel, AiModelSlot, AiModelUsage, AiModelVariant, AiProvider, AiQuotaConfig } from "@k2b/cloud/shared";
import type { BackgroundCostState } from "../settings/_components/AiBackgroundBudget";
import type { AiAreaQuery } from "./area";
import type { AiCatalogIndex } from "./presentation";

/** A detail the page could not read for a reason other than "it no longer exists". */
const failed = Symbol("failed");
const quiet = (error: unknown): null | typeof failed => {
  if (error instanceof Error && "code" in error && error.code === "model_not_found") return null;
  console.error("[admin/ai] detail failed", error);
  return failed;
};

/** The budget configuration as the page shows it: each rule with how many people reached it. */
export type AiBudgetConfig = Omit<AiQuotaConfig, "rules"> & { rules: (AiQuotaConfig["rules"][number] & { peopleAtLimit?: number })[] };
const budgetConfig = (config: AiBudgetConfig) => config;

export type AiClassAssignment = Awaited<ReturnType<typeof aiModelCatalog.assignmentsForAdmin>>[number];

/** Model classes and tools: the catalog the overview reads, and for an open slot who uses it in the last 14 days. */
export const loadAiClasses = async (index: AiCatalogIndex, overview: AiAdminOverview, query: AiAreaQuery) => {
  const details = query.slot ? await aiModelCatalog.assignmentsForAdmin().catch(quiet) : null;
  const assignment = details && details !== failed ? (details.find((entry) => entry.slot === query.slot) ?? null) : null;
  return {
    overview,
    models: index.models,
    variants: index.variants,
    slot: (query.slot ?? null) as AiModelSlot | null,
    assignment,
    detailFailed: details === failed,
  };
};

type ModelDetail = AiModel & { variants: AiModelVariant[]; access?: Awaited<ReturnType<typeof aiModelCatalog.modelDetail>>["access"] };

/**
 * Providers: the overview's providers with the catalog; an open provider with its connection and models, an open
 * model with its variants, use and access, or the provider's connection form.
 */
export const loadAiProviders = async (index: AiCatalogIndex, overview: AiAdminOverview, query: AiAreaQuery) => {
  const summary = query.p ? overview.providers.find((candidate) => candidate.id === query.p) : undefined;
  const provider: (AiProvider & { models: AiModel[] }) | null | typeof failed = summary
    ? await aiModelCatalog.providerDetail(summary.id).catch(quiet)
    : null;
  const model: ModelDetail | null | typeof failed =
    query.m && summary && provider !== failed ? await aiModelCatalog.modelDetail(query.m).catch(quiet) : null;
  const [usage, quota] =
    model && model !== failed
      ? await Promise.all([
          aiModelUsage(
            model.variants.map((variant) => variant.id),
            [model.id],
          ).catch((): AiModelUsage | null => null),
          quotaAdminConfig().catch(() => null),
        ])
      : [null, null];
  return {
    overview,
    models: index.models,
    variants: index.variants,
    open: { p: query.p ?? null, m: query.m ?? null, connection: query.pane === "conn", dialog: query.o ?? null, mq: query.mq ?? "" },
    provider: provider === failed ? null : provider,
    model: model === failed ? null : model,
    usage,
    accountingUnit: quota?.unit ?? null,
    /** The address names a provider or model the page could not read (not one that is gone). */
    detailFailed: provider === failed || model === failed,
  };
};

/**
 * Budgets: the rules with how many people reached each, the models a rule can cover, the personalization budget and
 * the spending of the last 30 days from the people report (its total and its days), the figure the section leads with.
 */
export const loadAiBudgets = async (index: AiCatalogIndex, options: { brake?: boolean } = {}) => {
  const [config, personalizationTokens, spend, brake] = await Promise.all([
    quotaAdminConfig(),
    coreSettings.get<number>("ai.memory_learning_monthly_token_budget").catch(() => null),
    quotaReport({ view: "users", range: "30d" })
      .then((report) => ({
        cost: report.overview.cost,
        accounts: report.overview.accounts,
        unknown: report.overview.unknown,
        days: report.timeline.map((point) => point.cost ?? 0),
      }))
      .catch(() => null),
    // The brake's spending of the last 24 hours, only while the brake is open; null tells the browser to ask again.
    options.brake
      ? backgroundCostState()
          .then(
            (state): BackgroundCostState => ({
              used: state.used,
              reserved: state.reserved,
              unknown: state.unknown,
              stoppedAt: state.stoppedAt ? state.stoppedAt.toISOString() : null,
            }),
          )
          .catch(() => null)
      : Promise.resolve(undefined),
  ]);
  return {
    config: budgetConfig(config),
    personalizationTokens,
    spend,
    brake,
    models: index.models
      .filter((model) => (model.kind === "chat" || model.kind === "decision") && model.enabled)
      .map((model) => ({
        id: model.id,
        label: model.label,
        providerId: model.providerId,
        priced: Boolean(model.pricing && (model.pricing.inputPerMillion > 0 || model.pricing.outputPerMillion > 0)),
      })),
  };
};

export type AiClassesData = Awaited<ReturnType<typeof loadAiClasses>>;
export type AiProvidersData = Awaited<ReturnType<typeof loadAiProviders>>;
export type AiBudgetsData = Awaited<ReturnType<typeof loadAiBudgets>>;
