import { STREAM_CURSOR_PATTERN } from "./yjs";

export const NOTEBOOKS_WORKSPACE_WS_TYPE = {
  subscribe: "notes.workspace.subscribe",
  ready: "notes.workspace.ready",
  event: "notes.workspace.event",
  error: "notes.workspace.error",
  revoked: "notes.workspace.revoked",
} as const;

/**
 * Workspace events are invalidation hints: every reader refetches through the
 * permission-aware HTTP routes, so an event names what changed and nothing
 * more. Note text or titles would reach readers whose access has ended, and a
 * long note would exceed the topic's payload limit and lose its hint.
 */
type NotebookWorkspaceNoteRef = {
  id: string;
  shortId: string;
  historyIncomplete?: boolean;
};

export type NotebookWorkspaceInvalidationScope = "notebook" | "tree" | "tags" | "references" | "permissions";

export type NotebookWorkspaceEvent =
  | {
      v: 1;
      type: "notebook.updated";
      notebookId: string;
      /**
       * Published empty. Replicas from before reference-only events destructure
       * it, so a rolling deploy or an image rollback must still find an object;
       * events retained from then still carry notebook fields.
       */
      notebook: Record<string, unknown>;
    }
  | {
      v: 1;
      type: "note.created" | "note.updated";
      notebookId: string;
      note: NotebookWorkspaceNoteRef;
    }
  | {
      v: 1;
      type: "note.deleted";
      notebookId: string;
      noteId: string;
      shortId: string;
    }
  | {
      v: 1;
      type: "note.favorite.changed";
      notebookId: string;
      noteId: string;
      shortId: string | null;
      userId: string;
      favorite: boolean;
    }
  | {
      v: 1;
      type: "note.comments.changed";
      notebookId: string;
      noteId: string;
      noteShortId: string | null;
    }
  | {
      v: 1;
      type: "workspace.invalidated";
      notebookId: string;
      reason: "bulk" | "template" | "permissions" | "unknown";
      scopes: NotebookWorkspaceInvalidationScope[];
    };

export type PublicNotebookWorkspaceEvent =
  | {
      v: 1;
      type: "notebook.updated";
      notebookId: string;
    }
  | {
      v: 1;
      type: "note.created" | "note.updated";
      notebookId: string;
      note: Omit<NotebookWorkspaceNoteRef, "shortId">;
    }
  | {
      v: 1;
      type: "note.deleted";
      notebookId: string;
      noteId: string;
    }
  | {
      v: 1;
      type: "note.favorite.changed";
      notebookId: string;
      noteId: string;
      userId: string;
      favorite: boolean;
    }
  | {
      v: 1;
      type: "note.comments.changed";
      notebookId: string;
      noteId: string;
    }
  | {
      v: 1;
      type: "workspace.invalidated";
      notebookId: string;
      reason: "bulk" | "template" | "permissions" | "unknown";
      scopes: NotebookWorkspaceInvalidationScope[];
    };

/**
 * Whether an event means somebody's access to the notebook may have changed.
 *
 * Live sockets re-evaluate their own access when this is true, so widening it
 * costs a database round trip per event and narrowing it lets a withdrawn grant
 * survive until the backstop timer fires.
 */
export const isPermissionInvalidation = (event: NotebookWorkspaceEvent): boolean =>
  event.type === "workspace.invalidated" && event.scopes.includes("permissions");

/**
 * Project a stored event for one reader: internal ids become short ids, and a
 * favorite reaches only the person who set it (`null` means skip the event).
 * The projection names its fields, so an older retained event that still
 * carries note text or notebook fields loses them here.
 */
export const toPublicWorkspaceEvent = (
  event: NotebookWorkspaceEvent,
  reader: { notebookShortId: string; userId: string | null },
): PublicNotebookWorkspaceEvent | null => {
  const notebookId = reader.notebookShortId;
  const treeChanged = (): PublicNotebookWorkspaceEvent => ({
    v: 1,
    type: "workspace.invalidated",
    notebookId,
    reason: "unknown",
    scopes: ["tree"],
  });
  switch (event.type) {
    case "notebook.updated":
      return { v: 1, type: event.type, notebookId };
    case "note.created":
    case "note.updated":
      return { v: 1, type: event.type, notebookId, note: { id: event.note.shortId, historyIncomplete: event.note.historyIncomplete } };
    case "note.deleted":
      return { v: 1, type: event.type, notebookId, noteId: event.shortId };
    case "note.favorite.changed":
      if (event.userId !== reader.userId) return null;
      if (!event.shortId) return treeChanged();
      return { v: 1, type: event.type, notebookId, noteId: event.shortId, userId: event.userId, favorite: event.favorite };
    case "note.comments.changed":
      if (!event.noteShortId) return treeChanged();
      return { v: 1, type: event.type, notebookId, noteId: event.noteShortId };
    case "workspace.invalidated":
      return { ...event, notebookId };
  }
};

export const notebooksWorkspace = {
  wsType: NOTEBOOKS_WORKSPACE_WS_TYPE,
  streamCursorPattern: STREAM_CURSOR_PATTERN,
} as const;
