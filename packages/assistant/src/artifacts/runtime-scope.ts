import { aiConversations, aiProjects } from "@k2b/cloud/ai";
import { z } from "zod";
import { HttpScope } from "./http-contracts";
import { artifacts, ArtifactError, user, type ArtifactIdentity } from "./service";

export async function authorizeRuntimeScope(input: unknown, identity: ArtifactIdentity) {
  const scope = HttpScope.parse(input);
  const actor = user(identity);
  if (scope.conversationId) {
    const chat = z.uuid().safeParse(scope.conversationId).success
      ? await aiConversations.getConversation({ conversationId: scope.conversationId, ownerUserId: actor.id })
      : await aiConversations.getConversationByShortId({ shortId: scope.conversationId, ownerUserId: actor.id });
    if (!chat || chat.archivedAt || (chat.allowedTools !== null && chat.allowedTools !== undefined)
      || (chat.projectId && !(await aiProjects.get(chat.projectId, identity.accessSubject, "read")))) throw new ArtifactError("ACCESS_DENIED");
    scope.conversationId = chat.id;
  }
  if (scope.resourceId) await artifacts.get(scope.resourceId, { ...identity, conversationId: scope.conversationId });
  return { scope, actor };
}
