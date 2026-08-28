import { prompts, useLocale } from "@k2b/ui";
import { createEffect, createSignal } from "solid-js";
import { apiClient } from "@/api/client";
import type { NoteTreeNode } from "./types";
import { notebookWorkspaceMessages } from "../../messages";

export function useFavoriteNotes(params: { notebookId: string; initialFavoriteNoteIds: () => string[] }) {
  const locale = useLocale();
  const t = () => notebookWorkspaceMessages.resolve([locale()]).t;
  const [favoriteNoteIds, setFavoriteNoteIds] = createSignal(new Set(params.initialFavoriteNoteIds()));
  const pendingNoteIds = new Set<string>();

  createEffect(() => setFavoriteNoteIds(new Set(params.initialFavoriteNoteIds())));

  const toggleFavorite = async (note: NoteTreeNode, event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (pendingNoteIds.has(note.id)) return;
    pendingNoteIds.add(note.id);
    const next = !favoriteNoteIds().has(note.id);
    setFavoriteNoteIds((current) => {
      const copy = new Set(current);
      if (next) copy.add(note.id);
      else copy.delete(note.id);
      return copy;
    });

    try {
      const response = await apiClient[":id"].notes[":noteId"].favorite.$put({
        param: { id: params.notebookId, noteId: note.id },
        json: { favorite: next },
      });
      if (response.ok) return;
      throw new Error("Favorite request failed");
    } catch {
      setFavoriteNoteIds((current) => {
        const copy = new Set(current);
        if (next) copy.delete(note.id);
        else copy.add(note.id);
        return copy;
      });
      void prompts.error(t().favoriteUpdateFailed);
    } finally {
      pendingNoteIds.delete(note.id);
    }
  };

  return { favoriteNoteIds, toggleFavorite };
}
