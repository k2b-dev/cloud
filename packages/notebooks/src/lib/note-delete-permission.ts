/**
 * The notebook permission a person or agent needs to delete or permanently lock notes; `write` keeps the default.
 * Both actions cannot be undone, so one rule covers them.
 */
export const NOTE_DELETE_PERMISSIONS = ["write", "admin"] as const;

export type NoteDeletePermission = (typeof NOTE_DELETE_PERMISSIONS)[number];

/** Stable API error code when a notebook reserves deleting notes for its admins. */
export const NOTE_DELETE_ADMIN_ONLY = "NOTE_DELETE_ADMIN_ONLY";

/** Stable API error code when a notebook reserves locking notes for its admins. */
export const NOTE_LOCK_ADMIN_ONLY = "NOTE_LOCK_ADMIN_ONLY";

export const isNoteDeletePermission = (value: unknown): value is NoteDeletePermission => value === "write" || value === "admin";

/** Whether an effective notebook permission may delete or lock notes under the notebook's rule. */
export const mayDeleteOrLockNotes = (permission: string, required: NoteDeletePermission): boolean =>
  permission === "admin" || (required === "write" && permission === "write");
