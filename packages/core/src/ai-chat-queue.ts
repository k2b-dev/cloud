import { aiProjects, isAiSettingsError, personalAiModelPolicy, selectAssistantAiModel } from "@k2b/cloud/ai";
import { AiQueuedChatStartError, type ValidateQueuedChatStart } from "@k2b/cloud/ai/runtime";
import { accounts, coreSettings } from "@k2b/cloud/services";
import { isAccountExpired } from "@k2b/cloud/services/account-model";
import { openCodeChatWork } from "./ai-chat-send";
import { checkCodeChatRunBudget } from "./code/ai-budget";
import { codeSettings } from "./code/settings";

/** The original invocation may be over. Revalidate its durable authority, never an expired session lease. */
export const validateQueuedChatStart: ValidateQueuedChatStart = async (input, db, state, messageId) => {
  const config = input.runConfig;
  const owner = config.send?.accountId;
  const origin = config.writerOrigin;
  const trigger = config.turnTrigger;
  if (
    !owner ||
    !origin ||
    !trigger ||
    trigger.kind !== origin.kind ||
    trigger.id !== origin.id ||
    config.sourceRestricted ||
    config.mandate ||
    config.actor?.kind !== "user" ||
    config.actor.user.id !== owner ||
    config.actor.sessionKind === "app" ||
    config.actor.delegation
  )
    throw new AiQueuedChatStartError("source_restricted");
  const [chat] = await db<{ project_id: string | null }[]>`SELECT project_id FROM ai.conversations WHERE id=${input.conversationId}::uuid
    AND created_by_user_id=${owner}::uuid AND archived_at IS NULL`;
  if (!chat) throw new AiQueuedChatStartError("chat_unavailable");
  if (chat.project_id !== input.expectedProjectId) throw new AiQueuedChatStartError("chat_changed");
  const user = await accounts.users.get({ id: owner }, { db });
  if (!user || isAccountExpired(user.accountExpires)) throw new AiQueuedChatStartError("source_restricted");
  if (
    chat.project_id &&
    !(await aiProjects.get(chat.project_id, { actor: { kind: "user", user }, accessSubject: { type: "user", userId: owner } }, "read", db))
  )
    throw new AiQueuedChatStartError("source_restricted");
  if (origin.kind === "person" && origin.id !== owner) throw new AiQueuedChatStartError("source_restricted");
  if (origin.kind === "chat") {
    const [source] = await db<
      {
        allowed_tools: unknown;
        run_config: { sourceRestricted?: boolean; actor?: { sessionKind?: string }; turnTrigger?: { kind: string; id: string } };
      }[]
    >`
      SELECT c.allowed_tools,t.run_config FROM ai.conversations c JOIN ai.turns t ON t.conversation_id=c.id
      WHERE c.short_id=${origin.id} AND t.short_id=${origin.turnId}
        AND c.created_by_user_id=${owner}::uuid AND c.archived_at IS NULL`;
    if (!source || source.allowed_tools !== null || source.run_config.sourceRestricted || source.run_config.actor?.sessionKind === "app")
      throw new AiQueuedChatStartError("source_restricted");
    if (source.run_config.turnTrigger?.kind !== "person" || source.run_config.turnTrigger.id !== owner)
      throw new AiQueuedChatStartError("chat_chain_forbidden");
  }
  if (origin.kind === "automation") {
    if (!origin.runId) throw new AiQueuedChatStartError("source_restricted");
    const [code] = await db`SELECT c.id FROM code.codes c JOIN code.runs r ON r.code_id=c.id
      WHERE c.id=${origin.id} AND r.id=${origin.runId ?? null}::uuid
        AND c.owner_kind='person' AND c.owner_user_id=${owner}::uuid AND c.state='active'
        AND c.active_version_id=r.version_id FOR SHARE OF c`;
    if (!code || config.codeOrigin?.codeId !== origin.id || config.codeOrigin.runId !== origin.runId)
      throw new AiQueuedChatStartError("code_inactive");
    // Until the whole-turn reservation lands, one open message or turn per Code across chats.
    await db`SELECT pg_advisory_xact_lock(hashtextextended(${`ai.chat.send.code:${origin.id}`},0))`;
    if (await openCodeChatWork(origin.id, db, messageId)) throw new AiQueuedChatStartError("code_busy");
    const refused = await checkCodeChatRunBudget(origin.runId, db, {
      code: await codeSettings.get("core.code.ai_daily_budget_usd", db),
      owner: await codeSettings.get("core.code.ai_owner_daily_budget_usd", db),
      timeZone: (await coreSettings.get<string>("app.timezone", db)) || "UTC",
    });
    if (refused) throw new AiQueuedChatStartError(refused);
  }
  try {
    await selectAssistantAiModel({ type: "user", userId: owner }, { id: input.modelId }, personalAiModelPolicy, state, db);
  } catch (error) {
    if (isAiSettingsError(error)) throw new AiQueuedChatStartError(error.aiError.code);
    throw error;
  }
  // Refresh account identity before execution: a queued snapshot cannot retain revoked roles.
  return { ...input, runConfig: { ...config, actor: { kind: "user", user } } };
};
