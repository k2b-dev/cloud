import type { AccessSubject } from "../server/services/access";
import { hasBillableAiPricing } from "../shared/ai-costs";
import type { AiChatQuotaBalance, AiChatQuotaSnapshot, AiQuotaBalance } from "../shared/ai-quotas";
import { listAssistantAiModels } from "./assistant-models";
import { aiQuotas } from "./quotas";
import { readAiSettingsState } from "./settings";

/** Reduces a balance to what the chat shows. Amounts, limits, and the unit never leave the server on this path. */
const usage = (b: AiQuotaBalance): AiChatQuotaBalance => {
  if (b.bypassed || b.limit === null) return { scope: b.scope, unlimited: true, usedPercent: null, resetsAt: null };
  const usedPercent = b.unknown ? null : b.used >= b.limit ? 100 : Math.max(0, Math.min(99, Math.floor((100 * b.used) / b.limit)));
  return { scope: b.scope, unlimited: false, usedPercent, resetsAt: b.resetsAt };
};

/** Own allowances only, as usage shares. Grant identities and unavailable model profiles stay private. */
export async function getAiChatQuotas(subject: AccessSubject): Promise<AiChatQuotaSnapshot> {
  const config = await aiQuotas.config();
  if (!config.enabled) return { enabled: false, balances: [] };
  const models = await listAssistantAiModels(subject);
  const snapshot = await aiQuotas.snapshot(subject);
  const profiles = (await readAiSettingsState()).profiles;
  return {
    enabled: snapshot.enabled,
    unlimitedModels: models
      .filter((model) => !hasBillableAiPricing(profiles.find((profile) => profile.id === model.id)?.pricing))
      .map((model) => model.id),
    balances: snapshot.balances.filter((b) => b.scope === "*" || models.some((m) => m.id === b.scope)).map(usage),
  };
}
