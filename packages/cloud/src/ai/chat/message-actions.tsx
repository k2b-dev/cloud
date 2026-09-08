import type { Message, Usage } from "@k2b/nessi";
import {
  Button,
  type ChatAction,
  CheckboxCard,
  dialogCore,
  PanelDialog,
  panelDialogFixedOptions,
  prompts,
  StatCell,
  StatGrid,
  TextInput,
  useLocale,
} from "@k2b/ui";
import { createContext, createSignal, For, type JSX, Show, useContext } from "solid-js";
import type { AiTurnBlock } from "../protocol";
import type { AiMessageFeedback, AiMessageFeedbackReason, AiStoredMessage } from "../types";
import { type AiForkMessageInput, type AiRetryMessageInput, aiToolIcon, displayToolName, formatWorkedDuration } from "./message-utils";
import { aiChatMessages } from "./messages";

/** The active-turn coordinates an approval/tool action needs to resolve on the server. */
export type AiTurnActionRequest = { turnId: string; callId: string; name: string };

type ApprovalHandler = (request: AiTurnActionRequest, input: { approved: boolean; remember?: "always" }) => void | Promise<void>;
type FrontendToolResultHandler = (request: AiTurnActionRequest, result: unknown) => void | Promise<void>;
type ForkMessageHandler = (entry: AiStoredMessage, input?: AiForkMessageInput) => void | Promise<void>;
type RetryMessageHandler = (entry: AiStoredMessage, input?: AiRetryMessageInput) => void | Promise<void>;
type RetrySteerHandler = (block: Extract<AiTurnBlock, { kind: "steer_message" }>) => void | Promise<void>;

export type AiChatActions = {
  /** Prevents turn-continuation actions while the current turn is stopping. */
  actionDisabled?: () => boolean;
  onApproval?: ApprovalHandler;
  onFrontendToolResult?: FrontendToolResultHandler;
  onForkMessage?: ForkMessageHandler;
  onRetryMessage?: RetryMessageHandler;
  onRetrySteer?: RetrySteerHandler;
  onMessageFeedback?: (entry: AiStoredMessage, feedback: Omit<AiMessageFeedback, "updatedAt"> | null) => void | Promise<void>;
  /** Open a conversation VFS file in the host application's artifact surface. */
  onOpenFile?: (path: string) => void;
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

const usageValue = (usage: Usage | null | undefined, key: "input" | "output" | "total" | "creditsUsed") => {
  const value = (usage as Partial<Record<"input" | "output" | "total" | "creditsUsed", unknown>> | null | undefined)?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
};

const formatDateTime = (value: string, locale: string) =>
  new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));

