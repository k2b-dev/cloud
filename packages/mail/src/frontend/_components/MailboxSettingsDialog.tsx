import { query } from "@k2b/stdlib/solid";
import { Button, IconButton, Placeholder, prompts, useLocale } from "@k2b/ui";
import { createEffect, createMemo, createSignal, Show } from "solid-js";
import { apiClient } from "../../api/client";
import type { MailboxSettingsContext } from "../../settings-context";
import { readApiError } from "./api-response";
import MailboxSettings from "./MailboxSettings";
import { mailSettingsMessages } from "./mail-settings-messages";

const settingsDialogFrameClass = "dialog-fixed-frame flex min-h-0 flex-col overflow-hidden";

type MailboxSettingsDialogOutcome = { deleted?: boolean };

type MailboxSettingsDialogResult = {
  deleted: boolean;
  workspaceChanged: boolean;
};

type MailboxSettingsDialogProps = {
  mailboxId: string;
  currentUserEmail: string | null;
  initialTab?: string;
  close: (outcome?: MailboxSettingsDialogOutcome) => void;
  onWorkspaceChange: () => void;
};

function MailboxSettingsDialog(props: MailboxSettingsDialogProps) {
  const locale = useLocale();
  const messages = createMemo(() => mailSettingsMessages.resolve([locale()]).t);
  const [context, setContext] = createSignal<MailboxSettingsContext | null>(null);
  const settings = query.create<string, MailboxSettingsContext>({
    source: () => props.mailboxId,
    load: async (mailboxId, { abortSignal }) => {
      const response = await apiClient.mailboxes[":mailboxId"]["settings-context"].$get(
        { param: { mailboxId } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readApiError(response, messages().failedLoadMailboxSettings));
      const loaded = await response.json();
      if (!loaded) throw new Error(messages().missingMailboxSettings);
      return loaded;
    },
  });

  createEffect(() => {
    const current = settings.data();
    if (current) setContext(current);
  });
  const currentContext = () => context() ?? settings.data();

  return (
    <Show
      when={currentContext()}
      fallback={
        <div class={`paper relative ${settingsDialogFrameClass} rounded-[var(--ui-radius-frame)] [box-shadow:var(--ui-shadow-float)]`}>
          <IconButton type="button" class="absolute right-4 top-4 z-10" label={messages().closeSettings} onClick={() => props.close()}>
            <i class="ti ti-x" aria-hidden="true" />
          </IconButton>
          <Show
            when={!settings.loading()}
            fallback={
              <Placeholder state="loading" variant="panel" title={messages().loadingMailboxSettings} class="flex-1 justify-center" />
            }
          >
            <Placeholder
              state="error"
              variant="panel"
              title={messages().couldNotLoadMailboxSettings}
              description={settings.error()?.message ?? messages().missingMailboxSettings}
              class="flex-1"
              action={
                <Button variant="secondary" size="sm" type="button" onClick={() => void settings.refresh()}>
                  <i class="ti ti-refresh" aria-hidden="true" />
                  {messages().retry}
                </Button>
              }
            />
          </Show>
        </div>
      }
    >
      {(current) => (
        <div class={settingsDialogFrameClass}>
          <Show when={settings.error()}>
            {(error) => (
              <div class="px-4 pt-3">
                <p class="text-xs text-danger">
                  {error().message}{" "}
                  <button type="button" class="underline" onClick={() => void settings.refresh()}>
                    {messages().retry}
                  </button>
                </p>
              </div>
            )}
          </Show>
          <MailboxSettings
            context={current()}
            initialTab={props.initialTab}
            currentUserEmail={props.currentUserEmail}
            reloading={settings.refreshing() || Boolean(settings.error())}
            onReload={settings.refresh}
            onContextChange={(update) => setContext(update(current()))}
            onWorkspaceChange={props.onWorkspaceChange}
            onClose={() => props.close()}
            onDeleted={() => props.close({ deleted: true })}
          />
        </div>
      )}
    </Show>
  );
}

export const openMailboxSettingsDialog = async (params: {
  mailboxId: string;
  currentUserEmail: string | null;
  initialTab?: string;
}): Promise<MailboxSettingsDialogResult> => {
  let workspaceChanged = false;
  const outcome = await prompts.dialog<MailboxSettingsDialogOutcome>(
    (close) => (
      <MailboxSettingsDialog
        {...params}
        close={close}
        onWorkspaceChange={() => {
          workspaceChanged = true;
        }}
      />
    ),
    { surface: "bare", header: false, size: "large", cancelBehavior: "ignore" },
  );
  return { deleted: outcome?.deleted === true, workspaceChanged };
};
