import type { AiConversation } from "@k2b/cloud/ai";
import type { AiComposerSendInput } from "@k2b/cloud/ai/ui";

export const submitAssistantProjectMessage = async (input: {
  projectId: string;
  message: AiComposerSendInput;
  modelProfileId?: string;
  pendingConversation?: AiConversation;
  activeConversationId: () => string | null;
  openConversation: (conversationId: string) => Promise<"opened" | "current" | "stale" | "failed">;
  createConversation: (projectId: string) => Promise<AiConversation | null>;
  send: (message: AiComposerSendInput & { modelProfileId?: string }) => Promise<boolean>;
  rememberPending: (conversation: AiConversation) => void;
  clearPending: () => void;
  navigate: (conversationId: string) => void;
}): Promise<boolean> => {
  let conversation = input.pendingConversation;
  if (conversation && input.activeConversationId() !== conversation.id) {
    const opened = await input.openConversation(conversation.id);
    if (opened !== "opened" && opened !== "current") conversation = undefined;
  }
  if (!conversation) {
    conversation = (await input.createConversation(input.projectId)) ?? undefined;
    if (!conversation || input.activeConversationId() !== conversation.id) return false;
    input.rememberPending(conversation);
  }

  const sent = await input.send({ ...input.message, modelProfileId: input.modelProfileId });
  if (!sent) return false;
  input.clearPending();
  input.navigate(conversation.id);
  return true;
};
