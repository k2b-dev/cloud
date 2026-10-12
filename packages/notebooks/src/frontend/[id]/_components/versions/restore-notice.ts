import { toast } from "@k2b/ui";
import { apiClient } from "@/api/client";
import { readErrorMessage } from "../settings/utils";

const RESTORED_VERSION_KEY = "notebooks.restoredVersion";

type Messages = {
  versionRestored: string;
  undo: string;
  restoreUndone: string;
  restoreFailed: string;
};

/** Restores a version of the note as its current content, for everyone who has it open. */
export const restoreVersionInPlace = async (params: {
  notebookId: string;
  noteId: string;
  versionId: string;
  failed: string;
}): Promise<{ previousVersionId: string | null }> => {
  const response = await apiClient[":id"].notes[":noteId"].versions[":versionId"].restore.$post({
    param: { id: params.notebookId, noteId: params.noteId, versionId: params.versionId },
  });
  if (!response.ok) throw new Error(await readErrorMessage(response, params.failed));
  const { previousVersionId } = await response.json();
  return { previousVersionId };
};

/** The note opens as a new page after a restore, so its confirmation waits in the session until that page shows it. */
export const rememberRestoredVersion = (noteId: string, undoVersionId: string | null): void => {
  sessionStorage.setItem(RESTORED_VERSION_KEY, `${noteId} ${undoVersionId ?? ""}`);
};

/** Confirms a restore of this note once, with Undo back to the content it replaced. */
export const showRestoredVersionNotice = (params: { notebookId: string; noteId: string; t: Messages }): void => {
  const stored = sessionStorage.getItem(RESTORED_VERSION_KEY);
  if (!stored) return;
  sessionStorage.removeItem(RESTORED_VERSION_KEY);
  const [noteId, undoVersionId] = stored.split(" ");
  if (noteId !== params.noteId) return;
  const { t } = params;
  const undo = async (versionId: string) => {
    try {
      await restoreVersionInPlace({ notebookId: params.notebookId, noteId: params.noteId, versionId, failed: t.restoreFailed });
      toast.success(t.restoreUndone);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t.restoreFailed);
    }
  };
  toast.success(t.versionRestored, { action: undoVersionId ? { label: t.undo, onClick: () => void undo(undoVersionId) } : null });
};
