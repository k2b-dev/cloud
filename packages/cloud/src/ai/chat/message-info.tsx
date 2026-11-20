import type { Message, Usage } from "@k2b/nessi";
import { PanelDialog } from "@k2b/ui";
import { For, Show } from "solid-js";
import type { AiStoredMessage } from "../types";
import { aiToolIcon, describeResponseEnd, displayToolName, formatWorkedDuration } from "./message-utils";
import { aiChatMessages } from "./messages";

const assistantBlocks = (message: Message): Extract<Message, { role: "assistant" }>["content"] =>
  message.role === "assistant" ? message.content : [];

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
    { label: t.infoModelProfile, value: entry.modelId ?? t.infoUnknown },
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

export const AssistantResponseInfo = (props: { entries: AiStoredMessage[]; locale: string }) => {
  const { entries, locale } = props;
  const info = assistantResponseInfo(entries, locale);
  if (!info) return;

  const t = aiChatMessages(locale);
  const number = (value: number) => value.toLocaleString(locale);
  const tokens = (value: number | null) => (value === null ? "–" : number(value));
  const issueSummary = info.issues.map((issue) => `${issue.count} ${issue.label}`).join(" · ");
  const issueTotal = info.issues.reduce((sum, issue) => sum + issue.count, 0);

  return (
    <>
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
                  {displayToolName(tool.name, locale)}
                  <Show when={tool.count > 1}>
                    <span class="text-dimmed tabular-nums">×{tool.count}</span>
                  </Show>
                </li>
              )}
            </For>
          </ul>
        </PanelDialog.Section>
      </Show>
    </>
  );
};
