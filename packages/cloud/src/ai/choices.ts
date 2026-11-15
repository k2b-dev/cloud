import { blockDataAtPath } from "../blocks/path";
import type { AiCapabilityCatalogEntry } from "./capabilities";
import { type AiChoiceProvenance, choiceEntries } from "./choice-state";
import { capabilityResultView } from "./result-view";
import type { AiStoredMessage } from "./types";

export type { AiChoiceProvenance, AiChoiceState } from "./choice-state";
export { reconcileProjectedAiChoices, viewChoice } from "./choice-state";
export type AiChoiceTarget = { turnId: string; toolCallId: string; blockId: string; ids: string[] };
export type AiChoiceSubmission = AiChoiceTarget & { catalog: readonly AiCapabilityCatalogEntry[] };
export type AiChoiceCall = { callId: string; appId: string; query: string };

export class AiChoiceConflict extends Error {
  constructor(readonly code: "choice_busy" | "choice_closed" | "choice_invalid") {
    super(code);
  }
}

/** Every Choice of a conversation with its state; stored results are bound here, projected ones arrive bound. */
export const conversationChoices = (messages: readonly AiStoredMessage[], projected = false) =>
  choiceEntries(messages, (stored) =>
    projected
      ? (stored.meta?.resultView ?? null)
      : stored.message.role === "tool_result"
        ? capabilityResultView(stored.message.result)
        : null,
  );

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
