import { mutation as mutations } from "@k2b/stdlib/solid";
import { prompts, toast, useLocale } from "@k2b/ui";
import { apiClient } from "@/api/client";
import { navigateToNotebookNote } from "../../../lib/soft-navigation";
import { buildNoteUrl } from "../../../params";
import { notebookWorkspaceMessages } from "../../messages";
import { listAccessibleNotebooks } from "../sidebar/notebooks";
import type { Notebook } from "../sidebar/types";

/** The same destination prompt, copy request and navigation for the tree and note panel. */
export function useDuplicateNote(notebookId: string) {
  const locale = useLocale();
  const t = () => notebookWorkspaceMessages.resolve([locale()]).t;
  const copyNoteMut = mutations.create<
    { id: string; notebookId: string },
    { noteId: string; targetNotebookId: string; targetParentId?: string | null }
  >({
    mutation: async (data: { noteId: string; targetNotebookId: string; targetParentId?: string | null }) => {
      const res = await apiClient[":id"].notes[":noteId"].copy.$post({
        param: { id: notebookId, noteId: data.noteId },
        json: {
          targetNotebookId: data.targetNotebookId,
          targetParentId: data.targetParentId,
        },
      });
      if (!res.ok) throw new Error(t().failedDuplicateNote);
      return (await res.json()) as { id: string; notebookId: string };
    },
    onSuccess: (data) => {
      void navigateToNotebookNote(buildNoteUrl(data.notebookId, data.id));
    },
    onError: (err) => toast.error(err.message),
  });

  const handleCopy = async (noteId: string) => {
    let allNotebooks: Notebook[] = [];
    try {
      allNotebooks = await listAccessibleNotebooks();
    } catch (error) {
      prompts.error(error instanceof Error ? error.message : t().failedLoadNotebooks);
      return;
    }

    if (allNotebooks.length === 0) {
      await prompts.error(t().noNotebooks);
      return;
    }

    const result = await prompts.form({
      title: t().duplicateNote,
      icon: "ti ti-copy",
      fields: {
        targetNotebookId: {
          type: "select" as const,
          label: t().targetNotebook,
          required: true,
          default: notebookId,
          options: allNotebooks.map((nb) => ({
            id: nb.id,
            label: nb.name,
            icon: `ti ${nb.icon || "ti-notebook"}`,
          })),
        },
      },
    });

    if (result) {
      copyNoteMut.mutate({
        noteId,
        targetNotebookId: result.targetNotebookId,
      });
    }
  };

  return { duplicate: handleCopy, loading: copyNoteMut.loading };
}
