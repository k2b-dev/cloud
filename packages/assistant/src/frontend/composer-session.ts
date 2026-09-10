/** The server revision belongs to the local content, not the latest conversation fetch. */
export type ComposerSession = {
  baseRevision: number;
  editGeneration: number;
  dirty: boolean;
  saving: boolean;
  conflict: boolean;
};
export const newComposerSession = (baseRevision = 0): ComposerSession => ({
  baseRevision,
  editGeneration: 0,
  dirty: false,
  saving: false,
  conflict: false,
});
export const editComposerSession = (session: ComposerSession): void => {
  session.editGeneration++;
  session.dirty = true;
};
export const observeComposerRevision = (session: ComposerSession, revision: number): "keep" | "hydrate" | "conflict" => {
  if (revision <= session.baseRevision || session.saving) return "keep";
  if (session.dirty) {
    session.conflict = true;
    return "conflict";
  }
  session.baseRevision = revision;
  return "hydrate";
};
/** Later local edits build on this own save, but never on an unseen remote save. */
export const confirmComposerSave = (session: ComposerSession, revision: number, generation: number): void => {
  session.baseRevision = revision;
  session.dirty = session.editGeneration !== generation;
};
