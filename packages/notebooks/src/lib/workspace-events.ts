import type { PresentationMode } from "./presentation-mode";
import { STREAM_CURSOR_PATTERN } from "./yjs";

export const NOTEBOOKS_WORKSPACE_WS_TYPE = {
  subscribe: "notes.workspace.subscribe",
  ready: "notes.workspace.ready",
  event: "notes.workspace.event",
  error: "notes.workspace.error",
  revoked: "notes.workspace.revoked",
} as const;

export type NotebookWorkspaceNotebook = {
  id: string;
  shortId: string;
  name: string;
  description: string | null;
  icon: string | null;
  homepageNoteId: string | null;
  homepageNoteShortId: string | null;
  scriptsEnabled: boolean;
  defaultPresentationMode: PresentationMode;
  defaultNoteTitleTemplate: string;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
};

export type NotebookWorkspaceNote = {
  id: string;
  shortId: string;
  notebookId: string;
  parentId: string | null;
  title: string;
  position: number;
  hasChildren: boolean;
  yjsSnapshotAt: string | null;
  contentMd: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  lockedAt: string | null;
};

type NotebookWorkspaceEventNote = NotebookWorkspaceNote & {
  parentShortId: string | null;
};

export type NotebookWorkspaceInvalidationScope = "notebook" | "tree" | "tags" | "references" | "permissions";

export type NotebookWorkspaceEvent =
  | {
      v: 1;
      type: "notebook.updated";
      notebookId: string;
      notebook: NotebookWorkspaceNotebook;
    }
  | {
      v: 1;
      type: "note.created";
      notebookId: string;
      note: NotebookWorkspaceEventNote;
    }
  | {
      v: 1;
      type: "note.updated";
      notebookId: string;
      note: NotebookWorkspaceEventNote;
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
      notebook: Omit<NotebookWorkspaceNotebook, "shortId" | "homepageNoteShortId">;
    }
  | {
      v: 1;
      type: "note.created" | "note.updated";
      notebookId: string;
      note: Omit<NotebookWorkspaceEventNote, "shortId" | "parentShortId">;
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

export const notebooksWorkspace = {
  wsType: NOTEBOOKS_WORKSPACE_WS_TYPE,
  streamCursorPattern: STREAM_CURSOR_PATTERN,
} as const;
