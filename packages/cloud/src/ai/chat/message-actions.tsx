import type { Message, Usage } from "@k2b/nessi";
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
import type { AiTurnBlock } from "../protocol";
import type { AiMessageFeedback, AiMessageFeedbackReason, AiStoredMessage } from "../types";
import {
  type AiForkMessageInput,
  type AiRetryMessageInput,
  aiToolIcon,
  describeResponseEnd,
  displayToolName,
  formatWorkedDuration,
} from "./message-utils";
import { aiChatMessages } from "./messages";

/** The active-turn coordinates an approval/tool action needs to resolve on the server. */
export type AiTurnActionRequest = { turnId: string; callId: string; name: string };

type ApprovalHandler = (request: AiTurnActionRequest, input: { approved: boolean; remember?: "always" }) => void | Promise<void>;
type FrontendToolResultHandler = (request: AiTurnActionRequest, result: unknown) => void | Promise<void>;
type ForkMessageHandler = (entry: AiStoredMessage, input?: AiForkMessageInput) => void | Promise<void>;
type RetryMessageHandler = (entry: AiStoredMessage, input?: AiRetryMessageInput) => void | Promise<void>;
type RetrySteerHandler = (block: Extract<AiTurnBlock, { kind: "steer_message" }>) => void | Promise<void>;

export type AiChatActions = {
  /**
   * Host-owned visualizations, persisted independently of the execution session. Called once per `code_present`
   * call, from its first event: `result()` is undefined while the call runs and the saved result afterwards, so
   * the host reserves the frame early and keeps its state when the turn ends.
   */
  renderCodePresentation?: (result: () => unknown) => JSX.Element;
  /** Prevents turn-continuation actions while the current turn is stopping. */
  actionDisabled?: () => boolean;
  onApproval?: ApprovalHandler;
  onFrontendToolResult?: FrontendToolResultHandler;
  onForkMessage?: ForkMessageHandler;
  onRetryMessage?: RetryMessageHandler;
  onRetrySteer?: RetrySteerHandler;
  /**
   * Continue after a failed turn. Send `message`, a visible request in the reader's language to pick up where the
   * turn stopped, through the host's normal send path. Without it, a failed turn shows its reason only.
   */
  onContinueTurn?: (message: string) => void | Promise<void>;
  onMessageFeedback?: (entry: AiStoredMessage, feedback: Omit<AiMessageFeedback, "updatedAt"> | null) => void | Promise<void>;
  /** Open the originating background run for a delivered scheduled result. */
  onOpenScheduledTaskRun?: (taskId: string, occurrenceId: string) => void;
  /** Open a conversation VFS file in the host application's artifact surface. */
  onOpenFile?: (path: string) => void;
  /** Resolve a Markdown link only when it identifies a known conversation file. */
  resolveFileLink?: (href: string) => { path: string; href: string } | null;
  /** Download URL for a conversation VFS file (present blocks, attachment chips). */
  fileUrl?: (path: string) => string | null;
};

const assistantBlocks = (message: Message): Extract<Message, { role: "assistant" }>["content"] =>
  message.role === "assistant" ? message.content : [];

const AiChatActionContext = createContext<AiChatActions>({});

export const useAiChatActions = () => useContext(AiChatActionContext);

export function AiChatActionsProvider(props: { actions?: AiChatActions; children: JSX.Element }) {
  return <AiChatActionContext.Provider value={props.actions ?? {}}>{props.children}</AiChatActionContext.Provider>;
}

const usageValue = (usage: Usage | null | undefined, key: "input" | "output" | "total") => {
  const value = (usage as Partial<Record<"input" | "output" | "total", unknown>> | null | undefined)?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
};

const formatDateTime = (value: string, locale: string) =>
  new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));