const assistantResponseInfo = (entries: AiStoredMessage[], locale: string) => {
  const assistantEntries = entries.filter((entry) => entry.kind === "message" && entry.message.role === "assistant");
  const entry = assistantEntries.findLast((candidate) => candidate.loopAggregate) ?? assistantEntries.at(-1) ?? entries.at(-1);
  if (!entry) return null;

  const blocks = assistantEntries.flatMap((candidate) => assistantBlocks(candidate.message));
  const toolCalls = blocks.filter((block) => block.type === "tool_call");
  const aggregate = entry.loopAggregate;
  const usage = aggregate?.usage ?? entry.usage;
  const credits = usageValue(usage, "creditsUsed");
  const timing = aggregate?.timing;

  const meta = [
    { label: "Provider model", value: entry.providerModel ?? "Unknown" },
    { label: "Model profile", value: entry.modelProfileId ?? "Unknown" },
    { label: "Loop id", value: entry.loopId ?? "Legacy message" },
    { label: "Finished", value: `${entry.loopDoneReason ?? "unknown"} · ${entry.stopReason ?? "unknown"}` },
    { label: "Created", value: formatDateTime(entry.createdAt, locale) },
  ];

  const issues = [
    { label: "errors", count: aggregate?.toolErrorCount ?? 0 },
    { label: "stream issues", count: aggregate?.toolIssueCount ?? 0 },
    { label: "malformed", count: aggregate?.toolMalformedCount ?? 0 },
    { label: "cancelled", count: aggregate?.toolCancelledCount ?? 0 },
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
      credits,
    },
    turns: aggregate?.assistantMessageCount ?? 1,
    toolCallCount: aggregate?.toolCallCount ?? toolCalls.length,
    issues,
    tools: [...toolCounts.entries()].map(([name, count]) => ({ name, count })),
  };
};

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
        <PanelDialog.Header title="Message info" subtitle="Assistant response metadata" icon="ti ti-info-circle" close={close} />
        <PanelDialog.Body>
          <PanelDialog.Section title="Details" icon="ti ti-list-details">
            <dl class="grid grid-cols-[auto_1fr] items-baseline gap-x-6 gap-y-1.5 text-sm">
              <For each={info.meta}>
                {(row) => (
                  <>
                    <dt class="text-dimmed">{row.label}</dt>
                    <dd class="min-w-0 truncate text-right text-primary" title={row.value}>
                      {row.value}
                    </dd>
                  </>
                )}
              </For>
            </dl>
          </PanelDialog.Section>

          <Show when={info.timing}>
            {(timing) => (
              <StatGrid title="Timing" columns={3} surface="muted">
                {/* Worked = generation + tool execution; waiting for approvals/client tools is listed separately. */}
                <StatCell label="Worked" value={formatWorkedDuration(timing().totalElapsedMs)} sub="generation + tools" />
                <StatCell label="Generation" value={formatWorkedDuration(timing().generationMs)} />
                <StatCell
                  label="Tool execution"
                  value={timing().toolExecutionMs > 0 ? formatWorkedDuration(timing().toolExecutionMs) : "–"}
                />
                <StatCell
                  label="Waiting for user"
                  value={timing().actionWaitMs > 0 ? formatWorkedDuration(timing().actionWaitMs) : "–"}
                  sub="approvals & inputs"
                />
                <StatCell label="Wall clock" value={formatWorkedDuration(timing().wallMs)} />
                <StatCell
                  label="Output speed"
                  value={
                    timing().outputTokensPerSecond !== undefined
                      ? `${timing().outputTokensPerSecond?.toLocaleString(locale, { maximumFractionDigits: 1 })} tok/s`
                      : "–"
                  }
                />
              </StatGrid>
            )}
          </Show>

          <StatGrid title="Usage" columns={3} surface="muted">
            <StatCell label="Input tokens" value={tokens(info.usage.input)} />
            <StatCell label="Output tokens" value={tokens(info.usage.output)} />
            <StatCell label="Total tokens" value={tokens(info.usage.total)} />
            <StatCell label={t.assistantTurns} value={number(info.turns)} />
            <StatCell label={t.toolCalls} value={number(info.toolCallCount)} />
            <Show
              when={info.issues.length > 0}
              fallback={<StatCell label={t.toolIssues} value={t.none} accent={{ tone: "emerald", icon: "ti ti-check", text: "ok" }} />}
            >
              <StatCell
                label={t.toolIssues}
                value={number(issueTotal)}
                sub={issueSummary}
                accent={{ tone: "red", icon: "ti ti-alert-triangle" }}
              />
            </Show>
            <Show when={info.usage.credits !== null && info.usage.credits > 0}>
              <StatCell label="Credits" value={info.usage.credits?.toLocaleString(locale, { maximumFractionDigits: 6 }) ?? "–"} />
            </Show>
          </StatGrid>

          <Show when={info.tools.length > 0}>
            <PanelDialog.Section title="Tools" icon="ti ti-tool" subtitle="Tools requested by this assistant loop.">
              <div class="flex flex-wrap gap-1.5">
                <For each={info.tools}>
                  {(tool) => (
                    <span class="inline-flex items-center gap-1.5 rounded-md bg-zinc-100 px-2 py-1 text-xs text-secondary dark:bg-zinc-900">
                      <i class={`${aiToolIcon(tool.name)} text-sm`} aria-hidden="true" />
                      {displayToolName(tool.name)}
                      <Show when={tool.count > 1}>
                        <span class="rounded bg-white px-1 font-medium tabular-nums text-dimmed dark:bg-zinc-950">×{tool.count}</span>
                      </Show>
                    </span>
                  )}
                </For>
              </div>
            </PanelDialog.Section>
          </Show>
        </PanelDialog.Body>
      </PanelDialog>
    ),
    panelDialogFixedOptions,
  );
};

const forkTitleFromText = (text: string): string => {
  const firstLine = text
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) return "Forked chat";
  return firstLine.length > 80 ? `${firstLine.slice(0, 77).trim()}...` : firstLine;
};

