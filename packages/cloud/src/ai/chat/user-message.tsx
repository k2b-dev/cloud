import { mutation } from "@k2b/stdlib/solid";
import { Button, type ChatAction, type ChatAttachment, dialogCore, PanelDialog, panelDialogOptions, TextInput } from "@k2b/ui";
import { createSignal, Show } from "solid-js";
import type { AiTurnBlock } from "../protocol";
import type { AiStoredMessage, AiUserContentPart } from "../types";
import type { AiChatActions } from "./message-actions";
import { aiChatMessages } from "./messages";
import {
  type AiRetryMessageInput,
  copyTextFromMessage,
  resourcesFromMessage,
  textAttachmentSummariesFromMessage,
  userContentWithEditedVisibleText,
  userVisibleTextFromMessage,
  vfsAttachmentsFromMessage,
} from "./message-utils";

const openModifyRetryDialog = (
  entry: AiStoredMessage,
  onRetryMessage: (entry: AiStoredMessage, input?: AiRetryMessageInput) => void | Promise<void>,
  locale: string,
) => {
  const t = aiChatMessages(locale);
  void dialogCore.open<void>((close) => {
    const [draft, setDraft] = createSignal(userVisibleTextFromMessage(entry.message));
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
            description={t.retryPromptHint}
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

export const aiUserMessageText = (entry: AiStoredMessage): string => userVisibleTextFromMessage(entry.message);

export const aiUserMessageAttachments = (entry: AiStoredMessage, actions: AiChatActions = {}): ChatAttachment[] => [
  ...textAttachmentSummariesFromMessage(entry.message).map((attachment, index) => ({
    id: `${entry.id}-text-${index}`,
    name: attachment.name,
    kind: "file" as const,
    icon: `ti ${attachment.icon}`,
  })),
  ...vfsAttachmentsFromMessage(entry.message).map((attachment, index) => ({
    id: `${entry.id}-vfs-${index}`,
    name: attachment.name,
    size: attachment.size,
    kind: attachment.mediaType.startsWith("image/") ? ("image" as const) : ("file" as const),
    previewUrl: attachment.mediaType.startsWith("image/") ? (actions.fileUrl?.(attachment.path) ?? undefined) : undefined,
    icon: attachment.mediaType.startsWith("image/") ? "ti ti-photo" : `ti ${attachment.icon}`,
  })),
  ...resourcesFromMessage(entry.message).map((resource, index) => ({
    id: `${entry.id}-resource-${index}`,
    name: resource.title ?? resource.ref.id,
    kind: "resource" as const,
    icon: resource.icon ?? "ti ti-cloud",
    href: resource.href,
  })),
];

export const createAiUserMessageActions = (entry: AiStoredMessage, actions: AiChatActions, locale: string): ChatAction[] => {
  const t = aiChatMessages(locale);
  const result: ChatAction[] = [];
  const copyText = copyTextFromMessage(entry.message);

  if (copyText) {
    result.push({ id: "copy", label: t.actionCopy, icon: "ti ti-copy", copyText });
  }
  if (!entry.compactedAt && actions.onRetryMessage) {
    result.push(
      {
        id: "retry",
        label: t.actionTryAgain,
        icon: "ti ti-refresh",
        onSelect: () => actions.onRetryMessage?.(entry, { mode: "retry" }),
      },
      {
        id: "details",
        label: t.actionMoreDetailed,
        icon: "ti ti-list-details",
        onSelect: () => actions.onRetryMessage?.(entry, { mode: "details" }),
      },
      {
        id: "concise",
        label: t.actionMoreConcise,
        icon: "ti ti-align-left",
        onSelect: () => actions.onRetryMessage?.(entry, { mode: "concise" }),
      },
      {
        id: "edit",
        label: t.actionEditPrompt,
        icon: "ti ti-pencil",
        onSelect: () => openModifyRetryDialog(entry, actions.onRetryMessage!, locale),
      },
    );
  }
  return result;
};

export const aiSteerMessageText = (block: Extract<AiTurnBlock, { kind: "steer_message" }>): string => block.text;

export const createAiSteerMessageActions = (
  block: Extract<AiTurnBlock, { kind: "steer_message" }>,
  actions: AiChatActions,
  locale: string,
): ChatAction[] => {
  if (block.status !== "failed" || !actions.onRetrySteer) return [];
  return [
    {
      id: "retry-steer",
      label: aiChatMessages(locale).actionRetryGuidance,
      icon: "ti ti-refresh",
      onSelect: () => actions.onRetrySteer?.(block),
    },
  ];
};
