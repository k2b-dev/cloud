import type { Provider, ProviderEvent, ToolCallBlock } from "@k2b/nessi";
import { z } from "zod";
import { logger } from "../services/logging";
import { saveAiNextMessage } from "./next-message-store";
import type { AiUserPrefs } from "./prefs";
import { defineAiTool } from "./tools";
import type { AiChatTurnRunConfig } from "./types";

export const AI_NEXT_MESSAGE_TOOL = "suggest_next_message";
export const AI_NEXT_MESSAGE_DESCRIPTION =
  "Suggest the user's likely next message after your final message. Call alone, at most once, after all other work. Pass null when no suggestion helps.";
export const AI_NEXT_MESSAGE_NOTED = "noted, call only alone after the answer";

export const normalizeAiNextMessage = (text: string) =>
  text
    .normalize("NFKC")
    .toLocaleLowerCase("en")
    .replace(/[\p{P}\p{Z}\s]+/gu, " ")
    .trim();

/** Invalid suggestions mean absence, never a failed chat turn. Count Unicode characters. */
export const validateAiNextMessage = (value: unknown, lastUserMessage: string): string | null => {
  if (typeof value !== "string" || /[\r\n\u2028\u2029\p{Cc}\p{Cf}]/u.test(value)) return null;
  const text = value.trim();
  if (!text || [...text].length > 200) return null;
  if (/(?:\b[a-z][a-z\d+.-]*:\S|www\.|\b[\p{L}\d-]+\.[a-z]{2,}\b|\b(?:\d{1,3}\.){3}\d{1,3}\b|\blocalhost[:/]|(?:^|\s)\/\S|@)/iu.test(text))
    return null;
  if (/[`*_\[\]<>]|!\[|^\s*(?:#{1,6}\s|[-+>]\s|\d+[.)]\s)|~~/u.test(text)) return null;
  return normalizeAiNextMessage(text) === normalizeAiNextMessage(lastUserMessage) ? null : text;
};

export const aiNextMessageEnabled = (config: AiChatTurnRunConfig, prefs: AiUserPrefs | null) =>
  prefs?.suggestNextMessage === true &&
  config.signedInSession === true &&
  config.actor?.kind === "user" &&
  config.toolSource?.kind === "default" &&
  !config.background &&
  !config.client;

export const createAiNextMessageTool = () =>
  defineAiTool({
    name: AI_NEXT_MESSAGE_TOOL,
    description: AI_NEXT_MESSAGE_DESCRIPTION,
    inputSchema: z.object({ text: z.string().nullable() }),
    outputSchema: z.string(),
    approval: "never",
    promptHint: AI_NEXT_MESSAGE_DESCRIPTION,
  }).server(async () => AI_NEXT_MESSAGE_NOTED);

export const isVisibleAiNextMessageOp = (op: { type: string; block?: { kind: string; name?: string } }) =>
  op.type !== "block_set" || op.block?.kind !== "tool" || op.block.name !== AI_NEXT_MESSAGE_TOOL;

/** Owns the closing call. Only its small tool stream is held; answer text streams immediately. */
export const createAiNextMessageRuntime = (
  config: AiChatTurnRunConfig,
  prefs: AiUserPrefs | null,
  conversationId: string,
  turnId: string,
) => {
  const enabled = aiNextMessageEnabled(config, prefs);
  let called = false;
  let text: string | null = null;
  let failed = false;
  let redirected = false;
  const result = (status: string, signal: AbortSignal) =>
    enabled && !failed && !redirected && !signal.aborted && status === "completed" ? text : null;

  return {
    result,
    redirect: (notify: () => void) => () => {
      redirected = true;
      notify();
    },
    tools: enabled ? [createAiNextMessageTool()] : [],
    wrap: (provider: Provider): Provider =>
      enabled
        ? {
            ...provider,
            stream: async function* (request) {
              if (!request.tools?.some((entry) => entry.name === AI_NEXT_MESSAGE_TOOL)) {
                yield* provider.stream(request);
                return;
              }
              const lastUserIndex = request.messages.findLastIndex((message) => message.role === "user");
              const lastUser = request.messages[lastUserIndex];
              const currentMessages = request.messages.slice(lastUserIndex + 1);
              const lastUserText =
                lastUser?.role === "user"
                  ? lastUser.content.map((part) => (typeof part === "string" ? part : part.type === "text" ? part.text : "")).join("")
                  : "";
              if (currentMessages.some((message) => message.role === "tool_result" && message.isError)) failed = true;
              const held: ProviderEvent[] = [];
              const suggestionIds = new Set<string>();
              const calls: ToolCallBlock[] = [];
              const suggestionTextIds = new Set<string>();
              let answerBeforeCall = false;
              let answer = false;
              let lastBlockWasSuggestion = false;
              let finishReason: string | undefined;
              let streamFailed = false;
              for await (const event of provider.stream(request)) {
                if (event.type === "issue") {
                  failed = true;
                  streamFailed = true;
                }
                if (event.type === "block_start" && event.kind === "tool_call" && (!event.name || event.name === AI_NEXT_MESSAGE_TOOL))
                  suggestionIds.add(event.blockId);
                if (event.type === "block_start" && event.kind === "tool_call" && event.name === AI_NEXT_MESSAGE_TOOL)
                  suggestionTextIds.add(event.blockId);
                if (event.type === "block_end") {
                  lastBlockWasSuggestion = event.block.type === "tool_call" && event.block.name === AI_NEXT_MESSAGE_TOOL;
                  if (event.block.type === "text" && event.block.text.trim()) answer = true;
                  if (event.block.type === "tool_call") {
                    calls.push(event.block);
                    if (lastBlockWasSuggestion) {
                      suggestionIds.add(event.blockId);
                      suggestionTextIds.add(event.blockId);
                      answerBeforeCall = answer;
                    }
                  }
                }
                if (event.type === "usage") {
                  finishReason = event.finishReason;
                  held.push(event);
                } else if ("blockId" in event && suggestionIds.has(event.blockId)) held.push(event);
                else yield event;
              }
              // Consume a valid closing call as a normal final answer, retaining usage and normal loop accounting.
              // Nessi therefore persists text and ends with `stop`, without an abort or another provider request.
              const close =
                calls.length === 1 &&
                calls[0]?.name === AI_NEXT_MESSAGE_TOOL &&
                answerBeforeCall &&
                lastBlockWasSuggestion &&
                !streamFailed &&
                finishReason !== "max_tokens" &&
                finishReason !== "error" &&
                finishReason !== "aborted" &&
                finishReason !== "interrupted" &&
                !request.signal?.aborted;
              if (close && !called) {
                called = true;
                text = validateAiNextMessage(calls[0]?.args.text, lastUserText);
              }
              for (const event of held) {
                if (close) {
                  if (event.type === "usage") yield { ...event, finishReason: "stop" };
                } else if (event.type === "block_start") {
                  yield { ...event, name: calls.find((call) => call.id === event.callId)?.name ?? event.name };
                } else if (event.type === "block_end" && event.block.type === "tool_call" && event.block.name === AI_NEXT_MESSAGE_TOOL) {
                  yield { ...event, block: { ...event.block, args: { text: null } } };
                } else if (event.type === "block_delta" && suggestionTextIds.has(event.blockId)) {
                  // The canonical block_end supplies sanitized args. Never replay partial suggestion text.
                } else yield event;
              }
            },
          }
        : provider,
    save: async (status: string, signal: AbortSignal) => {
      const suggestion = result(status, signal);
      if (!suggestion || config.actor?.kind !== "user") return;
      try {
        await saveAiNextMessage({ conversationId, turnId, userId: config.actor.user.id, text: suggestion });
      } catch (error) {
        logger("ai:executor").warn("Failed to save AI next-message suggestion", {
          conversationId,
          turnId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
};
