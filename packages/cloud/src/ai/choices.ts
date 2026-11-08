import { blockDataAtPath } from "../blocks/bind";
import type { Block, BoundBlockView } from "../blocks/schema";
import type { AiCapabilityCatalogEntry } from "./capabilities";
import { capabilityResultView } from "./result-view";
import type { AiStoredMessage } from "./types";

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
export type AiChoiceTarget = { turnId: string; toolCallId: string; blockId: string; ids: string[] };
export type AiChoiceSubmission = AiChoiceTarget & { catalog: readonly AiCapabilityCatalogEntry[] };
export type AiChoiceCall = { callId: string; appId: string; query: string };

export class AiChoiceConflict extends Error {
  constructor(readonly code: "choice_busy" | "choice_closed" | "choice_invalid") {
    super(code);
  }
}

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
export function conversationChoices(messages: readonly AiStoredMessage[], projected = false) {
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
    const choice = viewChoice(projected ? (stored.meta?.resultView ?? null) : capabilityResultView(result.result));
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

export function projectAiChoices(messages: readonly AiStoredMessage[], context: readonly AiStoredMessage[] = messages): AiStoredMessage[] {
  const states = new Map(conversationChoices(context).map((entry) => [entry.stored.id, entry.state]));
  return messages.map((stored) => {
    const state = states.get(stored.id);
    return state ? { ...stored, meta: { ...stored.meta, resultChoice: state } } : stored;
  });
}

/** Called only while the conversation admission lock is held. */
export function resolveAiChoice(messages: readonly AiStoredMessage[], target: AiChoiceSubmission, locale: string, at: string) {
  const found = conversationChoices(messages).find(
    (entry) =>
      entry.stored.loopId === target.turnId &&
      entry.stored.message.role === "tool_result" &&
      entry.stored.message.callId === target.toolCallId &&
      entry.choice.id === target.blockId,
  );
  if (!found || found.state.state !== "open") throw new AiChoiceConflict("choice_closed");
  const { choice, presentation } = found;
  const options = new Map(
    choice.options.map((option) => [blockDataAtPath(option, choice.option.id), blockDataAtPath(option, choice.option.title)]),
  );
  if (
    !target.ids.length ||
    new Set(target.ids).size !== target.ids.length ||
    (choice.mode === "one" && target.ids.length !== 1) ||
    target.ids.some((id) => !options.has(id))
  )
    throw new AiChoiceConflict("choice_invalid");
  const labels = target.ids.map((id) => String(options.get(id)));
  const provenance: AiChoiceProvenance = {
    appId: presentation.appId,
    appName: presentation.appName,
    turnId: target.turnId,
    toolCallId: target.toolCallId,
    blockId: target.blockId,
    ids: [...target.ids],
    labels,
    at,
  };
  const text = `${locale.startsWith("de") ? "Gewählt in" : "Chosen in"} ${presentation.appName} · ${choice.title}: ${labels.map((label, i) => `${label} (${target.ids[i]})`).join(", ")}`;
  let then: { entry: AiCapabilityCatalogEntry; input: Record<string, unknown> } | undefined;
  if (choice.then) {
    const query = target.catalog.find(
      (entry) =>
        entry.appId === presentation.appId &&
        entry.kind === "query" &&
        `${entry.appId}.query.${entry.operation.localId}` === choice.then?.query,
    );
    if (!query) throw new AiChoiceConflict("choice_invalid");
    then = { entry: query, input: { ...choice.then.input, [choice.then.field]: choice.mode === "one" ? target.ids[0] : [...target.ids] } };
  }
  return { provenance, text, then };
}

/** Wire input cannot carry Cloud's choice identity, even nested in a client tool result. */
export function hasAiChoiceProvenance(value: unknown): boolean {
  const pending = [value];
  const seen = new Set<object>();
  while (pending.length) {
    const current = pending.pop();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    if ("type" in current && current.type === "choice") return true;
    if ("meta" in current && current.meta && typeof current.meta === "object" && "choice" in current.meta) return true;
    if ("blockId" in current && "ids" in current && ("toolCallId" in current || "appId" in current || "app" in current)) return true;
    for (const child of Object.values(current)) pending.push(child);
  }
  return false;
}

/** Only the pending server-authored Query receives this origin, once per execution attempt. */
export function createChoiceCapabilityOrigin(choice: AiChoiceCall | undefined, completed: boolean) {
  let pending = !completed;
  return (entry: Pick<AiCapabilityCatalogEntry, "name" | "appId" | "kind">, callId?: string): "choice" | undefined => {
    if (
      !pending ||
      !choice ||
      choice.callId !== callId ||
      choice.query !== entry.name ||
      choice.appId !== entry.appId ||
      entry.kind !== "query"
    )
      return undefined;
    pending = false;
    return "choice";
  };
}

/** Reconcile paged-in history with newer Cloud-projected messages without reopening a settled choice. */
export function reconcileProjectedAiChoices(messages: readonly AiStoredMessage[]): AiStoredMessage[] {
  const states = new Map(conversationChoices(messages, true).map((entry) => [entry.stored.id, entry.state]));
  return messages.map((stored) => {
    const current = stored.meta?.resultChoice;
    const next = states.get(stored.id);
    if (!next || (current && current.state !== "open" && next.state !== "answered")) return stored;
    return { ...stored, meta: { ...stored.meta, resultChoice: next } };
  });
}
