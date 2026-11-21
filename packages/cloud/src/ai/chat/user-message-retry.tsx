import { mutation } from "@k2b/stdlib/solid";
import { Button, dialogCore, PanelDialog, panelDialogOptions, TextInput } from "@k2b/ui";
import { createSignal, Show } from "solid-js";
import type { AiStoredMessage, AiUserContentPart } from "../types";
import { type AiRetryMessageInput, userContentWithEditedVisibleText, userVisibleTextFromMessage } from "./message-utils";
import { aiChatMessages } from "./messages";

/** "Edit and send again" for a person's message: loaded with the first press, so no chat's first frame carries it. */
export const openModifyRetryDialog = (
  entry: AiStoredMessage,
  onRetryMessage: (entry: AiStoredMessage, input?: AiRetryMessageInput) => void | Promise<void>,
  locale: string,
) => {
  const t = aiChatMessages(locale);
  void dialogCore.open<void>((close) => {
    // The edited words go without the message's quotes, which the server keeps as it checked them.
    const [draft, setDraft] = createSignal(userVisibleTextFromMessage(entry.message, entry.meta?.quotes));
    const content = () => userContentWithEditedVisibleText(entry.message, draft());
    const retryMutation = mutation.create<void, AiUserContentPart[]>({
      mutation: async (nextContent) => onRetryMessage(entry, { content: nextContent }),
      onSuccess: () => close(),
    });
    const canRetry = () => content().length > 0 && !retryMutation.loading();
    const retry = () => {
      const nextContent = content();
      if (nextContent.length === 0 || retryMutation.loading()) return;
      void retryMutation.mutate(nextContent);
    };

    return (
      <PanelDialog>
        <PanelDialog.Header title={t.retryTitle} icon="ti ti-pencil" close={close} />
        <PanelDialog.Body>
          <TextInput
            label={t.retryPrompt}
            description={entry.meta?.quotes?.length ? t.retryPromptHintQuotes : t.retryPromptHint}
            multiline
            lines={8}
            value={draft}
            onValueChange={setDraft}
            onSubmit={retry}
          />
          <Show when={retryMutation.error()}>
            <p class="text-xs text-red-600 dark:text-red-400" role="alert">
              {t.retryFailed}
            </p>
          </Show>
        </PanelDialog.Body>
        <PanelDialog.Footer>
          <div class="ml-auto flex items-center gap-2">
            <Button type="button" variant="secondary" size="sm" onClick={() => close()}>
              {t.cancel}
            </Button>
            <Button type="button" variant="ai" size="sm" disabled={!canRetry()} onClick={retry}>
              <i class={`ti ${retryMutation.loading() ? "ti-loader-2 animate-spin" : "ti-refresh"}`} aria-hidden="true" />
              {retryMutation.loading() ? t.retrying : t.actionTryAgain}
            </Button>
          </div>
        </PanelDialog.Footer>
      </PanelDialog>
    );
  }, panelDialogOptions);
};
