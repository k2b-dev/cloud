import type { CodeAccessSetData } from "@k2b/cloud/contracts";

export const activationManagerRequired = (locale?: string): string =>
  locale?.toLowerCase().startsWith("de")
    ? "Einschalten kann nur, wer dieses Ziel verwaltet"
    : "Only someone who manages this target can activate it";

/** Keep the target provider's reader decision; never infer readability from manager/admin authority. */
export function activationDecision(decision: CodeAccessSetData, locale?: string): CodeAccessSetData {
  if (decision.readable === true) return decision;
  return decision.granted
    ? { granted: true, grantId: decision.grantId, level: decision.level, readable: false }
    : { granted: false, reasonCode: decision.reasonCode, reason: activationManagerRequired(locale), readable: false };
}
