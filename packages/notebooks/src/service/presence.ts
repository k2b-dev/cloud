import { SnapshotOverflowError } from "@k2b/sync";
import { lazySync } from "@valentinkolb/cloud";
import type { NotebookPresenceParticipant } from "@valentinkolb/cloud/contracts";
import { logger } from "@valentinkolb/cloud/services";
import { getNotebookPresenceColor } from "../lib/yjs";
import { NODE_ID } from "./yjs-sync";

const log = logger("notebooks:presence");
const PRESENCE_TTL_MS = 30_000;
export const PRESENCE_HEARTBEAT_INTERVAL_MS = 10_000;

/**
 * Internal presence entry shape — we write and read it in this module only,
 * so TS types give enough safety without runtime validation.
 */
type PresenceEntry = {
  userId: string;
  displayName: string;
  avatarHash?: string | null;
  color: string;
  peerId: string;
  nodeId: string;
  joinedAt: number;
};

const presenceStore = lazySync((sync) =>
  sync.ephemeral<PresenceEntry>({
    id: "notebooks.presence",
    ttlMs: PRESENCE_TTL_MS,
    // Bounds one note's participant snapshot; beyond it the list degrades to empty instead of failing joins.
    maxEntries: 1_000,
    maxValueBytes: 4_000,
  }),
);

export type NotebookPresenceSnapshot = {
  participants: NotebookPresenceParticipant[];
};

const toParticipants = (entries: Array<{ value: PresenceEntry }>): NotebookPresenceParticipant[] => {
  const deduped = new Map<
    string,
    {
      userId: string;
      displayName: string;
      avatarHash: string | null;
      color: string;
      peerCount: number;
      joinedAt: number;
      identityJoinedAt: number;
    }
  >();

  for (const entry of entries) {
    const current = deduped.get(entry.value.userId);
    if (current) {
      current.peerCount += 1;
      current.joinedAt = Math.min(current.joinedAt, entry.value.joinedAt);
      if (entry.value.joinedAt >= current.identityJoinedAt) {
        current.displayName = entry.value.displayName;
        current.color = entry.value.color;
        if (entry.value.avatarHash !== undefined) current.avatarHash = entry.value.avatarHash;
        current.identityJoinedAt = entry.value.joinedAt;
      }
      continue;
    }

    deduped.set(entry.value.userId, {
      userId: entry.value.userId,
      displayName: entry.value.displayName,
      avatarHash: entry.value.avatarHash ?? null,
      color: entry.value.color,
      peerCount: 1,
      joinedAt: entry.value.joinedAt,
      identityJoinedAt: entry.value.joinedAt,
    });
  }

  return [...deduped.values()]
    .map((participant) => ({
      userId: participant.userId,
      displayName: participant.displayName,
      avatarHash: participant.avatarHash,
      color: participant.color,
      peerCount: participant.peerCount,
      joinedAt: new Date(participant.joinedAt).toISOString(),
    }))
    .sort((left, right) => left.displayName.localeCompare(right.displayName));
};

export const snapshot = async (config: { noteId: string }): Promise<NotebookPresenceSnapshot> => {
  try {
    const state = await presenceStore().snapshot({ tenantId: config.noteId });
    return { participants: toParticipants(state.entries) };
  } catch (error) {
    if (!(error instanceof SnapshotOverflowError)) throw error;
    // Collaboration must keep working when a note is unusually crowded; only the participant list is lost.
    log.warn("Presence participant list exceeds the snapshot bound; reporting no participants", {
      noteId: config.noteId,
      maxEntries: error.maxEntries,
    });
    return { participants: [] };
  }
};

export const watch = (config: { noteId: string; after?: string; signal?: AbortSignal }) =>
  presenceStore().watch({
    tenantId: config.noteId,
    after: config.after,
    signal: config.signal,
  });

export const join = async (config: {
  noteId: string;
  peerId: string;
  userId: string;
  displayName: string;
  avatarHash: string | null;
}): Promise<void> => {
  await presenceStore().upsert({
    tenantId: config.noteId,
    key: config.peerId,
    value: {
      userId: config.userId,
      displayName: config.displayName,
      avatarHash: config.avatarHash,
      color: getNotebookPresenceColor(config.userId),
      peerId: config.peerId,
      nodeId: NODE_ID,
      joinedAt: Date.now(),
    },
  });
};

export const heartbeat = async (config: { noteId: string; peerId: string }): Promise<{ ok: boolean }> => {
  const result = await presenceStore().touch({
    tenantId: config.noteId,
    key: config.peerId,
  });

  return { ok: result };
};

export const leave = async (config: { noteId: string; peerId: string; reason?: string }): Promise<boolean> =>
  presenceStore().delete({
    tenantId: config.noteId,
    key: config.peerId,
  });
