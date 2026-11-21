import {
  Button,
  type ChatAction,
  CheckboxCard,
  dialogCore,
  PanelDialog,
  panelDialogFixedOptions,
  prompts,
  TextInput,
  useLocale,
} from "@k2b/ui";
import { createContext, createSignal, For, type JSX, Show, useContext } from "solid-js";
import { importOnDemand } from "../../browser/reload";
import type { ApprovalDraftResult } from "../../contracts/approvals";
import type { CloudResourceRef } from "../../contracts/capabilities";
import { markdown } from "../../shared";
import type { AiActionCheck } from "../action-review";
import type { AiTurnBlock } from "../protocol";
import { type AiQuoteDraft, aiQuoteVisibleTextOfHtml } from "../quote-markers";
import type { AiCodeAuthoringStop, AiMessageFeedback, AiMessageFeedbackReason, AiStoredMessage, AiTurnError } from "../types";
import type { AiForkMessageInput, AiRetryMessageInput } from "./message-utils";
import { aiChatMessages } from "./messages";
import type { AiSubmittedCodeVersion } from "./turn-layout";
import type { AiWakeupLineInput } from "./wakeup-plan";

/** The active-turn coordinates an approval/tool action needs to resolve on the server. */
export type AiTurnActionRequest = { turnId: string; callId: string; name: string };

type ApprovalHandler = (
  request: AiTurnActionRequest,
  input: { approved: boolean; remember?: "chat" | "always"; digest?: string },
) => void | Promise<void>;
/** Sends a draft's edited fields; Cloud reviews the Action again and answers with the review the person now approves. */
type EditDraftHandler = (
  request: { turnId: string; callId: string; requestId: string },
  values: Record<string, string>,
  digest: string,
) => Promise<ApprovalDraftResult>;
type FrontendToolResultHandler = (request: AiTurnActionRequest, result: unknown) => void | Promise<void>;
type ForkMessageHandler = (entry: AiStoredMessage, input?: AiForkMessageInput) => void | Promise<void>;
type RetryMessageHandler = (entry: AiStoredMessage, input?: AiRetryMessageInput) => void | Promise<void>;
type RetrySteerHandler = (block: Extract<AiTurnBlock, { kind: "steer_message" }>) => void | Promise<void>;

export type AiChatActions = {
  /** The host draws the chat's alarm lines with their actions; without it, a line names its fact quietly. */
  renderWakeupLine?: (line: AiWakeupLineInput, key: string) => JSX.Element;
  /** The host supplies a remedy for its own turn failures, using the current viewer's permissions. */
  renderTurnErrorAction?: (error: AiTurnError) => JSX.Element;
  /** The host supplies the authorized card jump for a durable decision fact. */
  renderCodeDecision?: (entry: AiStoredMessage) => JSX.Element;
  /** Host-localized authoring budget notice. Superseded receipts can release their action space; consent uses onContinueTurn. */
  renderCodeAuthoringStop?: (state: AiCodeAuthoringStop, continuable: () => boolean, superseded: () => boolean) => JSX.Element;
  /**
   * Host-owned visualizations, persisted independently of the execution session. Called once per `code_present`
   * call, from its first event: `result()` is undefined while the call runs and the saved result afterwards, so
   * the host reserves the frame early and keeps its state when the turn ends.
   */
  renderCodePresentation?: (result: () => unknown) => JSX.Element;
  /**
   * Host-owned view of a version `code_submit` saved, placed after the turn's text because it is what the person acts
   * on next. Without it, the call is a step like any other.
   */
  renderCodeVersion?: (version: AiSubmittedCodeVersion) => JSX.Element;
  /** Prevents turn-continuation actions while the current turn is stopping. */
  actionDisabled?: () => boolean;
  onApproval?: ApprovalHandler;
  onEditDraft?: EditDraftHandler;
  /**
   * Sends the person's choice in a capability view: the call's turn and id, the choice block and the chosen option ids.
   * Resolves `false` when Cloud did not take it, such as while a response runs.
   */
  onChoice?: (request: { turnId: string; toolCallId: string }, blockId: string, ids: string[]) => Promise<boolean>;
  /** Revoke the approval that lets this chat read `origin` without asking; the next request asks again. */
  onRevokeWebsite?: (origin: string) => Promise<void>;
  onFrontendToolResult?: FrontendToolResultHandler;
  /**
   * Ask the owning app once more whether a call whose outcome stayed unknown happened, through its `check` Query. Never
   * repeats the call itself. Resolves with the stored check; without it, an unknown outcome offers no new check.
   */
  onCheckAction?: (request: AiTurnActionRequest) => Promise<AiActionCheck>;
  /**
   * Brings the approval or question a step waits for into view and focuses it, the way "Waiting for you" lands on it.
   * `anchor` is the step's block id, the question's `data-chat-anchor`. Without it, a waiting step offers no jump.
   */
  onShowQuestion?: (anchor: string) => void;
  onForkMessage?: ForkMessageHandler;
  onRetryMessage?: RetryMessageHandler;
  onRetrySteer?: RetrySteerHandler;
  /** Quotes a message as a whole: where no text can be selected, on touch screens and from the keyboard. */
  onQuote?: (quote: AiQuoteDraft) => void;
  /**
   * Continue after a failed turn. Send `message`, a visible request in the reader's language to pick up where the
   * turn stopped, through the host's normal send path. Without it, a failed turn shows its reason only.
   */
  onContinueTurn?: (message: string) => void | Promise<void>;
  onMessageFeedback?: (entry: AiStoredMessage, feedback: Omit<AiMessageFeedback, "updatedAt"> | null) => void | Promise<void>;
  /** Open a conversation VFS file in the host application's artifact surface. */
  onOpenFile?: (path: string) => void;
  /**
   * Open a web link of an answer inside the host, such as a reading view beside the chat. Called for a plain click on
   * an http(s) link that is no conversation file; returns whether the host opened it, otherwise the link navigates.
   */
  onOpenWebLink?: (href: string, title: string) => boolean;
  /** Resolve a Markdown link only when it identifies a known conversation file. */
  resolveFileLink?: (href: string) => { path: string; href: string } | null;
  /** Download URL for a conversation VFS file (present blocks, attachment chips). */
  fileUrl?: (path: string) => string | null;
  /**
   * Open a Cloud object a view references. The host resolves it through the owning app's reader with the viewer's
   * access and confirms before it opens; without this action, references show as text.
   */
  onOpenReference?: (title: string, ref: CloudResourceRef) => void;
};

