import { Chart, DataPanel, DataTable, type DataTableColumn, RangePicker, SettingsPage, StatCell, StatGrid, StatusBadge } from "@k2b/ui";
import type {
  AiUsageBackgroundTask,
  AiUsageCapability,
  AiUsageFeedback,
  AiUsageModel,
  AiUsageRange,
  AiUsageReport,
  AiUsageUser,
} from "@valentinkolb/cloud/ai/admin";
import { formatDateTime, formatDurationMs, formatNumber, formatPercent } from "@valentinkolb/cloud/shared";

const ranges: readonly { value: AiUsageRange; label: string; href: string }[] = [
  { value: "24h", label: "24h", href: "/admin/settings?tab=ai-usage&range=24h" },
  { value: "7d", label: "7d", href: "/admin/settings?tab=ai-usage&range=7d" },
  { value: "30d", label: "30d", href: "/admin/settings?tab=ai-usage&range=30d" },
  { value: "90d", label: "90d", href: "/admin/settings?tab=ai-usage&range=90d" },
];

const feedbackReasonLabels: Record<string, string> = {
  incorrect: "Incorrect",
  did_not_follow_request: "Did not follow request",
  incomplete: "Incomplete",
  poor_tool_choice: "Poor tool choice",
  too_slow: "Too slow",
  other: "Other",
};
const rate = (failed: number, total: number) => (total > 0 ? formatPercent(failed / total) : "—");
const credits = (value: number | null) => formatNumber(value, { decimals: 4 });

