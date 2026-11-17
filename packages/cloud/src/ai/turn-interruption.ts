import type { OutboundEvent, ToolResultMessage } from "@k2b/nessi";
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
  private confirmed = false;
  private readonly decisions = new Set<() => void>();
  constructor(private readonly stop: () => void) {}

  get draining(): boolean {
    return this.requested;
  }

  request(): void {
    this.requested = true;
  }

  /** Only the lifecycle check may authorize an irreversible stop. */
  confirm(): void {
    if (!this.requested) return;
    this.confirmed = true;
    this.notifyDecision();
    this.stopWhenDrained();
  }

  withdraw(): void {
    this.requested = false;
    this.confirmed = false;
    this.notifyDecision();
  }

  /** Hold new work while receipts are undecided; withdrawal resumes that same work. */
  waitForDecision(signal: AbortSignal): Promise<void> {
    if (!this.requested || this.confirmed || signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        this.decisions.delete(done);
        signal.removeEventListener("abort", done);
        resolve();
      };
      this.decisions.add(done);
      signal.addEventListener("abort", done, { once: true });
    });
  }

  private notifyDecision(): void {
    for (const done of this.decisions) done();
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
    if (this.requested && this.confirmed && this.running.size === 0) this.stop();
  }
}

/** This result records the queue's interruption, never a decision by the person. */
export const interruptedToolResult = (event: Extract<OutboundEvent, { type: "tool_action_request" }>): ToolResultMessage => {
  const parent =
    event.kind === "custom_approval"
      ? event.callId.replace(/-approval-[0-9]+$/, "")
      : event.kind === "client_tool"
        ? event.callId.replace(/-client-[0-9]+$/, "")
        : event.callId;
  const started = event.kind === "custom_approval" || parent !== event.callId;
  return {
    role: "tool_result",
    callId: started ? parent : event.callId,
    name: event.name,
    isError: true,
    reason: started ? "not_returned" : "not_run",
    result: {
      code: "QUEUE_INTERRUPTED",
      started,
      message: started
        ? "The turn was interrupted while waiting for this step. No approval decision was made; check any earlier effects before repeating the work."
        : "The queued message interrupted the turn before this step ran. No approval decision was made.",
    },
  };
};

export const isQueueInterruptedResult = (result: unknown): result is { code: "QUEUE_INTERRUPTED"; started: boolean } =>
  typeof result === "object" &&
  result !== null &&
  "code" in result &&
  result.code === "QUEUE_INTERRUPTED" &&
  "started" in result &&
  typeof result.started === "boolean";

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
