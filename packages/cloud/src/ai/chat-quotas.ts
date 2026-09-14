import type { AccessSubject } from "../server/services/access";
import type { AiChatQuotaSnapshot } from "../shared/ai-quotas";
import { listAssistantAiModels } from "./assistant-models";
import { aiQuotas } from "./quotas";

/** Own allowances only. Grant identities and unavailable model profiles stay private. */
export async function getAiChatQuotas(subject: AccessSubject): Promise<AiChatQuotaSnapshot> {
  if (!(await aiQuotas.config()).enabled) return { enabled: false, balances: [] };
  const models = await listAssistantAiModels(subject);
  const snapshot = await aiQuotas.snapshot(subject);
  return {
    enabled: snapshot.enabled,
    balances: snapshot.balances
      .filter((b) => b.scope === "*" || models.some((m) => m.id === b.scope))
      .map(({ sources: _sources, ...balance }) => balance),
  };
}
