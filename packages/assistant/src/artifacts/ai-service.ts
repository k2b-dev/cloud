import { AiTaskRequestSchema, executeAiTask, personalAiModelPolicy, resolveAiModel, selectAssistantAiModel } from "@k2b/cloud/ai";
import { authorizeRuntimeScope } from "./runtime-scope";
import type { ArtifactIdentity } from "./service";

export async function runCodeAi(
  input: unknown,
  scopeInput: unknown,
  identity: ArtifactIdentity,
  signal: AbortSignal,
  backgroundTurnId?: string,
) {
  const request = AiTaskRequestSchema.parse(input);
  const { scope, actor } = await authorizeRuntimeScope(scopeInput, identity);
  signal.throwIfAborted();
  const model = await selectAssistantAiModel(identity.accessSubject, request.model ?? (backgroundTurnId ? { class: "fast" } : undefined));
  const result = await executeAiTask(request, {
    taskPrefix: "code",
    appId: "assistant",
    signal,
    model,
    resolveModel: (id) => resolveAiModel(personalAiModelPolicy, id),
    usageSubject: backgroundTurnId ? undefined : identity.accessSubject,
    attribution: { userId: actor.id, conversationId: scope.conversationId, turnId: backgroundTurnId },
  });
  signal.throwIfAborted();
  return result.output;
}
