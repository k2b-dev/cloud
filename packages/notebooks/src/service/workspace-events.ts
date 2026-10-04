import { lazySync } from "@k2b/cloud";
import { latestTopicCursor, logger } from "@k2b/cloud/services";
import { sql } from "bun";
import type { NotebookWorkspaceEvent, NotebookWorkspaceInvalidationScope } from "../lib/workspace-events";

const log = logger("notebooks:workspace-events");
type InvalidationReason = Extract<NotebookWorkspaceEvent, { type: "workspace.invalidated" }>["reason"];

const TOPIC_ID = "cloud:notebooks:events:workspace";
const TOPIC_RETENTION_MS = 24 * 60 * 60 * 1000;

const workspaceTopic = lazySync((sync) =>
  sync.topic<NotebookWorkspaceEvent>({
    id: TOPIC_ID,
    retention: { maxAgeMs: TOPIC_RETENTION_MS, maxBytes: 256 * 1024 * 1024 },
    maxPayloadBytes: 68_096,
  }),
);

const publish = async (event: NotebookWorkspaceEvent, idempotencyKey?: string): Promise<void> => {
  try {
    await workspaceTopic().publish({
      tenantId: event.notebookId,
      orderingKey: event.notebookId,
      idempotencyKey,
      data: event,
    });
  } catch (error) {
    log.warn("Failed to publish workspace event", {
      type: event.type,
      notebookId: event.notebookId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

export const live = (config: { notebookId: string; after?: string | null; signal?: AbortSignal }) =>
  workspaceTopic()
    .hub({ tenantId: config.notebookId })
    .subscribe({
      after: config.after ?? undefined,
      signal: config.signal,
    });

/** Replay baseline for SSR; a notebook without events still gets the shared head. */
export const latestCursor = (config: { notebookId: string }): Promise<string> =>
  latestTopicCursor({ topic: workspaceTopic(), resourceId: TOPIC_ID, tenantId: config.notebookId });

export const notebookUpdated = (notebook: { id: string }): Promise<void> =>
  publish({ v: 1, type: "notebook.updated", notebookId: notebook.id });

const resolveNoteShortId = async (noteId: string | null): Promise<string | null> => {
  if (!noteId) return null;
  const [row] = await sql<{ short_id: string }[]>`
    SELECT short_id FROM notebooks.notes WHERE id = ${noteId}::uuid
  `;
  return row?.short_id ?? null;
};

type NoteHint = { id: string; shortId: string; notebookId: string; historyIncomplete?: boolean };
const noteRef = (note: NoteHint) => ({ id: note.id, shortId: note.shortId, historyIncomplete: note.historyIncomplete });

export const noteCreated = (note: NoteHint & { createdAt: string }): Promise<void> =>
  publish({ v: 1, type: "note.created", notebookId: note.notebookId, note: noteRef(note) }, `note:${note.id}:created:${note.createdAt}`);

export const noteUpdated = (note: NoteHint): Promise<void> =>
  publish({ v: 1, type: "note.updated", notebookId: note.notebookId, note: noteRef(note) });

export const noteDeleted = (config: { notebookId: string; noteId: string; shortId: string }): Promise<void> =>
  publish(
    {
      v: 1,
      type: "note.deleted",
      notebookId: config.notebookId,
      noteId: config.noteId,
      shortId: config.shortId,
    },
    `note:${config.noteId}:deleted`,
  );

export const noteFavoriteChanged = async (config: {
  notebookId: string;
  noteId: string;
  userId: string;
  favorite: boolean;
}): Promise<void> =>
  publish({
    v: 1,
    type: "note.favorite.changed",
    notebookId: config.notebookId,
    noteId: config.noteId,
    shortId: await resolveNoteShortId(config.noteId),
    userId: config.userId,
    favorite: config.favorite,
  });

export const noteCommentsChanged = async (config: { notebookId: string; noteId: string }): Promise<void> =>
  publish({
    v: 1,
    type: "note.comments.changed",
    notebookId: config.notebookId,
    noteId: config.noteId,
    noteShortId: await resolveNoteShortId(config.noteId),
  });

export const invalidated = (config: {
  notebookId: string;
  reason: InvalidationReason;
  scopes: NotebookWorkspaceInvalidationScope[];
}): Promise<void> =>
  publish({
    v: 1,
    type: "workspace.invalidated",
    notebookId: config.notebookId,
    reason: config.reason,
    scopes: config.scopes,
  });
