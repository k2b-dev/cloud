import { z } from "zod";
import type { Attachment, Note, Notebook, NoteComment } from "../service";

export const ResourceShortIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9]{6}$/)
  .describe("Stable 6-character resource ID");

export const toPublicNotebook = (notebook: Notebook) => ({
  id: notebook.shortId,
  name: notebook.name,
  description: notebook.description,
  icon: notebook.icon,
  homepageNoteId: notebook.homepageNoteShortId,
  scriptsEnabled: notebook.scriptsEnabled,
  defaultNoteTitleTemplate: notebook.defaultNoteTitleTemplate,
  createdBy: notebook.createdBy,
  createdAt: notebook.createdAt,
  updatedAt: notebook.updatedAt,
});

export const toPublicNote = (note: Note, notebookId: string, parentId: string | null) => ({
  id: note.shortId,
  notebookId,
  parentId,
  title: note.title,
  position: note.position,
  hasChildren: note.hasChildren,
  yjsSnapshotAt: note.yjsSnapshotAt,
  contentMd: note.contentMd,
  createdBy: note.createdBy,
  createdAt: note.createdAt,
  updatedAt: note.updatedAt,
  lockedAt: note.lockedAt,
});

export const toPublicAttachment = (attachment: Attachment, notebookId: string) => ({
  id: attachment.shortId,
  notebookId,
  filename: attachment.filename,
  mimeType: attachment.mimeType,
  sizeBytes: attachment.sizeBytes,
  kind: attachment.kind,
  createdBy: attachment.createdBy,
  createdAt: attachment.createdAt,
});

export const toPublicNoteComment = (comment: NoteComment, notebookId: string, noteId: string) => ({
  id: comment.shortId,
  notebookId,
  noteId,
  authorUserId: comment.authorUserId,
  authorDisplayName: comment.authorDisplayName,
  authorAvatarHash: comment.authorAvatarHash,
  content: comment.content,
  createdAt: comment.createdAt,
  updatedAt: comment.updatedAt,
  canEdit: comment.canEdit,
  canDelete: comment.canDelete,
});

export type PublicNoteComment = ReturnType<typeof toPublicNoteComment>;

export const toPublicSnapshotLog = <T extends { metadata: Record<string, unknown> | null }>(
  entry: T,
  notebookId: string,
): Omit<T, "metadata"> & { metadata: Record<string, unknown> | null } => {
  if (!entry.metadata) return entry;
  const { notebookId: _internalNotebookId, notebookShortId: _shortId, ...metadata } = entry.metadata;
  return { ...entry, metadata: { ...metadata, notebookId } };
};
