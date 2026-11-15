import type { Block, BoundBlockView } from "../blocks/schema";
import type { AiStoredMessage } from "./types";

/**
 * The state of a view's Choice, derived only from Cloud's own message metadata. Light enough for the browser: it reads
 * views Cloud already bound and never binds or validates one again.
 */

export type AiChoiceState = { state: "open" | "answered" | "superseded"; chosen?: string[]; answeredAt?: string };
export type AiChoiceProvenance = {
  appId: string;
  appName: string;
  /** Internal source turn identity; projected to its public ID at the HTTP boundary. */
  turnId: string;
  toolCallId: string;
  blockId: string;
  ids: string[];
  labels: string[];
  at: string;
};

export function viewChoice(view: BoundBlockView | null): Extract<Block, { kind: "Choice" }> | undefined {
  const find = (blocks: readonly Block[]): Extract<Block, { kind: "Choice" }> | undefined => {
    for (const block of blocks) {
      if (block.kind === "Choice") return block;
      if (block.kind === "Section") {
        const found = find(block.children);
        if (found) return found;
      }
    }
  };
  return view ? find(view.blocks) : undefined;
}

const key = (turnId: string | null, callId: string, blockId: string) => JSON.stringify([turnId, callId, blockId]);

/** Only Cloud message metadata supplies identity or an answer; result data never does. */
export function choiceEntries(messages: readonly AiStoredMessage[], viewOf: (stored: AiStoredMessage) => BoundBlockView | null) {
  const calls = new Map<string, NonNullable<AiStoredMessage["meta"]>["toolPresentations"]>();
  const answers = new Map<string, AiChoiceProvenance>();
  for (const stored of messages) {
    if (stored.message.role === "assistant" && stored.loopId && stored.meta?.toolPresentations) {
      calls.set(stored.loopId, { ...calls.get(stored.loopId), ...stored.meta.toolPresentations });
    }
    if (stored.message.role === "user" && stored.meta?.choice) {
      const answer = stored.meta.choice;
      answers.set(key(answer.turnId, answer.toolCallId, answer.blockId), answer);
    }
  }
  const choices = messages.flatMap((stored) => {
    const result = stored.message;
    if (result.role !== "tool_result" || result.isError || !stored.loopId) return [];
    const presentation = calls.get(stored.loopId)?.[result.callId];
    if (presentation?.kind !== "capability") return [];
    const choice = viewChoice(viewOf(stored));
    if (!choice) return [];
    const answer = answers.get(key(stored.loopId, result.callId, choice.id));
    const state: AiChoiceState = { state: "open" };
    return [{ stored, choice, presentation, answer, state }];
  });
  const newerApps = new Set<string>();
  for (const entry of choices.toReversed()) {
    if (entry.answer) {
      entry.state = { state: "answered", chosen: entry.answer.ids, answeredAt: entry.answer.at };
    } else {
      entry.state = { state: newerApps.has(entry.presentation.appId) ? "superseded" : "open" };
    }
    newerApps.add(entry.presentation.appId);
  }
  return choices;
}

/** Reconcile paged-in history with newer Cloud-projected messages without reopening a settled choice. */
export function reconcileProjectedAiChoices(messages: readonly AiStoredMessage[]): AiStoredMessage[] {
  const states = new Map(
    choiceEntries(messages, (stored) => stored.meta?.resultView ?? null).map((entry) => [entry.stored.id, entry.state]),
  );
  return messages.map((stored) => {
    const current = stored.meta?.resultChoice;
    const next = states.get(stored.id);
    if (!next || (current && current.state !== "open" && next.state !== "answered")) return stored;
    return { ...stored, meta: { ...stored.meta, resultChoice: next } };
  });
}
