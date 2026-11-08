import type { CreateElicitationResponse, ElicitationSchema } from "@agentclientprotocol/sdk";
import type { AiStoredMessage } from "@k2b/cloud/ai";
import { type Block, blockDataAtPath } from "@k2b/cloud/blocks";
import type { CloudCliContext } from "@k2b/cloud/cli";
import { AI_API, jsonRequest } from "./shared";
import { terminalSafeText } from "./terminal";

export type AssistantChoice = {
  turnId: string;
  toolCallId: string;
  blockId: string;
  title: string;
  mode: "one" | "many";
  options: { id: string; label: string }[];
};

export function openAssistantChoices(messages: readonly AiStoredMessage[]): AssistantChoice[] {
  const find = (blocks: readonly Block[]): Extract<Block, { kind: "Choice" }>[] =>
    blocks.flatMap((block) => (block.kind === "Choice" ? [block] : block.kind === "Section" ? find(block.children) : []));
  return messages.flatMap((stored) => {
    if (stored.message.role !== "tool_result" || stored.message.isError || !stored.loopId || stored.meta?.resultChoice?.state !== "open")
      return [];
    const { callId } = stored.message;
    return find(stored.meta.resultView?.blocks ?? []).map((choice) => ({
      turnId: stored.loopId!,
      toolCallId: callId,
      blockId: choice.id,
      title: choice.title,
      mode: choice.mode,
      options: choice.options.map((option) => ({
        id: String(blockDataAtPath(option, choice.option.id)),
        label: String(blockDataAtPath(option, choice.option.title)),
      })),
    }));
  });
}

export const assistantChoiceText = (choice: AssistantChoice): string =>
  [choice.title, ...choice.options.map((option, i) => `${i + 1}. ${option.label} [${option.id}]`)].join("\n");

export const assistantChoicePrompt = (choice: AssistantChoice, locale?: string): string =>
  locale?.startsWith("de") ? `Wahl (1-${choice.options.length}, leer = später): ` : `Choice (1-${choice.options.length}, empty = later): `;

export function parseAssistantChoice(choice: AssistantChoice, value: string): string[] | null {
  if (!value.trim()) return [];
  const numbers = value.trim().split(/[\s,]+/);
  if (numbers.some((number) => !/^[1-9]\d*$/.test(number))) return null;
  const positions = numbers.map(Number);
  if (
    new Set(positions).size !== positions.length ||
    (choice.mode === "one" && positions.length !== 1) ||
    positions.some((position) => position > choice.options.length)
  )
    return null;
  return positions.map((position) => choice.options[position - 1]!.id);
}

export const assistantChoiceForm = (choice: AssistantChoice): ElicitationSchema => ({
  type: "object",
  required: ["ids"],
  properties: {
    ids:
      choice.mode === "one"
        ? {
            type: "string",
            title: terminalSafeText(choice.title),
            enum: choice.options.map((option) => option.id),
            enumNames: choice.options.map((option) => terminalSafeText(option.label)),
          }
        : {
            type: "array",
            title: terminalSafeText(choice.title),
            minItems: 1,
            items: { type: "string", enum: choice.options.map((option) => option.id) },
          },
  },
});

export function assistantChoiceResponse(choice: AssistantChoice, response: CreateElicitationResponse): string[] | null {
  if (response.action !== "accept" || !response.content || typeof response.content !== "object" || !("ids" in response.content))
    return null;
  const value = response.content.ids;
  const ids = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
  if (
    !ids.length ||
    (choice.mode === "one" && ids.length !== 1) ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => typeof id !== "string" || !choice.options.some((option) => option.id === id))
  )
    return null;
  return ids.filter((id): id is string => typeof id === "string");
}

/** Uses the same person-only endpoint as the browser; cancellation makes no write. */
export async function submitAssistantChoice(
  ctx: Pick<CloudCliContext, "fetch" | "readJson">,
  conversationId: string,
  choice: AssistantChoice,
  ids: string[],
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  return ctx.readJson<{ turn: { id: string } }>(
    await ctx.fetch(`${AI_API}/conversations/${encodeURIComponent(conversationId)}/choices`, {
      ...jsonRequest("POST", { turnId: choice.turnId, toolCallId: choice.toolCallId, blockId: choice.blockId, ids }),
      signal,
    }),
  );
}