const AiChatActionContext = createContext<AiChatActions>({});

export const useAiChatActions = () => useContext(AiChatActionContext);

export function AiChatActionsProvider(props: { actions?: AiChatActions; children: JSX.Element }) {
  return <AiChatActionContext.Provider value={props.actions ?? {}}>{props.children}</AiChatActionContext.Provider>;
}

const forkTitleFromText = (text: string, fallback: string): string => {
  const firstLine = text
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) return fallback;
  return firstLine.length > 80 ? `${firstLine.slice(0, 77).trim()}...` : firstLine;
};

const openForkMessageDialog = async (
  entry: AiStoredMessage,
  copyText: string,
  onForkMessage: (entry: AiStoredMessage, input?: AiForkMessageInput) => void | Promise<void>,
  locale: string,
) => {
  const t = aiChatMessages(locale);
  const result = await prompts.form({
    title: t.forkTitle,
    icon: "ti ti-git-fork",
    confirmText: t.forkConfirm,
    size: "medium",
    fields: {
      title: {
        type: "text",
        label: t.forkName,
        default: forkTitleFromText(copyText, t.forkDefaultName),
        required: true,
        maxLength: 120,
      },
    },
  });
  const title = result?.title.trim();
  if (title) await onForkMessage(entry, { title });
};

const feedbackReasons = (
  t: ReturnType<typeof aiChatMessages>,
): readonly { id: AiMessageFeedbackReason; label: string; description: string }[] => [
  { id: "incorrect", label: t.feedbackIncorrect, description: t.feedbackIncorrectHint },
  { id: "did_not_follow_request", label: t.feedbackIgnoredRequest, description: t.feedbackIgnoredRequestHint },
  { id: "incomplete", label: t.feedbackIncomplete, description: t.feedbackIncompleteHint },
  { id: "poor_tool_choice", label: t.feedbackWrongApp, description: t.feedbackWrongAppHint },
  { id: "too_slow", label: t.feedbackSlow, description: t.feedbackSlowHint },
  { id: "other", label: t.feedbackOther, description: t.feedbackOtherHint },
];

const openNegativeFeedbackDialog = (t: ReturnType<typeof aiChatMessages>) =>
  prompts.dialog<{ reasons: AiMessageFeedbackReason[]; comment: string | null } | undefined>(
    (close) => {
      const [selected, setSelected] = createSignal<AiMessageFeedbackReason[]>([]);
      const [comment, setComment] = createSignal("");
      const toggle = (reason: AiMessageFeedbackReason, enabled: boolean) =>
        setSelected((current) => (enabled ? [...current, reason] : current.filter((candidate) => candidate !== reason)));
      const valid = () => selected().length > 0 || comment().trim().length > 0;
      return (
        <div class="flex min-h-0 flex-col gap-4">
          <p class="text-sm text-secondary">{t.feedbackIntro}</p>
          <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <For each={feedbackReasons(t)}>
              {(reason) => (
                <CheckboxCard
                  label={reason.label}
                  description={reason.description}
                  value={() => selected().includes(reason.id)}
                  onValueChange={(enabled) => toggle(reason.id, enabled)}
                />
              )}
            </For>
          </div>
          <TextInput
            label={t.feedbackDetails}
            description={t.feedbackDetailsHint}
            multiline
            lines={3}
            maxLength={1_000}
            value={comment}
            onValueChange={setComment}
          />
          <div class="flex justify-end gap-2">
            <Button variant="secondary" size="sm" type="button" onClick={() => close(undefined)}>
              {t.cancel}
            </Button>
            <Button
              size="sm"
              type="button"
              disabled={!valid()}
              onClick={() => close({ reasons: selected(), comment: comment().trim() || null })}
            >
              {t.feedbackSend}
            </Button>
          </div>
        </div>
      );
    },
    { title: t.feedbackTitle, icon: "ti ti-message-report", size: "large" },
  );

