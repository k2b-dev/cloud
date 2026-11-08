import { AiTaskRequestSchema, executeAiTask, personalAiModelPolicy, resolveAiModel, selectAssistantAiModel } from "@k2b/cloud/ai";
import { authorizeRuntimeScope } from "./runtime-scope";
import type { ArtifactIdentity } from "./service";

export async function runCodeAi(input: unknown, scopeInput: unknown, identity: ArtifactIdentity, signal: AbortSignal) {
  const request = AiTaskRequestSchema.parse(input);
  const { scope, actor } = await authorizeRuntimeScope(scopeInput, identity);
  signal.throwIfAborted();
  const model = await selectAssistantAiModel(identity.accessSubject, request.model);
  const result = await executeAiTask(request, {
    taskPrefix: "code",
    appId: "assistant",
    signal,
    model,
    resolveModel: (id) => resolveAiModel(personalAiModelPolicy, id),
    usageSubject: identity.accessSubject,
    attribution: { userId: actor.id, conversationId: scope.conversationId },
  });
  signal.throwIfAborted();
  return result.output;
}
