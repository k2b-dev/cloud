import { navigateTo } from "@k2b/ssr/nav";
import { query } from "@k2b/stdlib/solid";
import { Button, IconButton, Placeholder, prompts, useLocale } from "@k2b/ui";
import type { ResourceApiKey } from "@valentinkolb/cloud/access/ui";
import type { AccessEntry } from "@valentinkolb/cloud/contracts";
import { Show } from "solid-js";
import { apiClient } from "@/api/client";
import type { ContactBook, ContactTag } from "../../service";
import { readErrorMessage } from "./api";
import { bookMessages } from "./book-messages";
import BookSettingsForm from "./BookSettingsForm";

const settingsDialogFrameClass = "dialog-fixed-frame flex min-h-0 flex-col overflow-hidden";

export type BookSettingsContext = {
  book: ContactBook;
  accessEntries: AccessEntry[];
  apiKeys: ResourceApiKey[];
  tags: ContactTag[];
};

type BookSettingsDialogOutcome = { deleted?: boolean };

export type BookSettingsDialogResult = {
  deleted: boolean;
  workspaceChanged: boolean;
};

function BookSettingsDialog(props: {
  bookId: string;
  initialTab?: string;
  close: (outcome?: BookSettingsDialogOutcome) => void;
  onWorkspaceChange: () => void;
}) {
  const locale = useLocale();
  const t = () => bookMessages.resolve([locale()]).t;
  const settings = query.create<string, BookSettingsContext>({
    source: () => props.bookId,
    load: async (bookId, context) => {
      const response = await apiClient.books[":bookId"]["settings-context"].$get(
        { param: { bookId } },
        { init: { signal: context.abortSignal } },
      );
      if (!response.ok) throw new Error(await readErrorMessage(response, t().loadSettingsFailed));
      return response.json();
    },
  });

  return (
    <Show
      when={settings.data()}
      fallback={
        <div class={`paper relative ${settingsDialogFrameClass} rounded-[var(--ui-radius-frame)] [box-shadow:var(--ui-shadow-float)]`}>
          <IconButton type="button" class="absolute right-4 top-4 z-10" label={t().closeSettings} onClick={() => props.close()}>
            <i class="ti ti-x" aria-hidden="true" />
          </IconButton>
          <Show
            when={settings.error()}
            fallback={<Placeholder state="loading" variant="panel" title={t().loadingSettings} class="flex-1 justify-center" />}
          >
            {(error) => (
              <Placeholder
                state="error"
                variant="panel"
                title={t().loadSettingsErrorTitle}
                description={error().message}
                class="flex-1"
                action={
                  <Button variant="secondary" size="sm" type="button" disabled={settings.loading()} onClick={() => void settings.refresh()}>
                    <i class={settings.loading() ? "ti ti-loader-2 animate-spin" : "ti ti-refresh"} aria-hidden="true" />
                    {t().retry}
                  </Button>
                }
              />
            )}
          </Show>
        </div>
      }
    >
      {(context) => (
        <div class={settingsDialogFrameClass}>
          <BookSettingsForm
            context={context}
            initialTab={props.initialTab}
            onWorkspaceChange={props.onWorkspaceChange}
            onReconcile={() => settings.invalidate()}
            onClose={() => props.close()}
            onDeleted={() => props.close({ deleted: true })}
          />
        </div>
      )}
    </Show>
  );
}

export const openBookSettingsDialog = async (params: { bookId: string; initialTab?: string }): Promise<BookSettingsDialogResult> => {
  let workspaceChanged = false;
  const outcome = await prompts.dialog<BookSettingsDialogOutcome>(
    (close) => (
      <BookSettingsDialog
        {...params}
        close={close}
        onWorkspaceChange={() => {
          workspaceChanged = true;
        }}
      />
    ),
    { surface: "bare", header: false, size: "large", cancelBehavior: "ignore" },
  );
  const deleted = outcome?.deleted === true;
  if (deleted) navigateTo("/app/contacts");
  return { deleted, workspaceChanged };
};
