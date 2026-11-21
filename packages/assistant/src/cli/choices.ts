import type { AiStoredMessage } from "@k2b/cloud/ai";
import { type Block, blockDataAtPath } from "@k2b/cloud/blocks";

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

export const assistantChoiceText = (choice: AssistantChoice, chatLink: string): string =>
  [choice.title, ...choice.options.map((option, i) => `${i + 1}. ${option.label} [${option.id}]`), `Answer in Cloud: ${chatLink}`].join(
    "\n",
  );
