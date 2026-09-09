import { err, fail, ok, type Result } from "@k2b/stdlib";
import { lazySync } from "@k2b/cloud";
import { sql } from "bun";
import type { ConversationPresenceHeartbeat, ConversationPresenceMode } from "../contracts";
import { type MailRequestContext, userBackedActor } from "./auth";
import { requireMailboxCollaborationPermission } from "./collaboration";
import { currentMailboxUserIds } from "./collaborators";

const PRESENCE_TTL_MS = 30_000;
export const PRESENCE_HEARTBEAT_INTERVAL_MS = 10_000;

type PresenceEntry = {
  userId: string;
  displayName: string;
  avatarHash: string | null;
  peerId: string;
  mode: ConversationPresenceMode;
  joinedAt: number;
};

export type ConversationPresenceParticipant = {
  userId: string;
  displayName: string;
  avatarHash: string | null;
  mode: ConversationPresenceMode;
  peerCount: number;
  joinedAt: string;
};

export type ConversationPresenceSnapshot = {
  participants: ConversationPresenceParticipant[];
};

const presenceStore = lazySync((sync) =>
  sync.ephemeral<PresenceEntry>({
    id: "mail.conversation-presence",
    ttlMs: PRESENCE_TTL_MS,
    maxEntries: 250,
    maxValueBytes: 4_000,
  }),
);

const authorizeConversation = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  conversationId: string;
  permission: "read" | "write";
}) => {
  const user = userBackedActor(params.context);
  if (!user) return fail(err.forbidden("Conversation presence requires a user-backed actor"));
  const allowed = await requireMailboxCollaborationPermission(params.context, params.mailboxId, params.permission);
  if (!allowed.ok) return allowed;
  const [conversation] = await sql<{ id: string }[]>`
    SELECT id FROM mail.conversations
    WHERE id = ${params.conversationId}::uuid AND mailbox_id = ${params.mailboxId}::uuid
  `;
  return conversation ? ok(user) : fail(err.notFound("Conversation"));
};

const summarizeParticipants = (entries: Array<{ value: PresenceEntry }>): ConversationPresenceParticipant[] => {
  const participants = new Map<string, ConversationPresenceParticipant>();
  for (const { value } of entries) {
    const current = participants.get(value.userId);
    if (current) {
      current.peerCount += 1;
      if (value.mode === "composing") current.mode = "composing";
      if (value.joinedAt < Date.parse(current.joinedAt)) current.joinedAt = new Date(value.joinedAt).toISOString();
      continue;
    }
    participants.set(value.userId, {
      userId: value.userId,
      displayName: value.displayName,
      avatarHash: value.avatarHash,
      mode: value.mode,
      peerCount: 1,
      joinedAt: new Date(value.joinedAt).toISOString(),
    });
  }
  return [...participants.values()].sort((left, right) => left.displayName.localeCompare(right.displayName));
};

const snapshotState = async (mailboxId: string, conversationId: string): Promise<ConversationPresenceSnapshot> => {
  const presence = await presenceStore().snapshot({ tenantId: conversationId });
  const readableUserIds = await currentMailboxUserIds({
    mailboxId,
    userIds: presence.entries.map((entry) => entry.value.userId),
    minimumPermission: "read",
  });
  return {
    participants: summarizeParticipants(presence.entries.filter((entry) => readableUserIds.has(entry.value.userId))),
  };
};

export const getConversationPresence = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  conversationId: string;
}): Promise<Result<ConversationPresenceSnapshot>> => {
  const allowed = await authorizeConversation({ ...params, permission: "read" });
  if (!allowed.ok) return allowed;
  return ok(await snapshotState(params.mailboxId, params.conversationId));
};

export const heartbeatConversationPresence = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  conversationId: string;
  input: ConversationPresenceHeartbeat;
}): Promise<Result<ConversationPresenceSnapshot>> => {
  const user = await authorizeConversation({
    ...params,
    permission: params.input.mode === "composing" ? "write" : "read",
  });
  if (!user.ok) return user;
  const key = `${user.data.id}:${params.input.peerId}`;
  const state = await presenceStore().snapshot({ tenantId: params.conversationId, prefix: key });
  const joinedAt = state.entries.find((entry) => entry.key === key)?.value.joinedAt ?? Date.now();
  await presenceStore().upsert({
    tenantId: params.conversationId,
    key,
    value: {
      userId: user.data.id,
      displayName: user.data.displayName,
      avatarHash: user.data.avatarHash,
      peerId: params.input.peerId,
      mode: params.input.mode,
      joinedAt,
    },
  });
  return ok(await snapshotState(params.mailboxId, params.conversationId));
};

export const leaveConversationPresence = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  conversationId: string;
  peerId: string;
}): Promise<Result<ConversationPresenceSnapshot>> => {
  const user = await authorizeConversation({ ...params, permission: "read" });
  if (!user.ok) return user;
  await presenceStore().delete({
    tenantId: params.conversationId,
    key: `${user.data.id}:${params.peerId}`,
  });
  return ok(await snapshotState(params.mailboxId, params.conversationId));
};
