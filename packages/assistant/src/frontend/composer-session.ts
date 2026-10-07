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
/**
 * Sends a message that is not the composer's, such as Continue after a failed turn. Sending goes through the saved
 * draft and replaces it, so what the person was writing is saved back afterwards, also when sending failed after the
 * draft was replaced. A failed send marks the composer as in conflict; that conflict came from this send, so the save
 * back runs, and a draft that another session changed still makes it report the conflict. A composer that is already
 * in conflict sends nothing.
 */
export const sendBesideComposer = async (
  session: ComposerSession,
  input: { send: () => Promise<boolean>; hasContent: () => boolean; save: () => Promise<unknown> },
): Promise<boolean> => {
  if (session.conflict) return false;
  const sent = await input.send();
  if (!sent) session.conflict = false;
  // A successful send left an empty draft, which matches an empty composer.
  if (!sent || input.hasContent()) await input.save();
  return sent;
};
