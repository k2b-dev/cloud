import { lazySync } from "@k2b/cloud";
import { logger } from "@k2b/cloud/services";
import { sql } from "bun";
import type {
  NotebookWorkspaceEvent,
  NotebookWorkspaceInvalidationScope,
  NotebookWorkspaceNote,
  NotebookWorkspaceNotebook,
} from "../lib/workspace-events";

const log = logger("notebooks:workspace-events");
type InvalidationReason = Extract<NotebookWorkspaceEvent, { type: "workspace.invalidated" }>["reason"];

const TOPIC_PREFIX = "cloud:notebooks:events";
const TOPIC_RETENTION_MS = 24 * 60 * 60 * 1000;

const workspaceTopic = lazySync((sync) =>
  sync.topic<NotebookWorkspaceEvent>({
    id: `${TOPIC_PREFIX}:workspace`,
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

export const latestCursor = (config: { notebookId: string }): Promise<string | null> =>
  workspaceTopic().latestCursor({ tenantId: config.notebookId });

export const notebookUpdated = (notebook: NotebookWorkspaceNotebook): Promise<void> =>
  publish({
    v: 1,
    type: "notebook.updated",
    notebookId: notebook.id,
    notebook,
  });

const resolveNoteShortId = async (noteId: string | null): Promise<string | null> => {
  if (!noteId) return null;
  const [row] = await sql<{ short_id: string }[]>`
    SELECT short_id FROM notebooks.notes WHERE id = ${noteId}::uuid
  `;
  return row?.short_id ?? null;
};

export const noteCreated = async (note: NotebookWorkspaceNote): Promise<void> =>
  publish(
    {
      v: 1,
      type: "note.created",
      notebookId: note.notebookId,
      note: { ...note, parentShortId: await resolveNoteShortId(note.parentId) },
    },
    `note:${note.id}:created:${note.createdAt}`,
  );

export const noteUpdated = async (note: NotebookWorkspaceNote): Promise<void> =>
  publish({
    v: 1,
    type: "note.updated",
    notebookId: note.notebookId,
    note: { ...note, parentShortId: await resolveNoteShortId(note.parentId) },
  });

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