/**
 * Quiet icons under an answer, in this order: copy, answer again, helpful, needs improvement, and "More" with the
 * variants of the answer, continuing in a new chat, and its details. Answering again and its variants retry `prompt`,
 * the person's message the answer belongs to.
 */
export function createAssistantMessageActions(props: {
  entry: AiStoredMessage;
  entries: AiStoredMessage[];
  copyText: string;
  actions: AiChatActions;
  prompt?: AiStoredMessage | null;
}): ChatAction[] {
  const locale = useLocale();
  const t = aiChatMessages(locale());
  const actions = props.actions;
  const prompt = props.prompt && !props.prompt.compactedAt && actions.onRetryMessage ? props.prompt : null;
  const retry = (mode: "retry" | "details" | "concise") => () => actions.onRetryMessage?.(prompt!, { mode });
  const result: ChatAction[] = [];
  if (props.copyText) result.push({ id: "copy", label: t.actionCopy, icon: "ti ti-copy", copyText: props.copyText });
  if (prompt) result.push({ id: "retry", label: t.actionAnswerAgain, icon: "ti ti-refresh", onSelect: retry("retry") });
  if (actions.onMessageFeedback)
    result.push(
      {
        id: "feedback-up",
        label: props.entry.feedback?.rating === "up" ? t.actionHelpfulRemove : t.actionHelpful,
        icon: "ti ti-thumb-up",
        pressed: props.entry.feedback?.rating === "up",
        pressedTone: "success",
        onSelect: () =>
          actions.onMessageFeedback!(
            props.entry,
            props.entry.feedback?.rating === "up" ? null : { rating: "up", reasons: [], comment: null },
          ),
      },
      {
        id: "feedback-down",
        label: props.entry.feedback?.rating === "down" ? t.actionImproveRemove : t.actionImprove,
        icon: "ti ti-thumb-down",
        pressed: props.entry.feedback?.rating === "down",
        pressedTone: "danger",
        onSelect: async () => {
          if (props.entry.feedback?.rating === "down") return actions.onMessageFeedback!(props.entry, null);
          const feedback = await openNegativeFeedbackDialog(t);
          if (feedback) await actions.onMessageFeedback!(props.entry, { rating: "down", ...feedback });
        },
      },
    );
  if (prompt)
    result.push(
      { id: "details", label: t.actionMoreDetailed, icon: "ti ti-list-details", overflow: true, onSelect: retry("details") },
      { id: "concise", label: t.actionMoreConcise, icon: "ti ti-align-left", overflow: true, onSelect: retry("concise") },
    );
  if (actions.onQuote && props.copyText)
    result.push({
      id: "quote",
      label: t.actionQuote,
      icon: "ti ti-quote",
      overflow: true,
      // The answer as the reader sees it, not its Markdown source: the same words a selection would quote.
      onSelect: () =>
        actions.onQuote!({
          messageId: props.entry.shortId,
          from: "assistant",
          text: aiQuoteVisibleTextOfHtml(markdown.renderSync(props.copyText, { locale: locale() }))
            .replace(/\s+/gu, " ")
            .trim(),
        }),
    });
  if (actions.onForkMessage)
    result.push({
      id: "fork",
      label: t.actionFork,
      icon: "ti ti-git-fork",
      overflow: true,
      onSelect: () => openForkMessageDialog(props.entry, props.copyText, actions.onForkMessage!, locale()),
    });
  result.push({
    id: "info",
    label: t.actionMessageInfo,
    icon: "ti ti-info-circle",
    overflow: true,
    onSelect: () => {
      const [details, setDetails] = createSignal<typeof import("./message-info")>();
      const [failed, setFailed] = createSignal(false);
      const load = () => {
        setFailed(false);
        return importOnDemand(() => import("./message-info")).then((module) => {
          if (module) setDetails(module);
          else setFailed(true);
        });
      };
      void dialogCore.open<void>(
        (close) => (
          <PanelDialog>
            <PanelDialog.Header title={t.actionMessageInfo} subtitle={t.infoSubtitle} icon="ti ti-info-circle" close={close} />
            <PanelDialog.Body>
              <Show
                when={details()}
                fallback={
                  <Show when={failed()} fallback={<p role="status">{t.viewLoading}</p>}>
                    <Button variant="secondary" onClick={load}>
                      {t.chartReload}
                    </Button>
                  </Show>
                }
              >
                {(module) => module().AssistantResponseInfo({ entries: props.entries, locale: locale() })}
              </Show>
            </PanelDialog.Body>
          </PanelDialog>
        ),
        panelDialogFixedOptions,
      );
      return load();
    },
  });
  return result;
}
