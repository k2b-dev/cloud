import { registerContextAwareCommand } from "@k2b/cloud/browser/commands";
import { registerSearchNavigation } from "@k2b/cloud/browser/search";
import { useLocale } from "@k2b/ui";
import { createEffect, onCleanup, onMount } from "solid-js";
import { inheritPresentationMode } from "../../../lib/presentation-url";
import { createNoteCommands } from "../../note-commands";
import { notebookWorkspaceMessages } from "../messages";
import { notebookSearchOptions } from "./search/openNoteSearchPrompt";

type Props = {
  notebookId: string;
  notebookName: string;
  canWrite: boolean;
  ownsSearchNavigation: boolean;
};

/** One command owner for the current notebook, shared by both sidebar layouts. */
export default function NotebookCommands(props: Props) {
  const locale = useLocale();
  const t = () => notebookWorkspaceMessages.resolve([locale()]).t;
  createNoteCommands(() => (props.canWrite ? props.notebookId : undefined));

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
  });

  createEffect(() => {
    onCleanup(
      registerContextAwareCommand({
        id: "notebooks.search",
        title: t().searchNotesCommand,
        description: t().searchNotesCommandDescription({ name: props.notebookName }),
        icon: "ti ti-search",
        shortcut: "mod+shift+k",
        action: { search: notebookSearchOptions(props.notebookId, props.notebookName) },
      }),
    );
    if (props.canWrite)
      onCleanup(
        registerContextAwareCommand({
          id: "notebooks.note.compose",
          title: t().newNoteCommand,
          description: t().newNoteCommandDescription({ name: props.notebookName }),
          icon: "ti ti-note",
          shortcut: "mod+alt+n",
          action: { command: "notebooks.note.compose", input: { notebookId: props.notebookId } },
        }),
      );
  });

  return null;
}
