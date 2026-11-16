import { getApp } from "../_internal/registry";
import type { AppRegistryEntry } from "../contracts/registry";
import { resolveAppIdentityPresentation } from "../shared/app-presentation";
import { type AiOriginViewer, loadAiMessageOrigins } from "./message-origin";
import { projectAiNextMessages } from "./next-message-store";
import type { AiStoredMessageOrigin } from "./queue-contracts";
import type { AiConversation, AiStoredMessage } from "./types";

export const projectPublicAiStoredMessages = (
  messages: readonly AiStoredMessage[],
  conversationId: string,
  turnShortIds: ReadonlyMap<string, string>,
): AiStoredMessage[] =>
  messages.map((message) => ({
    ...message,
    id: message.shortId,
    conversationId,
    loopId: message.loopId ? (turnShortIds.get(message.loopId) ?? null) : null,
    meta: message.meta ? (({ writerOrigin: _, ...meta }) => meta)(message.meta) : null,
  }));

/**
 * A turn stores its steps' presentation, app name included, as it was then. An app that renames itself must read the
 * same everywhere, so stored steps name their app as the catalog does now, in the reader's language. The registry is
 * an in-memory view, so this reads no SQL; an app the registry does not know keeps its stored name.
 */
export const withCurrentAppNames = async (
  messages: readonly AiStoredMessage[],
  locale?: string,
  readApp: (appId: string) => Promise<Pick<AppRegistryEntry, "name" | "description" | "presentation"> | null> = getApp,
): Promise<AiStoredMessage[]> => {
  const appIds = new Set(
    messages.flatMap((message) =>
      Object.values(message.meta?.toolPresentations ?? {}).flatMap((presentation) =>
        presentation.kind === "capability" ? [presentation.appId] : [],
      ),
    ),
  );
  if (appIds.size === 0) return [...messages];
  const names = new Map(
    (
      await Promise.all(
        [...appIds].map(async (appId) => {
          const app = await readApp(appId).catch(() => null);
          return app ? ([[appId, locale ? resolveAppIdentityPresentation(app, locale).name : app.name]] as const) : [];
        }),
      )
    ).flat(),
  );
  if (names.size === 0) return [...messages];
  return messages.map((message) => {
    const presentations = message.meta?.toolPresentations;
    if (!presentations) return message;
    const current = Object.fromEntries(
      Object.entries(presentations).map(([callId, presentation]) => {
        const appName = presentation.kind === "capability" ? names.get(presentation.appId) : undefined;
        return [callId, appName && appName !== presentation.appName ? { ...presentation, appName } : presentation];
      }),
    );
    return { ...message, meta: { ...message.meta, toolPresentations: current } };
  });
};

export const publicAiStoredMessages = async (
  messages: readonly AiStoredMessage[],
  conversation: Pick<AiConversation, "id" | "shortId"> & Partial<Pick<AiConversation, "createdByUserId">>,
  viewerUserId?: string | null,
  /** Who reads: names of origins, and of the apps of stored steps, follow this viewer and `locale`. */
  originViewer: AiOriginViewer = {},
): Promise<AiStoredMessage[]> => {
  const attributed = messages.flatMap((message) => {
    const origin: AiStoredMessageOrigin | undefined =
      message.meta?.writerOrigin ??
      (message.meta?.agentMessage
        ? { kind: "chat", id: message.meta.agentMessage.sourceChatId, turnId: message.meta.agentMessage.sourceTurnId }
        : message.message.role === "user" && conversation.createdByUserId
          ? { kind: "person", id: conversation.createdByUserId }
          : undefined);
    return origin ? [{ ...message, meta: { ...message.meta, writerOrigin: origin } }] : [];
  });
  const [{ origins, turnShortIds }, named] = await Promise.all([
    loadAiMessageOrigins(
      attributed.map((message) => message.meta!.writerOrigin!),
      { ...originViewer, userId: originViewer.userId ?? viewerUserId },
      { conversationId: conversation.id, turnIds: messages.flatMap((message) => (message.loopId ? [message.loopId] : [])) },
    ),
    withCurrentAppNames(messages, originViewer.locale),
  ]);
  const byId = new Map(attributed.map((message, index) => [message.id, origins[index]!]));
  const projected = named.map((message) =>
    byId.has(message.id) ? { ...message, meta: { ...message.meta, origin: byId.get(message.id)! } } : message,
  );
  return projectAiNextMessages(projectPublicAiStoredMessages(projected, conversation.shortId, turnShortIds), conversation.id, viewerUserId);
};
