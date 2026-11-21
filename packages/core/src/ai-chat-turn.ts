import type { AiChatTurnAdmission } from "@k2b/cloud/ai/runtime";
import { admitCodeChatTurn } from "./ai-chat-budget";
import { loadCodeChatPagesPrompt } from "./code/chat-pages";

/** Admission is mandatory; optional page context cannot undo a successful admission. */
export const beforeCoreChatTurn: AiChatTurnAdmission = async (input) => {
  await admitCodeChatTurn(input);
  return { systemPrompt: await loadCodeChatPagesPrompt(input) };
};
