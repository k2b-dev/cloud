import { isUnknownActionOutcome } from "./action-review";
import type { AiPendingTurnActionRecord } from "./types";

/**
 * Execution barrier for Send now. Once requested, no new tool body starts.
 * Running bodies retain their signal until their results reached the journal.
 * The model loop stops only after every already-started body has settled.
 */
export class AiTurnInterruption {
  private readonly running = new Set<string>();
  private requested = false;
  constructor(private readonly stop: () => void) {}

  get draining(): boolean {
    return this.requested;
  }

  request(): void {
    this.requested = true;
    this.stopWhenDrained();
  }

  begin(callId: string): void {
    this.assertCanStart();
    this.running.add(callId);
  }

  assertCanStart(): void {
    if (this.requested) throw new DOMException("Turn interrupted before this step ran.", "AbortError");
  }

  /** Called after the tool outcome is durable, including failed/unclear outcomes. */
  settled(callId: string): void {
    this.running.delete(callId);
    this.stopWhenDrained();
  }

  private stopWhenDrained(): void {
    if (this.requested && this.running.size === 0) this.stop();
  }
}

/** A client effect confirms the interruption only with every timely, known receipt. */
export const queuedClientInterruptionState = (input: {
  expectedCount: number;
  expired: boolean;
  actions: Array<Pick<AiPendingTurnActionRecord, "status" | "resolvedEvent"> & { late: boolean }>;
}): "waiting" | "confirmed" | "unconfirmed" => {
  if (
    input.actions.length !== input.expectedCount ||
    input.actions.some(
      (action) =>
        action.late ||
        action.status === "aborted" ||
        (action.status === "resolved" &&
          (action.resolvedEvent?.type !== "tool_result" || isUnknownActionOutcome(action.resolvedEvent.result))),
    )
  )
    return "unconfirmed";
  if (input.actions.some((action) => action.status === "pending")) return input.expired ? "unconfirmed" : "waiting";
  return "confirmed";
};
