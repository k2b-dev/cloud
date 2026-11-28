import {
  type AiAdminOverview,
  type AiModelAccessMap,
  aiModelAccess,
  aiModelCatalog,
  aiModelUsage,
  backgroundCostState,
  quotaAdminConfig,
  quotaReport,
  type readAiAdminCatalog,
} from "@k2b/cloud/ai/admin";
import { coreSettings } from "@k2b/cloud/services";
import type { AiModel, AiModelSlot, AiModelUsage, AiModelVariant, AiProvider, AiQuotaConfig } from "@k2b/cloud/shared";
import type { BackgroundCostState } from "../settings/_components/AiBackgroundBudget";
import type { AiAreaQuery } from "./area";
import type { AiCatalogIndex } from "./presentation";
import { aiProvidersView } from "./provider-view";

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

type ModelDetail = AiModel & { variants: AiModelVariant[]; access?: AiModelAccessMap[string] };

/** What the page reads once per request and passes to each section: the overview, providers, models and variants. */
export type AiCatalog = Awaited<ReturnType<typeof readAiAdminCatalog>> & { index: AiCatalogIndex };

/**
 * Providers: the overview's providers with what the view shows of the catalog (`aiProvidersView`); an open provider
 * with its connection and models, an open model with its variants, use and access, or the provider's connection form.
 * The provider, its models and the model's variants come from the catalog the page read; only the model's access is
 * read here.
 */
export const loadAiProviders = async ({ overview, providers, index }: AiCatalog, query: AiAreaQuery) => {
  const provider: AiProvider | null = (query.p ? providers.find((candidate) => candidate.id === query.p) : undefined) ?? null;
  const opened = query.m && provider ? index.models.find((model) => model.id === query.m) : undefined;
  const variants = opened ? index.variants.filter((variant) => variant.modelId === opened.id) : [];
  const [access, usage, quota] = opened
    ? await Promise.all([
        aiModelAccess.listForAdmin().catch(quiet),
        aiModelUsage(
          variants.map((variant) => variant.id),
          [opened.id],
        ).catch((): AiModelUsage | null => null),
        quotaAdminConfig().catch(() => null),
      ])
    : [null, null, null];
  const model: ModelDetail | null = opened && access !== failed ? { ...opened, variants, access: access?.[opened.id] } : null;
  return {
    overview,
    ...aiProvidersView(index, query),
    open: { p: query.p ?? null, m: query.m ?? null, connection: query.pane === "conn", dialog: query.o ?? null, mq: query.mq ?? "" },
    provider,
    model,
    usage: model ? usage : null,
    accountingUnit: model ? (quota?.unit ?? null) : null,
    /** The address names a model whose access the page could not read (not one that is gone). */
    detailFailed: access === failed,
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