export default function AiUsageAdminPanel(props: { report: AiUsageReport }) {
  const modelColumns: DataTableColumn<AiUsageModel>[] = [
    { id: "model", header: "Model", value: (row) => row.modelProfileId },
    { id: "turns", header: "Turns", value: (row) => row.turns, align: "right" },
    { id: "tokens", header: "Tokens", value: (row) => row.tokens, align: "right" },
    { id: "credits", header: "Credits", value: (row) => row.credits, align: "right" },
    { id: "speed", header: "Speed", value: (row) => row.avgOutputTokensPerSecond, align: "right" },
    { id: "latency", header: "Generation", value: (row) => row.avgGenerationMs, align: "right" },
    { id: "errors", header: "Errors", value: (row) => row.failed, align: "right" },
    { id: "feedback", header: "Feedback", value: (row) => row.negativeFeedback, align: "right" },
    { id: "switches", header: "Switched away", value: (row) => row.switchesAway, align: "right" },
  ];
  const userColumns: DataTableColumn<AiUsageUser>[] = [
    { id: "user", header: "User", value: (row) => row.label },
    { id: "turns", header: "Turns", value: (row) => row.turns, align: "right" },
    { id: "tokens", header: "Tokens", value: (row) => row.tokens, align: "right" },
    { id: "credits", header: "Credits", value: (row) => row.credits, align: "right" },
    { id: "capabilities", header: "Capabilities", value: (row) => row.capabilities, align: "right" },
    { id: "errors", header: "Errors", value: (row) => row.failed, align: "right" },
    { id: "feedback", header: "Ratings", value: (row) => row.feedbackGiven, align: "right" },
  ];
  const capabilityColumns: DataTableColumn<AiUsageCapability>[] = [
    { id: "capability", header: "Capability", value: (row) => row.name },
    { id: "calls", header: "Calls", value: (row) => row.calls, align: "right" },
    { id: "users", header: "Users", value: (row) => row.users, align: "right" },
    { id: "duration", header: "Average duration", value: (row) => row.avgDurationMs, align: "right" },
    { id: "errors", header: "Errors", value: (row) => row.failed, align: "right" },
    { id: "rejected", header: "Rejected", value: (row) => row.rejected, align: "right" },
  ];
  const backgroundColumns: DataTableColumn<AiUsageBackgroundTask>[] = [
    { id: "task", header: "Background task", value: (row) => row.task },
    { id: "model", header: "Model", value: (row) => row.modelProfileId },
    { id: "runs", header: "Runs", value: (row) => row.runs, align: "right" },
    { id: "tokens", header: "Tokens", value: (row) => row.tokens, align: "right" },
    { id: "duration", header: "Average duration", value: (row) => row.avgDurationMs, align: "right" },
    { id: "errors", header: "Errors", value: (row) => row.failed, align: "right" },
    { id: "last", header: "Last run", value: (row) => row.lastRunAt },
  ];
  const feedbackColumns: DataTableColumn<AiUsageFeedback>[] = [
    { id: "rating", header: "Rating", value: (row) => row.rating },
    { id: "message", header: "Message", value: (row) => row.conversationTitle },
    { id: "user", header: "User", value: (row) => row.userLabel },
    { id: "model", header: "Model", value: (row) => row.modelProfileId },
    { id: "reason", header: "Reason", value: (row) => row.reasons.join(",") },
    { id: "when", header: "Received", value: (row) => row.updatedAt },
  ];
  const totalFeedback = props.report.overview.positiveFeedback + props.report.overview.negativeFeedback;

  return (
    <SettingsPage
      title="AI Usage"
      subtitle="Usage, cost signals, quality feedback, and failures across interactive and background AI."
      icon="ti ti-chart-histogram"
      actions={<RangePicker label={null} ariaLabel="AI usage range" options={ranges} value={props.report.overview.range} />}
      scrollPreserveKey="admin-ai-usage"
    >
      <StatGrid columns={5}>
        <StatCell
          label="Turns"
          value={formatNumber(props.report.overview.turns)}
          sub={`${formatNumber(props.report.overview.activeUsers)} active users`}
        />
        <StatCell
          label="Tokens"
          value={formatNumber(props.report.overview.inputTokens + props.report.overview.outputTokens, { compact: true })}
          sub={`${formatNumber(props.report.overview.outputTokens, { compact: true })} output`}
        />
        <StatCell
          label="Credits"
          value={credits(props.report.overview.creditsUsed)}
          sub={`${formatPercent(props.report.overview.creditsCoverage)} of turns priced`}
        />
        <StatCell
          label="Turn errors"
          value={formatNumber(props.report.overview.failedTurns)}
          sub={rate(props.report.overview.failedTurns, props.report.overview.turns)}
          valueClass={props.report.overview.failedTurns > 0 ? "text-red-500" : undefined}
          accent={props.report.overview.failedTurns > 0 ? { tone: "red", icon: "ti ti-alert-circle" } : undefined}
        />
        <StatCell
          label="Positive feedback"
          value={totalFeedback > 0 ? formatPercent(props.report.overview.positiveFeedback / totalFeedback) : "—"}
          sub={`${formatNumber(totalFeedback)} ratings`}
        />
      </StatGrid>

      <DataPanel
        title="Usage over time"
        subtitle="Interactive turns and failures in the selected range."
        isEmpty={props.report.timeline.length === 0}
        empty="No AI turns in this range."
      >
        <Chart
          kind="line"
          class="h-72 w-full text-dimmed"
          series={[
            { label: "Turns", data: props.report.timeline.map((point) => ({ x: new Date(point.bucket).getTime(), y: point.turns })) },
            { label: "Errors", data: props.report.timeline.map((point) => ({ x: new Date(point.bucket).getTime(), y: point.failed })) },
          ]}
          xAxis={{ format: (value) => formatDateTime(new Date(value)) }}
          legend
          area
          interactive
        />
      </DataPanel>

      <DataPanel
        title="Token volume"
        subtitle="Reported input and output tokens combined per time bucket."
        isEmpty={props.report.timeline.length === 0}
        empty="No reported token usage in this range."
      >
        <Chart
          kind="line"
          class="h-56 w-full text-dimmed"
          series={[
            { label: "Tokens", data: props.report.timeline.map((point) => ({ x: new Date(point.bucket).getTime(), y: point.tokens })) },
          ]}
          xAxis={{ format: (value) => formatDateTime(new Date(value)) }}
          yAxis={{ format: (value) => formatNumber(value, { compact: true }) }}
          area
          interactive
        />
      </DataPanel>

      <DataPanel
        title="Models"
        subtitle={`${formatNumber(props.report.overview.modelSwitches)} mid-chat model switches. Latency uses generation time; speed uses output tokens per second.`}
        class="overflow-hidden"
      >
        <DataTable
          rows={props.report.models}
          columns={modelColumns}
          getRowId={(row) => row.modelProfileId}
          density="compact"
          hoverRows
          class="overflow-x-auto"
          empty="No model usage in this range."
          renderCell={({ row, col, value, render }) => {
            if (col.id === "model")
              return (
                <div>
                  <div class="font-medium text-primary">{row.modelProfileId}</div>
                  <div class="text-[10px] text-dimmed">{row.providerModel ?? "Provider model unavailable"}</div>
                </div>
              );
            if (col.id === "turns" || col.id === "tokens" || col.id === "switches")
              return <span class="tabular-nums">{formatNumber(Number(value))}</span>;
            if (col.id === "credits") return <span class="tabular-nums">{credits(row.credits)}</span>;
            if (col.id === "speed")
              return (
                <span class="tabular-nums">
                  {row.avgOutputTokensPerSecond === null ? "—" : `${formatNumber(row.avgOutputTokensPerSecond, { decimals: 1 })} tok/s`}
                </span>
              );
            if (col.id === "latency")
              return (
                <span class="tabular-nums" title={`p95 ${formatDurationMs(row.p95GenerationMs)}`}>
                  {formatDurationMs(row.avgGenerationMs)}
                </span>
              );
            if (col.id === "errors")
              return <StatusBadge label={`${row.failed} · ${rate(row.failed, row.turns)}`} tone={row.failed > 0 ? "error" : "neutral"} />;
            if (col.id === "feedback")
              return (
                <span class="whitespace-nowrap text-xs">
                  {row.positiveFeedback} <i class="ti ti-thumb-up" aria-hidden="true" /> · {row.negativeFeedback}{" "}
                  <i class="ti ti-thumb-down" aria-hidden="true" />
                </span>
              );
            return render(value);
          }}
        />
      </DataPanel>

      <DataPanel
        title="Users"
        subtitle="Private message content is never exposed; this table contains accounting metadata only."
        class="overflow-hidden"
      >
        <DataTable
          rows={props.report.users}
          columns={userColumns}
          getRowId={(row) => row.userId}
          density="compact"
          hoverRows
          class="overflow-x-auto"
          empty="No user usage in this range."
          renderCell={({ row, col, value, render }) => {
            if (col.id === "user") return <span class="font-medium text-primary">{row.label}</span>;
            if (col.id === "credits") return <span class="tabular-nums">{credits(row.credits)}</span>;
            if (col.id === "errors")
              return <StatusBadge label={`${row.failed} · ${rate(row.failed, row.turns)}`} tone={row.failed > 0 ? "error" : "neutral"} />;
            return render(value);
          }}
        />
      </DataPanel>

      <DataPanel
        title="Capabilities"
        subtitle="Application capability calls, failures, rejections, and server execution time."
        class="overflow-hidden"
      >
        <DataTable
          rows={props.report.capabilities}
          columns={capabilityColumns}
          getRowId={(row) => row.name}
          density="compact"
          hoverRows
          class="overflow-x-auto"
          empty="No application capabilities used in this range."
          renderCell={({ row, col, value, render }) => {
            if (col.id === "capability") return <code class="text-[10px] text-primary">{row.name}</code>;
            if (col.id === "duration") return <span class="tabular-nums">{formatDurationMs(row.avgDurationMs)}</span>;
            if (col.id === "errors")
              return <StatusBadge label={`${row.failed} · ${rate(row.failed, row.calls)}`} tone={row.failed > 0 ? "error" : "neutral"} />;
            return render(value);
          }}
        />
      </DataPanel>

      <DataPanel
        title="Background AI"
        subtitle="Structured AI and workflow tasks. Errors remain grouped by owning application, task, and model."
        class="overflow-hidden"
      >
        <DataTable
          rows={props.report.backgroundTasks}
          columns={backgroundColumns}
          getRowId={(row) => `${row.appId}:${row.task}:${row.modelProfileId ?? "unknown"}`}
          density="compact"
          hoverRows
          class="overflow-x-auto"
          empty="No background AI runs in this range."
          renderCell={({ row, col, value, render }) => {
            if (col.id === "task")
              return (
                <div class="max-w-80">
                  <code class="text-[10px] text-primary">{row.task}</code>
                  <div class="text-[10px] text-dimmed">{row.appId}</div>
                  {row.lastError ? (
                    <div class="truncate text-[10px] text-red-500" title={row.lastError}>
                      {row.lastError}
                    </div>
                  ) : null}
                </div>
              );
            if (col.id === "model") return <code class="text-[10px]">{row.modelProfileId ?? "unresolved"}</code>;
            if (col.id === "duration") return <span class="tabular-nums">{formatDurationMs(row.avgDurationMs)}</span>;
            if (col.id === "errors")
              return (
                <StatusBadge
                  label={`${row.failed} · ${rate(row.failed, row.runs)}`}
                  tone={row.failed > 0 ? "error" : "neutral"}
                  title={row.lastError ?? undefined}
                />
              );
            if (col.id === "last") return <span class="whitespace-nowrap text-xs text-dimmed">{formatDateTime(row.lastRunAt)}</span>;
            return render(value);
          }}
        />
      </DataPanel>

      <div class="grid gap-2 xl:grid-cols-2">
        <DataPanel
          title="Launched by applications"
          subtitle={`${formatNumber(props.report.overview.launchedChats)} chats explicitly launched outside Assistant.`}
          class="overflow-hidden"
        >
          <DataTable
            rows={props.report.launches}
            columns={[
              { id: "app", header: "Application", value: (row) => row.appId },
              { id: "chats", header: "Chats", value: (row) => row.chats, align: "right" },
              { id: "users", header: "Users", value: (row) => row.users, align: "right" },
            ]}
            getRowId={(row) => row.appId}
            density="compact"
            empty="No application-launched chats in this range."
          />
        </DataPanel>
        <DataPanel
          title="Message ranking"
          subtitle="Needs-work ratings first, then newest. Reasons and comments are shown; message content stays private."
          class="overflow-hidden"
        >
          <DataTable
            rows={props.report.feedback}
            columns={feedbackColumns}
            getRowId={(row) => `${row.conversationId}:${row.messageId}`}
            density="compact"
            hoverRows
            class="overflow-x-auto"
            empty="No message feedback in this range."
            renderCell={({ row, col, value, render }) => {
              if (col.id === "rating")
                return <StatusBadge label={row.rating === "up" ? "Helpful" : "Needs work"} tone={row.rating === "up" ? "ok" : "error"} />;
              if (col.id === "message")
                return (
                  <div class="max-w-64">
                    <div class="truncate font-medium text-primary">{row.conversationTitle}</div>
                    <div class="truncate text-[10px] text-dimmed">
                      {row.conversationId} · {row.messageId}
                    </div>
                  </div>
                );
              if (col.id === "model") return <code class="text-[10px]">{row.modelProfileId ?? "unknown"}</code>;
              if (col.id === "reason")
                return (
                  <div class="max-w-80 text-xs">
                    <div>{row.reasons.map((reason) => feedbackReasonLabels[reason] ?? reason).join(", ") || "Comment only"}</div>
                    {row.comment ? (
                      <div class="truncate text-dimmed" title={row.comment}>
                        {row.comment}
                      </div>
                    ) : null}
                  </div>
                );
              if (col.id === "when") return <span class="whitespace-nowrap text-xs text-dimmed">{formatDateTime(row.updatedAt)}</span>;
              return render(value);
            }}
          />
        </DataPanel>
      </div>
    </SettingsPage>
  );
}
