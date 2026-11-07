import type { CapabilityExecutionContext } from "@k2b/cloud/contracts";
import type { SQL } from "bun";

/** Shared personal-Code authority and active destination ownership for chat Actions. */
export const codeChatDestination = (context: CapabilityExecutionContext) =>
  context.target?.type === "core.ai.chat" ? context.target.id : "";
export const personalCodeRun = (context: CapabilityExecutionContext) => {
  const delegation = context.actor.delegation;
  return context.actor.kind === "user" &&
    context.user?.id === context.actor.user.id &&
    context.accessSubject.type === "user" &&
    context.accessSubject.userId === context.user.id &&
    delegation?.credentialKind === "mandate" &&
    delegation.workloadType === "code.version" &&
    delegation.workloadId &&
    delegation.workloadRun &&
    ["core", "runner"].includes(delegation.callingAppId)
    ? { userId: context.user.id, versionId: delegation.workloadId, runId: delegation.workloadRun }
    : null;
};
export const ownedCodeRunChat = async (context: CapabilityExecutionContext, db: SQL, options: { lock?: boolean } = {}) => {
  const run = personalCodeRun(context);
  if (!run) return null;
  const [chat] = await db<{ id: string; short_id: string; title: string; code_id: string; code_title: string }[]>`
    SELECT conversation.id,conversation.short_id,conversation.title,code.id AS code_id,code.title AS code_title
    FROM ai.conversations conversation JOIN code.runs run ON run.id=${run.runId}::uuid
    JOIN code.codes code ON code.id=run.code_id
    WHERE run.version_id=${run.versionId}::uuid AND code.owner_kind='person' AND code.owner_user_id=${run.userId}::uuid
      AND conversation.short_id=${codeChatDestination(context)} AND conversation.created_by_user_id=${run.userId}::uuid
      AND conversation.archived_at IS NULL ${options.lock ? db`FOR UPDATE OF conversation` : db``}`;
  return chat ?? null;
};
