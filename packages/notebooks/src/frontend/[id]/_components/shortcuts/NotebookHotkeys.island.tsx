import { hotkeys, mutation as mutations } from "@k2b/stdlib/solid";
import { prompts, SPOTLIGHT_SHORTCUT, useLocale } from "@k2b/ui";
import { onCleanup, onMount } from "solid-js";
import { apiClient } from "@/api/client";
import { onNotebookSearchRequest } from "../../../lib/hotkeys";
import { navigateToNotebookNote } from "../../../lib/soft-navigation";
import { buildNoteUrl } from "../../../params";
import { openNoteSearchPrompt } from "../search/openNoteSearchPrompt";
import { notebookWorkspaceMessages } from "../../messages";

type Props = {
  notebookId: string;
  notebookName: string;
  canWrite: boolean;
};

type CreateNoteResult = {
  id: string;
};

/** Note-level notebook shortcuts to avoid duplicate registrations from responsive sidebars. */
export default function NotebookHotkeys(props: Props) {
  const locale = useLocale();
  const t = () => notebookWorkspaceMessages.resolve([locale()]).t;
  const createNoteMutation = mutations.create<CreateNoteResult, void>({
    mutation: async () => {
      const res = await apiClient[":id"].notes.$post({
        param: { id: props.notebookId },
        json: {},
      });
      if (!res.ok) throw new Error(t().failedCreateNote);
      return (await res.json()) as CreateNoteResult;
    },
    onSuccess: (data) => {
      void navigateToNotebookNote(buildNoteUrl(props.notebookId, data.id), { selectInitialTitle: data.id });
    },
    onError: (err) => prompts.error(err.message),
  });

  const openSearch = async () => {
    const picked = await openNoteSearchPrompt(props.notebookId, props.notebookName, locale());
    if (picked) {
      void navigateToNotebookNote(buildNoteUrl(props.notebookId, picked.id));
    }
  };

  const createNote = async () => {
    if (!props.canWrite || createNoteMutation.loading()) return;
    await createNoteMutation.mutate();
  };

  onMount(() => {
    const offSearchRequest = onNotebookSearchRequest(() => {
      void openSearch();
    });
    onCleanup(offSearchRequest);
  });

  hotkeys.create(() => ({
    [SPOTLIGHT_SHORTCUT]: {
      label: t().searchNotesCommand,
      desc: t().searchNotesCommandDescription,
      run: openSearch,
    },
    ...(props.canWrite
      ? {
          "mod+alt+n": {
            label: t().newNoteCommand,
            desc: t().newNoteCommandDescription,
            run: createNote,
          },
        }
      : {}),
  }));

  return null;
}
