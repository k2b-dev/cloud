import { aiConversations, aiProjects } from "@k2b/cloud/ai";
import { z } from "zod";
import { HttpScope } from "../chat-code/http-contracts";
import { ArtifactError, type ArtifactIdentity, user } from "./identity";

export async function authorizeRuntimeScope(input: unknown, identity: ArtifactIdentity) {
  const scope = HttpScope.parse(input);
  const actor = user(identity);
  if (scope.conversationId) {
    const chat = z.uuid().safeParse(scope.conversationId).success
      ? await aiConversations.getConversation({ conversationId: scope.conversationId, ownerUserId: actor.id })
      : await aiConversations.getConversationByShortId({ shortId: scope.conversationId, ownerUserId: actor.id });
    if (
      !chat ||
      chat.archivedAt ||
      (chat.allowedTools !== null && chat.allowedTools !== undefined) ||
      (chat.projectId && !(await aiProjects.get(chat.projectId, identity, "read")))
    )
      throw new ArtifactError("ACCESS_DENIED");
    scope.conversationId = chat.id;
  }
  if (!scope.conversationId) throw new ArtifactError("ACCESS_DENIED");
  return { scope, actor };
}