const assistantResponseInfo = (entries: AiStoredMessage[], locale: string) => {
  const t = aiChatMessages(locale);
  const assistantEntries = entries.filter((entry) => entry.kind === "message" && entry.message.role === "assistant");
  const entry = assistantEntries.findLast((candidate) => candidate.loopAggregate) ?? assistantEntries.at(-1) ?? entries.at(-1);
  if (!entry) return null;

  const blocks = assistantEntries.flatMap((candidate) => assistantBlocks(candidate.message));
  const toolCalls = blocks.filter((block) => block.type === "tool_call");
  const aggregate = entry.loopAggregate;
  const usage = aggregate?.usage ?? entry.usage;
  const timing = aggregate?.timing;

  const meta = [
    { label: t.infoProviderModel, value: entry.providerModel ?? t.infoUnknown },
    { label: t.infoModelProfile, value: entry.modelProfileId ?? t.infoUnknown },
    { label: t.infoLoopId, value: entry.loopId ?? t.infoLegacy },
    { label: t.infoFinished, value: describeResponseEnd(entry, locale) },
    { label: t.infoCreated, value: formatDateTime(entry.createdAt, locale) },
  ];

  const issues = [
    { label: t.infoIssueErrors, count: aggregate?.toolErrorCount ?? 0 },
    { label: t.infoIssueStream, count: aggregate?.toolIssueCount ?? 0 },
    { label: t.infoIssueMalformed, count: aggregate?.toolMalformedCount ?? 0 },
    { label: t.infoIssueCancelled, count: aggregate?.toolCancelledCount ?? 0 },
  ].filter((issue) => issue.count > 0);

  const toolCounts = new Map<string, number>();
  for (const tool of aggregate?.turns.flatMap((turn) => turn.toolCalls) ?? toolCalls) {
    toolCounts.set(tool.name, (toolCounts.get(tool.name) ?? 0) + 1);
  }

  return {
    meta,
    timing,
    usage: {
      input: usageValue(usage, "input"),
      output: usageValue(usage, "output"),
      total: usageValue(usage, "total"),
    },
    turns: aggregate?.assistantMessageCount ?? 1,
    toolCallCount: aggregate?.toolCallCount ?? toolCalls.length,
    issues,
    tools: [...toolCounts.entries()].map(([name, count]) => ({ name, count })),
  };
};

/** Label and value pairs in one quiet list; a hint explains a value in muted text below it. */
function InfoRows(props: { rows: readonly { label: string; value: string; hint?: string }[] }) {
  return (
    <dl class="ai-response-info__rows">
      <For each={props.rows}>
        {(row) => (
          <div>
            <dt>
              {row.label}
              <Show when={row.hint}>
                <span>{row.hint}</span>
              </Show>
            </dt>
            <dd title={row.value}>{row.value}</dd>
          </div>
        )}
      </For>
    </dl>
  );
}

