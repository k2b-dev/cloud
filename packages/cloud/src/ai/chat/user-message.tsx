import { mutation } from "@k2b/stdlib/solid";
import {
  Button,
  type ChatAction,
  type ChatAttachment,
  dialogCore,
  MessageQuote,
  PanelDialog,
  panelDialogOptions,
  TextInput,
  useLocale,
} from "@k2b/ui";
import { createSignal, For, type JSX, Show } from "solid-js";
import type { AiTurnBlock } from "../protocol";
import type { AiQuoteSource } from "../quote-markers";
import type { AiStoredMessage, AiUserContentPart } from "../types";
import type { AiChatActions } from "./message-actions";
import {
  type AiRetryMessageInput,
  copyTextFromMessage,
  resourcesFromMessage,
  textAttachmentSummariesFromMessage,
  userContentWithEditedVisibleText,
  userVisibleTextFromMessage,
  vfsAttachmentsFromMessage,
} from "./message-utils";
import { aiChatMessages } from "./messages";

const openModifyRetryDialog = (
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

export const aiUserMessageText = (entry: AiStoredMessage): string => userVisibleTextFromMessage(entry.message, entry.meta?.quotes);

/**
 * The passages a user message quotes, above its text: each as the marked passage the composer showed, with whose words
 * it are. Nothing when the message quotes nothing.
 */
export function AiUserMessageQuotes(props: { entry: AiStoredMessage }): JSX.Element {
  const locale = useLocale();
  const t = () => aiChatMessages(locale());
  const author = (from: AiQuoteSource) =>
    from === "assistant" ? "Gustav" : from === "user" ? t().quotedFromYou : t().quotedFromAutomation;
  // The checked quotes of the message are the only source; its text never names one.
  const quotes = () => props.entry.meta?.quotes ?? [];
  return (
    <Show when={quotes().length}>
      <div class="k2b-message-quotes">
        <For each={quotes()}>{(quote) => <MessageQuote quote={{ author: author(quote.from), text: quote.text }} />}</For>
      </div>
    </Show>
  );
}

/**
 * Who wrote a message the person did not type: an automation or another chat. The server sets the origin from the
 * writer and links it only for a viewer who may open the source. The person's own messages carry none.
 */
export const aiUserMessageSource = (entry: AiStoredMessage, locale: string): JSX.Element | undefined => {
  const origin = entry.meta?.origin;
  if (!origin || origin.kind === "person") return undefined;
  const t = aiChatMessages(locale);
  const label = origin.kind === "automation" ? t.messageFromAutomation({ name: origin.name }) : t.messageFromChat({ name: origin.name });
  const content = (
    <>
      <i
        class={`ai-message-source__icon ${origin.kind === "automation" ? "ti ti-feat-code" : "ti ti-sparkles"}`}
        data-kind={origin.kind}
        aria-hidden="true"
      />
      <span>{label}</span>
    </>
  );
  return origin.href ? (
    <a href={origin.href} title={origin.kind === "automation" ? t.openAutomation : t.openChat}>
      {content}
    </a>
  ) : (
    content
  );
};

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
  // The person's own words, as a whole; a message an automation wrote is no passage of theirs.
  const ownText = entry.meta?.codeOrigin ? "" : userVisibleTextFromMessage(entry.message, entry.meta?.quotes);
  if (actions.onQuote && ownText) {
    result.push({
      id: "quote",
      label: t.actionQuote,
      icon: "ti ti-quote",
      overflow: true,
      onSelect: () => actions.onQuote!({ messageId: entry.shortId, from: "user", text: ownText }),
    });
  }
  // Answering again and its variants sit under the answer; here the message can be edited and sent again.
  if (!entry.compactedAt && actions.onRetryMessage) {
    result.push({
      id: "edit",
      label: t.actionEditPrompt,
      icon: "ti ti-pencil",
      onSelect: () => openModifyRetryDialog(entry, actions.onRetryMessage!, locale),
    });
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
