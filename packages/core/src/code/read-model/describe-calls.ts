import type { CodeTestCall } from "@k2b/cloud/code";
import type { CodeReadModelRow } from "@k2b/cloud/contracts";
import { isUnknownCodeCallOutcome } from "./call-outcome";
import { codeReadModelMessages } from "./messages";

/** Counts observations, never infers an effect from an input, requested amount, or model text. */
export function describeCalls(
  calls: readonly Pick<CodeTestCall, "result" | "replayed" | "operation">[],
  locale: string,
  operationTitle?: (id: string) => string,
): CodeReadModelRow[] {
  const { t } = codeReadModelMessages.resolve([locale]);
  const counts = new Map<string, number>();
  let repeated = 0;
  let refused = 0;
  let unknown = 0;
  for (const call of calls) {
    if (call.replayed) repeated++;
    else if (call.result.ok) counts.set(call.operation, (counts.get(call.operation) ?? 0) + 1);
    else if (isUnknownCodeCallOutcome(call.result.error)) unknown++;
    else refused++;
  }
  return [
    ...[...counts].map(([operation, count]) => ({ text: t.exampleCalls({ action: operationTitle?.(operation) ?? t.call, count }) })),
    ...(repeated ? [{ text: t.replayed({ count: repeated }) }] : []),
    ...(refused ? [{ text: t.refused({ count: refused }) }] : []),
    ...(unknown ? [{ text: t.unknown({ count: unknown }) }] : []),
    ...(!calls.length ? [{ text: t.noCalls }] : []),
  ];
}
