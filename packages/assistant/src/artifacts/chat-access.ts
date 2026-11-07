import { type AiConversation, aiConversations, aiProjects } from "@k2b/cloud/ai";
import { CodeResourceId } from "@k2b/cloud/ai/browser";
import { z } from "zod";
import { ArtifactError, type ArtifactIdentity } from "./service";

// Public chat id or internal UUID.
export const ChatReference = z.union([z.uuid(), CodeResourceId]);

export async function requireToolChat(
  reference: string,
  identity: Pick<ArtifactIdentity, "actor" | "accessSubject">,
  tool: string,
): Promise<AiConversation> {
  if (identity.actor.kind !== "user") throw new ArtifactError("ACCESS_DENIED");
  const ownerUserId = identity.actor.user.id;
  const chat = z.uuid().safeParse(reference).success
    ? await aiConversations.getConversation({ conversationId: reference, ownerUserId })
    : await aiConversations.getConversationByShortId({ shortId: reference, ownerUserId });
  if (
    !chat ||
    chat.archivedAt ||
    (chat.allowedTools && !chat.allowedTools.includes(tool)) ||
    (chat.projectId && !(await aiProjects.get(chat.projectId, identity, "read")))
  )
    throw new ArtifactError("ACCESS_DENIED");
  return chat;
}