const openForkMessageDialog = async (
  entry: AiStoredMessage,
  copyText: string,
  onForkMessage: (entry: AiStoredMessage, input?: AiForkMessageInput) => void | Promise<void>,
) => {
  const result = await prompts.form({
    title: "Fork chat",
    icon: "ti ti-git-fork",
    confirmText: "Fork",
    size: "medium",
    fields: {
      title: {
        type: "text",
        label: "Chat name",
        default: forkTitleFromText(copyText),
        required: true,
        maxLength: 120,
      },
    },
  });
  const title = result?.title.trim();
  if (title) await onForkMessage(entry, { title });
};

const feedbackReasons: readonly { id: AiMessageFeedbackReason; label: string; description: string }[] = [
  { id: "incorrect", label: "Incorrect", description: "Facts or conclusions were wrong." },
  { id: "did_not_follow_request", label: "Did not follow request", description: "The response missed important instructions." },
  { id: "incomplete", label: "Incomplete", description: "Important information or work was missing." },
  { id: "poor_tool_choice", label: "Poor tool choice", description: "A capability was missing, unnecessary, or used badly." },
  { id: "too_slow", label: "Too slow", description: "The response took too long for the result." },
  { id: "other", label: "Other", description: "Something else should be improved." },
];

const openNegativeFeedbackDialog = () =>
  prompts.dialog<{ reasons: AiMessageFeedbackReason[]; comment: string | null } | undefined>(
    (close) => {
      const [selected, setSelected] = createSignal<AiMessageFeedbackReason[]>([]);
      const [comment, setComment] = createSignal("");
      const toggle = (reason: AiMessageFeedbackReason, enabled: boolean) =>
        setSelected((current) => (enabled ? [...current, reason] : current.filter((candidate) => candidate !== reason)));
      const valid = () => selected().length > 0 || comment().trim().length > 0;
      return (
        <div class="flex min-h-0 flex-col gap-4">
          <p class="text-sm text-secondary">What should be improved? Choose all that apply or leave a short note.</p>
          <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <For each={feedbackReasons}>
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
            label="Additional details"
            description="Optional. Do not include sensitive information."
            multiline
            lines={3}
            maxLength={1_000}
            value={comment}
            onValueChange={setComment}
          />
          <div class="flex justify-end gap-2">
            <Button variant="secondary" size="sm" type="button" onClick={() => close(undefined)}>
              Cancel
            </Button>
            <Button
              size="sm"
              type="button"
              disabled={!valid()}
              onClick={() => close({ reasons: selected(), comment: comment().trim() || null })}
            >
              Send feedback
            </Button>
          </div>
        </div>
      );
    },
    { title: "Help improve this response", icon: "ti ti-message-report", size: "large" },
  );

export function createAssistantMessageActions(props: {
  entry: AiStoredMessage;
  entries: AiStoredMessage[];
  copyText: string;
  actions: AiChatActions;
}): ChatAction[] {
  const locale = useLocale();
  const actions = props.actions;
  const result: ChatAction[] = [
    ...(actions.onMessageFeedback
      ? [
          {
            id: "feedback-up",
            label: props.entry.feedback?.rating === "up" ? "Remove positive feedback" : "Helpful",
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
            label: props.entry.feedback?.rating === "down" ? "Remove negative feedback" : "Needs improvement",
            icon: "ti ti-thumb-down",
            pressed: props.entry.feedback?.rating === "down",
            pressedTone: "danger" as const,
            onSelect: async () => {
              if (props.entry.feedback?.rating === "down") return actions.onMessageFeedback!(props.entry, null);
              const feedback = await openNegativeFeedbackDialog();
              if (feedback) await actions.onMessageFeedback!(props.entry, { rating: "down", ...feedback });
            },
          },
        ]
      : []),
    {
      id: "info",
      label: "Message info",
      icon: "ti ti-info-circle",
      onSelect: () => openAssistantResponseInfo(props.entries, locale()),
    },
  ];
  if (props.copyText) {
    result.push({
      id: "copy",
      label: "Copy",
      icon: "ti ti-copy",
      copyText: props.copyText,
    });
  }
  if (actions.onForkMessage) {
    result.push({
      id: "fork",
      label: "Fork conversation",
      icon: "ti ti-git-fork",
      onSelect: () => openForkMessageDialog(props.entry, props.copyText, actions.onForkMessage!),
    });
  }
  return result;
}