const openAssistantResponseInfo = (entries: AiStoredMessage[], locale: string) => {
  const info = assistantResponseInfo(entries, locale);
  if (!info) return;

  const t = aiChatMessages(locale);
  const number = (value: number) => value.toLocaleString(locale);
  const tokens = (value: number | null) => (value === null ? "–" : number(value));
  const issueSummary = info.issues.map((issue) => `${issue.count} ${issue.label}`).join(" · ");
  const issueTotal = info.issues.reduce((sum, issue) => sum + issue.count, 0);

  void dialogCore.open<void>(
    (close) => (
      <PanelDialog>
        <PanelDialog.Header title={t.actionMessageInfo} subtitle={t.infoSubtitle} icon="ti ti-info-circle" close={close} />
        <PanelDialog.Body>
          <PanelDialog.Section title={t.infoDetails} icon="ti ti-list-details">
            <InfoRows rows={info.meta} />
          </PanelDialog.Section>

          <Show when={info.timing}>
            {(timing) => (
              <PanelDialog.Section title={t.infoTiming} icon="ti ti-clock">
                {/* Worked = writing + tool execution; waiting for approvals and answers is listed separately. */}
                <InfoRows
                  rows={[
                    { label: t.infoWorked, value: formatWorkedDuration(timing().totalElapsedMs), hint: t.infoWorkedHint },
                    { label: t.infoGeneration, value: formatWorkedDuration(timing().generationMs) },
                    { label: t.infoToolTime, value: timing().toolExecutionMs > 0 ? formatWorkedDuration(timing().toolExecutionMs) : "–" },
                    {
                      label: t.infoWaiting,
                      value: timing().actionWaitMs > 0 ? formatWorkedDuration(timing().actionWaitMs) : "–",
                      hint: t.infoWaitingHint,
                    },
                    { label: t.infoWallClock, value: formatWorkedDuration(timing().wallMs) },
                    {
                      label: t.infoSpeed,
                      value:
                        timing().outputTokensPerSecond !== undefined
                          ? t.infoTokensPerSecond({
                              value: timing().outputTokensPerSecond!.toLocaleString(locale, { maximumFractionDigits: 1 }),
                            })
                          : "–",
                    },
                  ]}
                />
              </PanelDialog.Section>
            )}
          </Show>

          <PanelDialog.Section title={t.infoUsage} icon="ti ti-chart-bar">
            <InfoRows
              rows={[
                { label: t.infoInputTokens, value: tokens(info.usage.input) },
                { label: t.infoOutputTokens, value: tokens(info.usage.output) },
                { label: t.infoTotalTokens, value: tokens(info.usage.total) },
                { label: t.assistantTurns, value: number(info.turns) },
                { label: t.toolCalls, value: number(info.toolCallCount) },
                { label: t.toolIssues, value: info.issues.length > 0 ? `${number(issueTotal)} · ${issueSummary}` : t.none },
              ]}
            />
          </PanelDialog.Section>

          <Show when={info.tools.length > 0}>
            <PanelDialog.Section title={t.infoTools} icon="ti ti-tool" subtitle={t.infoToolsHint}>
              <ul class="ai-response-info__tools">
                <For each={info.tools}>
                  {(tool) => (
                    <li>
                      <i class={aiToolIcon(tool.name)} aria-hidden="true" />
                      {displayToolName(tool.name)}
                      <Show when={tool.count > 1}>
                        <span class="text-dimmed tabular-nums">×{tool.count}</span>
                      </Show>
                    </li>
                  )}
                </For>
              </ul>
            </PanelDialog.Section>
          </Show>
        </PanelDialog.Body>
      </PanelDialog>
    ),
    panelDialogFixedOptions,
  );
};

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

export function createAssistantMessageActions(props: {
  entry: AiStoredMessage;
  entries: AiStoredMessage[];
  copyText: string;
  actions: AiChatActions;
}): ChatAction[] {
  const locale = useLocale();
  const t = aiChatMessages(locale());
  const actions = props.actions;
  const result: ChatAction[] = [
    ...(actions.onMessageFeedback
      ? [
          {
            id: "feedback-up",
            label: props.entry.feedback?.rating === "up" ? t.actionHelpfulRemove : t.actionHelpful,
            icon: "ti ti-thumb-up",
            pressed: props.entry.feedback?.rating === "up",
            pressedTone: "success" as const,
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
            pressedTone: "danger" as const,
            onSelect: async () => {
              if (props.entry.feedback?.rating === "down") return actions.onMessageFeedback!(props.entry, null);
              const feedback = await openNegativeFeedbackDialog(t);
              if (feedback) await actions.onMessageFeedback!(props.entry, { rating: "down", ...feedback });
            },
          },
        ]
      : []),
    {
      id: "info",
      label: t.actionMessageInfo,
      icon: "ti ti-info-circle",
      onSelect: () => openAssistantResponseInfo(props.entries, locale()),
    },
  ];
  if (props.copyText) {
    result.push({
      id: "copy",
      label: t.actionCopy,
      icon: "ti ti-copy",
      copyText: props.copyText,
    });
  }
  if (actions.onForkMessage) {
    result.push({
      id: "fork",
      label: t.actionFork,
      icon: "ti ti-git-fork",
      onSelect: () => openForkMessageDialog(props.entry, props.copyText, actions.onForkMessage!, locale()),
    });
  }
  return result;
}
