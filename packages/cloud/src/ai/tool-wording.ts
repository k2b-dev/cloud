import {
  type CapabilityActionWording,
  capabilityActionOutcome,
  capabilityActionSubject,
  resolveCapabilityActionSentences,
} from "../_internal/capability-sentences";
import { displayToolName, isRecord } from "./chat/message-utils";
import type { AiTurnBlock } from "./protocol";
import { CLOUD_AI_TOOL_PRESENTATION } from "./tool-sentences";

type ToolBlock = Extract<AiTurnBlock, { kind: "tool" }>;

/**
 * How the chat words one call that acts on something: an app Action through its saved presentation, a
 * Cloud tool through Cloud's own catalog of the same shape. `null` for calls that only read.
 */
export const toolWording = (block: ToolBlock, locale: string): CapabilityActionWording | null => {
  const presentation = block.presentation;
  if (presentation?.kind === "capability") {
    if (presentation.capabilityKind !== "action") return null;
    return {
      title: presentation.title,
      ...(presentation.sentences ? { sentences: presentation.sentences } : {}),
      ...(presentation.fields ? { fields: presentation.fields } : {}),
    };
  }
  const sentences = resolveCapabilityActionSentences(block.name, CLOUD_AI_TOOL_PRESENTATION, locale);
  return sentences ? { title: displayToolName(block.name, locale), sentences } : null;
};

/** What the call does or would do, as one sentence; `null` for calls that only read. */
export const toolSubject = (block: ToolBlock, locale: string, timeZone: string): string | null => {
  const wording = toolWording(block, locale);
  return wording ? capabilityActionSubject(wording, block.args, { locale, timeZone }) : null;
};

/** The sentence for one outcome, or `null` when the tool has none that renders for this call. */
export const toolOutcome = (block: ToolBlock, key: "done" | "rejected" | "notRun", locale: string, timeZone: string): string | null => {
  const wording = toolWording(block, locale);
  if (!wording) return null;
  const result = isRecord(block.result) ? block.result : undefined;
  // App Actions return their data inside the result envelope; Cloud tools return the data itself.
  const data = block.presentation?.kind === "capability" ? result?.data : block.result;
  return capabilityActionOutcome(wording, key, { input: block.args, data }, { locale, timeZone });
};
