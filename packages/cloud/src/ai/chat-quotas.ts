import type { AccessSubject } from "../server/services/access";
import { hasBillableAiPricing } from "../shared/ai-costs";
import type { AiChatQuotaSnapshot } from "../shared/ai-quotas";
import { listAssistantAiModels } from "./assistant-models";
import { aiQuotas } from "./quotas";
import { readAiSettingsState } from "./settings";

/** Own allowances only. Grant identities and unavailable model profiles stay private. */
export async function getAiChatQuotas(subject: AccessSubject): Promise<AiChatQuotaSnapshot> {
  const config = await aiQuotas.config();
  if (!config.enabled) return { enabled: false, balances: [] };
  const models = await listAssistantAiModels(subject);
  const snapshot = await aiQuotas.snapshot(subject);
  const profiles = (await readAiSettingsState()).profiles;
  return {
    enabled: snapshot.enabled,
    unit: config.unit ?? "EUR",
    unlimitedModels: models
      .filter((model) => !hasBillableAiPricing(profiles.find((profile) => profile.id === model.id)?.pricing))
      .map((model) => model.id),
    balances: snapshot.balances
      .filter((b) => b.scope === "*" || models.some((m) => m.id === b.scope))
      .map(({ sources: _sources, sourceDetails: _sourceDetails, ...balance }) => balance),
  };
}
