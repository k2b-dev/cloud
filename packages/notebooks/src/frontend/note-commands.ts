import { consumeCommandLink, registerCommandHandler } from "@k2b/cloud/browser/commands";
import { invokeCapabilityWithDataSchema } from "@k2b/cloud/capabilities";
import { prompts, useLocale } from "@k2b/ui";
import { onCleanup, onMount } from "solid-js";
import { apiClient } from "../api/client";
import { NotebookBrowseDataSchema } from "../capability-contracts";
import { NoteComposeInputSchema, notebookCommandMessages } from "../commands";
import { navigateToNotebookNote } from "./lib/soft-navigation";
import { buildNoteUrl } from "./params";

/**
 * Owns "New note" on a Notebooks page. `currentNotebookId` is the shown notebook while the person may write there.
 * Without a named notebook the note goes there, unless the page reads (`ask`) or the request is a link from another
 * app: those ask which notebook, as Notebooks always did, with the shown notebook (the one used last) first, so one
 * confirm takes it.
 */
export const createNoteCommands = (currentNotebookId?: () => string | undefined, options: { ask?: boolean } = {}) => {
  const locale = useLocale();
  const t = () => notebookCommandMessages.resolve([locale()]).t;
  let active = true;
  let pending = false;
  // true while this page takes over a command link, which comes from elsewhere
  let fromLink = false;
  const abort = new AbortController();
  onCleanup(() => {
    active = false;
    abort.abort();
  });
  onMount(() => {
    onCleanup(
      registerCommandHandler("notebooks.note.compose", NoteComposeInputSchema, async (input) => {
        if (pending) return;
        pending = true;
        try {
          const shown = currentNotebookId?.();
          let notebookId = input.notebookId ?? (options.ask || fromLink ? undefined : shown);
          if (!notebookId) {
            const choice = await prompts.search<string>(
              async ({ query, abortSignal }) => {
                const result = await invokeCapabilityWithDataSchema(
                  {
                    appId: "notebooks",
                    capabilityId: "notebook.browse",
                    kind: "query",
                    input: { query, minimumPermission: "write", limit: 100 },
                    signal: abortSignal,
                  },
                  NotebookBrowseDataSchema,
                );
                if (!result.ok) throw new Error(result.error.message);
                const books = result.data.data.map((book) => ({
                  id: book.ref.id,
                  value: book.ref.id,
                  label: book.title,
                  icon: "ti ti-notebook",
                  desc: book.ref.id === shown ? t().lastUsed : undefined,
                }));
                // the first result is the one Enter takes
                return query ? books : [...books.filter((book) => book.value === shown), ...books.filter((book) => book.value !== shown)];
              },
              { title: t().choose, placeholder: t().search, noResultsText: t().empty, minQueryLength: 0, size: "small" },
            );
            if (!choice?.value || !active) return;
            notebookId = choice.value;
          }
          if (!active) return;
          const response = await apiClient[":id"].notes.$post({ param: { id: notebookId }, json: {} }, { init: { signal: abort.signal } });
          if (!response.ok) throw new Error(t().failed);
          const note = await response.json();
          if (active) await navigateToNotebookNote(buildNoteUrl(notebookId, note.id), { selectInitialTitle: note.id });
        } finally {
          pending = false;
        }
      }),
    );
    fromLink = true;
    void consumeCommandLink().finally(() => {
      fromLink = false;
    });
  });
};
