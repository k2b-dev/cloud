import { registerSearchNavigation } from "@k2b/cloud/browser/search";
import { hotkeys, mutation as mutations } from "@k2b/stdlib/solid";
import { prompts, SPOTLIGHT_SHORTCUT, useLocale } from "@k2b/ui";
import { onCleanup, onMount } from "solid-js";
import { apiClient } from "@/api/client";
import { inheritPresentationMode } from "../../../../lib/presentation-url";
import { onNotebookSearchRequest } from "../../../lib/hotkeys";
import { navigateToNotebookNote } from "../../../lib/soft-navigation";
import { buildNoteUrl } from "../../../params";
import { notebookWorkspaceMessages } from "../../messages";
import { openNoteSearchPrompt } from "../search/openNoteSearchPrompt";

type Props = {
  notebookId: string;
  notebookName: string;
  canWrite: boolean;
  ownsSearchNavigation: boolean;
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

  const openSearch = () => openNoteSearchPrompt(props.notebookId, props.notebookName);

  const createNote = async () => {
    if (!props.canWrite || createNoteMutation.loading()) return;
    await createNoteMutation.mutate();
  };

  onMount(() => {
    if (props.ownsSearchNavigation)
      onCleanup(
        registerSearchNavigation(({ href }) => {
          const target = inheritPresentationMode(href, window.location.href);
          if (target === href) return false;
          window.location.assign(target);
          return true;
        }),
      );
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
