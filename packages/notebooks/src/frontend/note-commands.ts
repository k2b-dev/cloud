import { consumeCommandLink, registerCommandHandler } from "@k2b/cloud/browser/commands";
import { invokeCapabilityWithDataSchema } from "@k2b/cloud/capabilities";
import { prompts, useLocale } from "@k2b/ui";
import { onCleanup, onMount } from "solid-js";
import { apiClient } from "../api/client";
import { NotebookBrowseDataSchema } from "../capability-contracts";
import { NoteComposeInputSchema, notebookCommandMessages } from "../commands";
import { navigateToNotebookNote } from "./lib/soft-navigation";
import { buildNoteUrl } from "./params";

export const createNoteCommands = (currentNotebookId?: () => string | undefined) => {
  const locale = useLocale();
  const t = () => notebookCommandMessages.resolve([locale()]).t;
  let active = true;
  let pending = false;
  const abort = new AbortController();
  onCleanup(() => {
    active = false;
    abort.abort();
  });
  onMount(() => {
    onCleanup(
      registerCommandHandler(
        "notebooks.note.compose",
        NoteComposeInputSchema,
        async (input) => {
          if (pending) return;
          pending = true;
          try {
            let notebookId = input.notebookId ?? currentNotebookId?.();
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
                  return result.data.data.map((book) => ({ value: book.ref.id, label: book.title, icon: "ti ti-notebook" }));
                },
                { title: t().choose, placeholder: t().search, noResultsText: t().empty, minQueryLength: 0, size: "small" },
              );
              if (!choice?.value || !active) return;
              notebookId = choice.value;
            }
            if (!active) return;
            const response = await apiClient[":id"].notes.$post(
              { param: { id: notebookId }, json: {} },
              { init: { signal: abort.signal } },
            );
            if (!response.ok) throw new Error(t().failed);
            const note = await response.json();
            if (active) await navigateToNotebookNote(buildNoteUrl(notebookId, note.id), { selectInitialTitle: note.id });
          } finally {
            pending = false;
          }
        },
        (input) => !currentNotebookId?.() || !input.notebookId || input.notebookId === currentNotebookId(),
      ),
    );
    void consumeCommandLink();
  });
};
