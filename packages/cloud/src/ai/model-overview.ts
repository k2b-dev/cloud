import { coreSettings } from "../services";
import { aiModelCatalog } from "./model-catalog";
import { AI_MODEL_CLASSES, type AiModelClass, type AiModelSlot, type AiProvider } from "../shared/ai-models";
import { resolveAiModelRef } from "./settings";

export type AiAdminOverview = {
  enabled: boolean;
  providers: (Pick<AiProvider, "id" | "type" | "label" | "enabled" | "status" | "statusCode" | "statusMessage" | "statusCheckedAt" | "logo" | "credentialSet"> & {
    modelCount: number;
  })[];
  assignments: Record<AiModelSlot, { variantId: string | null; revision: number; updatedAt: string; updatedBy: string | null }>;
  effective: Record<AiModelClass, { class: AiModelClass | null; variantId: string | null }>;
};

/** What the AI area's first column and the class rows need, read once for the page and the API. */
export const readAiAdminOverview = async (): Promise<AiAdminOverview> => {
  const [enabled, providers, models, assignments] = await Promise.all([
    coreSettings.get<boolean>("ai.enabled"),
    aiModelCatalog.providers(),
    aiModelCatalog.models(),
    aiModelCatalog.assignments(),
  ]);
  return {
    enabled,
    providers: providers.map((p) => ({
      id: p.id,
      type: p.type,
      label: p.label,
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
