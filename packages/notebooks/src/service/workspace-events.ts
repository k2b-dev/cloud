import { lazySync, sql } from "@k2b/cloud";
import { latestTopicCursor } from "@k2b/cloud/services";
import { createPgOutbox } from "@k2b/cloud/services/outbox";
import type { SQL, TransactionSQL } from "bun";
import type { NotebookWorkspaceEvent, NotebookWorkspaceInvalidationScope } from "../lib/workspace-events";

type InvalidationReason = Extract<NotebookWorkspaceEvent, { type: "workspace.invalidated" }>["reason"];

const TOPIC_ID = "cloud:notebooks:events:workspace";
const TOPIC_RETENTION_MS = 24 * 60 * 60 * 1000;

export const workspaceTopic = lazySync((sync) =>
  sync.topic<NotebookWorkspaceEvent>({
    id: TOPIC_ID,
    retention: { maxAgeMs: TOPIC_RETENTION_MS, maxBytes: 256 * 1024 * 1024 },
    maxPayloadBytes: 68_096,
  }),
);

type WorkspaceOutboxRow = { id: string; attempts: number; notebook_id: string; payload: NotebookWorkspaceEvent };

export const createWorkspaceOutbox = (config: { reconcileIntervalMs?: number } = {}) =>
  createPgOutbox<WorkspaceOutboxRow>({
    table: "notebooks.workspace_outbox",
    name: "notebooks:workspace-events",
    orderBy: "notebook_id",
    sequence: "seq",
    // Same cadence as platform live delivery; batch, claim and backoff use its defaults.
    reconcileIntervalMs: config.reconcileIntervalMs ?? 1_000,
    publish: (row) =>
      workspaceTopic().publish({
        tenantId: row.notebook_id,
        orderingKey: row.notebook_id,
        idempotencyKey: row.id,
        data: row.payload,
      }),
  });

export const workspaceOutbox = createWorkspaceOutbox();

/** Commit domain writes and their hints before waking delivery. Nested writers use the supplied tx. */
export const workspaceTransaction = async <const T>(run: SQL.TransactionContextCallback<T>, database = sql) => {
  const result = await database.begin(run);
  void workspaceOutbox.notify();
  return result;
};

// Only enqueue here. The lifecycle dispatcher publishes committed rows, including
// those left by a stopped process. Every hint is a reference-only invalidation:
// a repeat after the broker's dedupe window only refetches canonical state.
const publish = async (tx: TransactionSQL, event: NotebookWorkspaceEvent): Promise<void> => {
  await tx`INSERT INTO notebooks.workspace_outbox (notebook_id, payload)
    VALUES (${event.notebookId}::uuid, ${JSON.stringify(event)}::text::jsonb)`;
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

export const notebookUpdated = (notebook: { id: string }, tx: TransactionSQL): Promise<void> =>
  publish(tx, { v: 1, type: "notebook.updated", notebookId: notebook.id, notebook: {} });

const resolveNoteShortId = async (noteId: string | null, tx: TransactionSQL): Promise<string | null> => {
  if (!noteId) return null;
  const [row] = await tx<{ short_id: string }[]>`
    SELECT short_id FROM notebooks.notes WHERE id = ${noteId}::uuid
  `;
  return row?.short_id ?? null;
};

type NoteHint = { id: string; shortId: string; notebookId: string; historyIncomplete?: boolean };
const noteRef = (note: NoteHint) => ({ id: note.id, shortId: note.shortId, historyIncomplete: note.historyIncomplete });

export const noteCreated = (note: NoteHint & { createdAt: string }, tx: TransactionSQL): Promise<void> =>
  publish(tx, { v: 1, type: "note.created", notebookId: note.notebookId, note: noteRef(note) });

export const noteUpdated = (note: NoteHint, tx: TransactionSQL): Promise<void> =>
  publish(tx, { v: 1, type: "note.updated", notebookId: note.notebookId, note: noteRef(note) });

export const noteDeleted = (config: { notebookId: string; noteId: string; shortId: string }, tx: TransactionSQL): Promise<void> =>
  publish(tx, {
    v: 1,
    type: "note.deleted",
    notebookId: config.notebookId,
    noteId: config.noteId,
    shortId: config.shortId,
  });

export const noteFavoriteChanged = async (
  config: {
    notebookId: string;
    noteId: string;
    userId: string;
    favorite: boolean;
  },
  tx: TransactionSQL,
): Promise<void> =>
  publish(tx, {
    v: 1,
    type: "note.favorite.changed",
    notebookId: config.notebookId,
    noteId: config.noteId,
    shortId: await resolveNoteShortId(config.noteId, tx),
    userId: config.userId,
    favorite: config.favorite,
  });

export const noteCommentsChanged = async (config: { notebookId: string; noteId: string }, tx: TransactionSQL): Promise<void> =>
  publish(tx, {
    v: 1,
    type: "note.comments.changed",
    notebookId: config.notebookId,
    noteId: config.noteId,
    noteShortId: await resolveNoteShortId(config.noteId, tx),
  });

export const invalidated = (
  config: {
    notebookId: string;
    reason: InvalidationReason;
    scopes: NotebookWorkspaceInvalidationScope[];
  },
  tx: TransactionSQL,
): Promise<void> =>
  publish(tx, {
    v: 1,
    type: "workspace.invalidated",
    notebookId: config.notebookId,
    reason: config.reason,
    scopes: config.scopes,
  });
