import { type AiChatOrigin, type AiChatTurnTrigger, aiConversations } from "@k2b/cloud/ai";
import type { CapabilityExecutionContext } from "@k2b/cloud/contracts";
import { nestedInvocationLeases } from "@k2b/cloud/services/identity";
import { err, fail, ok } from "@k2b/stdlib";
import type { SQL } from "bun";

/** Shared destination identity; resource references never grant authority. */
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
/** A chat's own turn never writes into the same chat; it answers there directly. */
export const sendsToItself = (origin: AiChatOrigin, chatShortId: string) => origin.kind === "chat" && origin.id === chatShortId;
export const ownedActiveChat = async (account: string, chatId: string, db: SQL, options: { lock?: boolean } = {}) => {
  const [chat] = await db<{ id: string; short_id: string; title: string; project_id: string | null }[]>`
    SELECT id,short_id,title,project_id FROM ai.conversations
    WHERE short_id=${chatId} AND created_by_user_id=${account}::uuid AND archived_at IS NULL
    ${options.lock ? db`FOR UPDATE` : db``}`;
  return chat ?? null;
};

/** Verified source coordinates, never an input, key, or caller-claimed chat ID. Shared with create. */
export const chatWriteAuthority = async (context: CapabilityExecutionContext, db: SQL) => {
  const { actor, accessSubject, authority } = context;
  if (
    actor.kind !== "user" ||
    accessSubject.type !== "user" ||
    accessSubject.userId !== actor.user.id ||
    context.user?.id !== actor.user.id
  )
    return fail(err.forbidden("Chat writes require their owner"));
  const de = context.locale.split("-")[0] === "de";
  const restricted = () =>
    fail({
      code: "source_restricted",
      message: de
        ? "Dieser Zugang darf keinen Zug mit den vollen Rechten der Person starten."
        : "This source cannot start a turn with the person's full authority.",
      status: 403 as const,
    });
  if (
    !authority ||
    authority.actor.kind !== "user" ||
    authority.actor.user.id !== actor.user.id ||
    authority.scopes.length ||
    context.origin === "mcp" ||
    actor.sessionKind === "app" ||
    authority.actor.sessionKind === "app"
  )
    return restricted();
  const run = personalCodeRun(context);
  if (run) {
    const [code] = await db<{ id: string; title: string }[]>`
      SELECT code.id,code.title FROM code.codes code JOIN code.runs run ON run.code_id=code.id
      WHERE run.id=${run.runId}::uuid AND run.version_id=${run.versionId}::uuid
        AND code.owner_kind='person' AND code.owner_user_id=${actor.user.id}::uuid AND code.state='active'
        AND code.active_version_id=run.version_id AND run.state='running'`;
    return code
      ? ok({
          origin: {
            kind: "automation",
            id: code.id,
            runId: run.runId,
            // Server-checked Code: its reader names and links it for every viewer who may read it.
            resource: { type: "core.code", id: code.id },
          } satisfies AiChatOrigin,
          turnTrigger: { kind: "automation", id: code.id } satisfies AiChatTurnTrigger,
          code: { ...code, ...run },
        })
      : fail(err.notFound("Code"));
  }
  const delegation = actor.delegation;
  if (!delegation)
    return authority.credentialKind === "session" && context.origin === "http"
      ? ok({
          origin: { kind: "person", id: actor.user.id } satisfies AiChatOrigin,
          turnTrigger: { kind: "person", id: actor.user.id } satisfies AiChatTurnTrigger,
          code: null,
        })
      : restricted();
  if (delegation.credentialKind !== "session") return restricted();
  const lease = await nestedInvocationLeases.read(delegation.invocationId);
  // The source may still be valid; its lease is just not readable now. Never misreport that as a restriction.
  // 409, not 503: the dispatcher releases the key, so the same call can be repeated.
  if (!lease)
    return fail({
      code: "source_unavailable",
      message: de
        ? "Die Herkunft dieses Aufrufs lässt sich gerade nicht prüfen. Versuch es gleich noch einmal."
        : "The source of this call cannot be checked right now. Try again shortly.",
      status: 409 as const,
    });
  if (!lease.assistantTurn)
    return lease.proof?.kind === "session" && lease.proof.userId === actor.user.id
      ? ok({
          origin: { kind: "person", id: actor.user.id } satisfies AiChatOrigin,
          turnTrigger: { kind: "person", id: actor.user.id } satisfies AiChatTurnTrigger,
          code: null,
        })
      : restricted();
  const source = lease.assistantTurn;
  const [chat, config, turn] = await Promise.all([
    aiConversations.getConversation({ conversationId: source.conversationId, ownerUserId: actor.user.id }),
    aiConversations.getTurnRunConfig(source),
    aiConversations.getTurn(source),
  ]);
  if (
    !chat ||
    chat.archivedAt ||
    !turn ||
    !["running", "waiting_for_action"].includes(turn.status) ||
    turn.cancelRequestedAt ||
    !config ||
    config.kind === "compact"
  )
    return restricted();
  if (
    (chat.allowedTools !== null && chat.allowedTools !== undefined) ||
    config.sourceRestricted ||
    (config.actor?.kind === "user" && config.actor.sessionKind === "app")
  )
    return restricted();
  if (config.turnTrigger?.kind !== "person" || config.turnTrigger.id !== actor.user.id)
    return fail({
      code: "chat_chain_forbidden",
      message: de
        ? "Ein nicht von der Person ausgelöster Zug darf nicht in einen anderen Chat schreiben oder einen Chat erstellen."
        : "A turn not initiated by the person cannot write to or create another chat.",
      status: 403 as const,
    });
  return ok({
    source: { conversationId: chat.id, turnId: turn.id },
    origin: { kind: "chat", id: chat.shortId, turnId: turn.shortId } satisfies AiChatOrigin,
    turnTrigger: { kind: "chat", id: chat.shortId } satisfies AiChatTurnTrigger,
    code: null,
  });
};
