import { AI_TURN_ATTACHMENT_MAX_ITEMS } from "./limits";
import type { AiConversation, AiDraftContentPart } from "./types";

export {
  AI_SKILL_REFERENCE_MAX_ITEMS,
  AI_SKILL_REFERENCES_MAX_CHARS,
  type AiSkillDocument,
  type AiSkillReferenceInput,
  parseAiSkillMarkdown,
  serializeAiSkillMarkdown,
  validateAiSkillReferences,
} from "./skill-format";

export type LaunchAssistantInput = {
  title?: string;
  projectId?: string;
  draft?: { content: Array<Extract<AiDraftContentPart, { type: "text" | "resource" }>> };
  files?: File[];
  preloadTools?: Array<{ name: string } | { appId: string; kind: "query" | "action"; id: string }>;
};

export type AssistantLaunch = {
  conversation: AiConversation;
  href: string;
};

export const launchAssistant = async (input: LaunchAssistantInput): Promise<AssistantLaunch> => {
  const { files = [], ...createInput } = input;
  if (files.length > AI_TURN_ATTACHMENT_MAX_ITEMS) {
    throw new Error(`Assistant drafts can attach at most ${AI_TURN_ATTACHMENT_MAX_ITEMS} files`);
  }
  if ((input.draft?.content.length ?? 0) + files.length > 20) {
    throw new Error("Assistant drafts can contain at most 20 parts");
  }
  const response = await fetch("/api/ai/conversations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(createInput),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(body?.message ?? "Assistant chat could not be created");
  }
  let conversation = (await response.json()) as AiConversation;
  try {
    if (files.length > 0) {
      const uploaded = await Promise.all(
        files.map(async (file) => {
          const form = new FormData();
          form.set("file", file);
          const upload = await fetch(`/api/ai/conversations/${encodeURIComponent(conversation.id)}/files`, { method: "POST", body: form });
          if (!upload.ok) throw new Error(`Could not attach ${file.name}`);
          return (await upload.json()) as { file: Omit<Extract<AiDraftContentPart, { type: "file" }>, "type"> };
        }),
      );
      const draftResponse = await fetch(`/api/ai/conversations/${encodeURIComponent(conversation.id)}/draft`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          expectedRevision: conversation.draft.revision,
          content: [...(input.draft?.content ?? []), ...uploaded.map((item) => ({ type: "file" as const, ...item.file }))],
        }),
      });
      if (!draftResponse.ok) throw new Error("Assistant draft attachments could not be saved");
      conversation = { ...conversation, draft: (await draftResponse.json()) as AiConversation["draft"] };
    }
  } catch (error) {
    await fetch(`/api/ai/conversations/${encodeURIComponent(conversation.id)}/archive`, { method: "POST" }).catch(() => undefined);
    throw error;
  }
  return {
    conversation,
    href: `/app/assistant?conversation=${encodeURIComponent(conversation.id)}`,
  };
};
