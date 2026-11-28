import { coreSettings } from "../services";
import { AI_MODEL_CLASSES, type AiModel, type AiModelClass, type AiModelSlot, type AiProvider } from "../shared/ai-models";
import { aiModelCatalog } from "./model-catalog";
import { resolveAiModelRef } from "./settings";

export type AiAdminOverview = {
  enabled: boolean;
  providers: (Pick<
    AiProvider,
    | "id"
    | "type"
    | "label"
    | "dataBoundary"
    | "enabled"
    | "status"
    | "statusCode"
    | "statusMessage"
    | "statusCheckedAt"
    | "logo"
    | "credentialSet"
  > & {
    modelCount: number;
  })[];
  assignments: Record<AiModelSlot, { variantId: string | null; revision: number; updatedAt: string; updatedBy: string | null }>;
  effective: Record<AiModelClass, { class: AiModelClass | null; variantId: string | null }>;
};

const readCatalog = () =>
  Promise.all([coreSettings.get<boolean>("ai.enabled"), aiModelCatalog.providers(), aiModelCatalog.models(), aiModelCatalog.assignments()]);

/** What the AI area's first column and the class rows need, read once for the page and the API. */
export const readAiAdminOverview = async (): Promise<AiAdminOverview> => presentOverview(...(await readCatalog()));

/**
 * The overview with the providers and models it was read from, for a page that shows both: each is read once per
 * request and passed on, never read again.
 */
export const readAiAdminCatalog = async (): Promise<{ overview: AiAdminOverview; providers: AiProvider[]; models: AiModel[] }> => {
  const read = await readCatalog();
  return { overview: presentOverview(...read), providers: read[1], models: read[2] };
};

const presentOverview = (
  enabled: boolean,
  providers: AiProvider[],
  models: AiModel[],
  assignments: Awaited<ReturnType<typeof aiModelCatalog.assignments>>,
): AiAdminOverview => {
  return {
    enabled,
    providers: providers.map((p) => ({
      id: p.id,
      type: p.type,
      label: p.label,
      dataBoundary: p.dataBoundary,
      enabled: p.enabled,
      status: p.status,
      statusCode: p.statusCode,
      statusMessage: p.statusMessage,
      statusCheckedAt: p.statusCheckedAt,
      credentialSet: p.credentialSet,
      modelCount: models.filter((m) => m.providerId === p.id).length,
      logo: p.logo,
    })),
    assignments: Object.fromEntries(assignments.map(({ slot, ...assignment }) => [slot, assignment])) as AiAdminOverview["assignments"],
    effective: Object.fromEntries(
      AI_MODEL_CLASSES.map((modelClass) => {
        try {
          const ref = resolveAiModelRef({ enabled: true, assignments }, { class: modelClass });
          return [modelClass, { class: ref.class ?? null, variantId: ref.id }];
        } catch {
          return [modelClass, { class: null, variantId: null }];
        }
      }),
    ) as AiAdminOverview["effective"],
  };
};
