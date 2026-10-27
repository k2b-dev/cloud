/** Stable semantic actions shared by the server and browser. */
export const NOTEBOOK_ACTIVITY_ACTIONS = [
  "notebook.created",
  "note.created",
  "note.edited",
  "note.restored",
  "annotation.create",
  "comment.created",
  "comment.updated",
  "comment.deleted",
] as const;
export type NotebookActivityAction = (typeof NOTEBOOK_ACTIVITY_ACTIONS)[number];
export const isNotebookActivityAction = (value: string): value is NotebookActivityAction =>
  NOTEBOOK_ACTIVITY_ACTIONS.some((action) => action === value);

export type NotebookActivityActor = {
  kind: "user" | "service_account" | "system";
  id: string | null;
  displayName: string;
  avatarHash: string | null;
};
export type NoteAuthors = {
  createdBy: NotebookActivityActor | null;
  lastEditedBy: NotebookActivityActor | null;
};
