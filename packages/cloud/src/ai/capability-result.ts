import type { StoreEntry } from "@k2b/nessi";
import type { AiActionCheck } from "./action-review";

export class AiCapabilityExecutionError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
    readonly dispatched: boolean = false,
  ) {
    super(`${code}: ${message}`);
    this.name = "AiCapabilityExecutionError";
  }
}

/** A check settles only what the app knows; it never authorizes another Action attempt. */
export const aiCapabilityCheckResult = (check: AiActionCheck): unknown => {
  if (check.state === "done")
    return {
      data: null,
      ...(check.receipt ? { receipt: check.receipt } : {}),
      outcomeCheck: "done",
      message: "The app's check confirmed the Action happened. Do not run it again.",
    };
  if (check.state === "not_done")
    throw new AiCapabilityExecutionError(
      "ACTION_NOT_DONE",
      409,
      "The app's check confirmed nothing happened. Ask the person before trying again.",
    );
  throw new AiCapabilityExecutionError(
    "ACTION_OUTCOME_UNKNOWN",
    409,
    check.state === "pending"
      ? "The app does not know the outcome yet. Do not retry the Action."
      : "The outcome check failed. Do not retry the Action.",
  );
};

/** Project durable, settled checks into model history without changing the stored messages or retrying an Action. */
export const projectSettledAiToolChecks = (
  rows: readonly (StoreEntry & { meta?: { toolChecks?: Record<string, AiActionCheck> } | null })[],
): StoreEntry[] => {
  const entries = rows.map(({ seq, kind, message }) => ({ seq, kind, message }));
  const missing = new Map<number, StoreEntry[]>();
  for (const [index, row] of rows.entries()) {
    if (row.message.role !== "assistant" || !row.meta?.toolChecks) continue;
    for (const call of row.message.content) {
      if (call.type !== "tool_call") continue;
      const check = row.meta.toolChecks[call.id];
      if (!check || (check.state !== "done" && check.state !== "not_done")) continue;
      let resultIndex: number | undefined;
      // Call IDs can be reused in another exchange; a check belongs only to this call's result.
      for (let next = index + 1; next < rows.length; next++) {
        const message = rows[next]!.message;
        if (message.role === "user") break;
        if (message.role === "assistant" && message.content.some((part) => part.type === "tool_call" && part.id === call.id)) break;
        if (message.role === "tool_result" && message.callId === call.id) {
          resultIndex = next;
          break;
        }
      }
      const existing = resultIndex !== undefined ? rows[resultIndex]!.message : undefined;
      // A result that already agrees keeps its original data and receipt.
      if (
        existing?.role === "tool_result" &&
        ((check.state === "done" && !existing.isError) ||
          (check.state === "not_done" &&
            existing.isError &&
            typeof existing.result === "string" &&
            existing.result.startsWith("ACTION_NOT_DONE:")))
      )
        continue;
      let result: unknown;
      let isError = false;
      try {
        result = aiCapabilityCheckResult(check);
      } catch (error) {
        if (!(error instanceof AiCapabilityExecutionError)) throw error;
        result = error.message;
        isError = true;
      }
      const message = { role: "tool_result" as const, callId: call.id, name: call.name, result, isError };
      if (resultIndex !== undefined) {
        entries[resultIndex] = { ...entries[resultIndex]!, message };
      } else {
        // A cut-off call has no result row. Share its sequence so compaction still checkpoints durable rows.
        const answers = missing.get(index) ?? [];
        answers.push({ seq: row.seq, kind: "message", message });
        missing.set(index, answers);
      }
    }
  }
  return entries.flatMap((entry, index) => [entry, ...(missing.get(index) ?? [])]);
};
