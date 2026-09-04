import {
  DataPanel,
  DataTable,
  type DataTableColumn,
  Pagination,
  RangePicker,
  SettingsPage,
  StatCell,
  StatGrid,
  StatusBadge,
  useLocale,
} from "@k2b/ui";
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
import AiUsageCharts from "./AiUsageCharts.island";
import { aiUsageMessages } from "./ai-usage-messages";

const ranges: readonly { value: AiUsageRange; label: string; href: string }[] = [
  { value: "24h", label: "24h", href: "/admin/settings?tab=ai-usage&range=24h" },
  { value: "7d", label: "7d", href: "/admin/settings?tab=ai-usage&range=7d" },
  { value: "30d", label: "30d", href: "/admin/settings?tab=ai-usage&range=30d" },
  { value: "90d", label: "90d", href: "/admin/settings?tab=ai-usage&range=90d" },
];

export default function AiUsageAdminPanel(props: { report: AiUsageReport }) {
  const locale = useLocale();
  const t = () => aiUsageMessages.resolve([locale()]).t;
  const dateContext = () => ({ locale: locale() });
  const numberContext = () => ({ locale: locale() });
  const rate = (failed: number, total: number) => (total > 0 ? formatPercent(failed / total, numberContext()) : "—");
  const credits = (value: number | null) => formatNumber(value, { ...numberContext(), decimals: 4 });
  const feedbackReasonLabels = () =>
    ({
      incorrect: t().incorrect,
      did_not_follow_request: t().didNotFollowRequest,
      incomplete: t().incomplete,
      poor_tool_choice: t().poorToolChoice,
      too_slow: t().tooSlow,
      other: t().other,
    }) satisfies Record<string, string>;
  const modelColumns: DataTableColumn<AiUsageModel>[] = [
    { id: "model", header: t().model, value: (row) => row.modelProfileId },
    { id: "turns", header: t().turns, value: (row) => row.turns, align: "right" },
    { id: "tokens", header: t().tokens, value: (row) => row.tokens, align: "right" },
    { id: "credits", header: t().credits, value: (row) => row.credits, align: "right" },
    { id: "speed", header: t().speed, value: (row) => row.avgOutputTokensPerSecond, align: "right" },
    { id: "latency", header: t().generation, value: (row) => row.avgGenerationMs, align: "right" },
    { id: "errors", header: t().errors, value: (row) => row.failed, align: "right" },
    { id: "feedback", header: t().feedback, value: (row) => row.negativeFeedback, align: "right" },
    { id: "switches", header: t().switchedAway, value: (row) => row.switchesAway, align: "right" },
  ];
  const userColumns: DataTableColumn<AiUsageUser>[] = [
    { id: "user", header: t().user, value: (row) => row.label },
    { id: "turns", header: t().turns, value: (row) => row.turns, align: "right" },
    { id: "tokens", header: t().tokens, value: (row) => row.tokens, align: "right" },
    { id: "credits", header: t().credits, value: (row) => row.credits, align: "right" },
    { id: "capabilities", header: t().capabilities, value: (row) => row.capabilities, align: "right" },
    { id: "errors", header: t().errors, value: (row) => row.failed, align: "right" },
    { id: "feedback", header: t().ratings, value: (row) => row.feedbackGiven, align: "right" },
  ];
  const capabilityColumns: DataTableColumn<AiUsageCapability>[] = [
    { id: "capability", header: t().capability, value: (row) => row.name },
    { id: "calls", header: t().calls, value: (row) => row.calls, align: "right" },
    { id: "users", header: t().users, value: (row) => row.users, align: "right" },
    { id: "duration", header: t().averageDuration, value: (row) => row.avgDurationMs, align: "right" },
    { id: "errors", header: t().errors, value: (row) => row.failed, align: "right" },
    { id: "rejected", header: t().rejected, value: (row) => row.rejected, align: "right" },
  ];
  const backgroundColumns: DataTableColumn<AiUsageBackgroundTask>[] = [
    { id: "task", header: t().backgroundTask, value: (row) => row.task },
    { id: "model", header: t().model, value: (row) => row.modelProfileId },
    { id: "runs", header: t().runs, value: (row) => row.runs, align: "right" },
    { id: "tokens", header: t().tokens, value: (row) => row.tokens, align: "right" },
    { id: "credits", header: t().credits, value: (row) => row.credits, align: "right" },
    { id: "coverage", header: t().priceCoverage, value: (row) => row.creditsCoverage, align: "right" },
    { id: "duration", header: t().averageDuration, value: (row) => row.avgDurationMs, align: "right" },
    { id: "errors", header: t().errors, value: (row) => row.failed, align: "right" },
    { id: "last", header: t().lastRun, value: (row) => row.lastRunAt },
  ];
  const feedbackColumns: DataTableColumn<AiUsageFeedback>[] = [
    { id: "rating", header: t().rating, value: (row) => row.rating },
    { id: "message", header: t().message, value: (row) => row.conversationTitle },
    { id: "user", header: t().user, value: (row) => row.userLabel },
    { id: "model", header: t().model, value: (row) => row.modelProfileId },
    { id: "reason", header: t().reason, value: (row) => row.reasons.join(",") },
    { id: "when", header: t().received, value: (row) => row.updatedAt },
  ];
  const pagination = (table: keyof AiUsageReport["pagination"]) => {
    const entry = props.report.pagination[table];
    const params = new URLSearchParams({ tab: "ai-usage", range: props.report.overview.range });
    for (const key of ["users", "capabilities", "backgroundTasks", "feedback"] as const) {
      if (key !== table && props.report.pagination[key].page > 1) params.set(`${key}Page`, String(props.report.pagination[key].page));
    }
    return (
      <div class="flex flex-wrap items-center justify-between gap-2">
        <span class="text-xs text-dimmed">
          {t().shownOfTotal({
            shown: formatNumber(props.report[table].length, numberContext()),
            total: formatNumber(entry.total, numberContext()),
          })}
        </span>
        <Pagination
          currentPage={entry.page}
          totalPages={Math.ceil(entry.total / entry.perPage)}
          baseUrl={`/admin/settings?${params}&${table}Page=`}
        />
      </div>
    );
  };
  const totalFeedback = props.report.overview.positiveFeedback + props.report.overview.negativeFeedback;

  return (
    <SettingsPage
      title={t().title}
      subtitle={t().description}
      icon="ti ti-chart-histogram"
      actions={<RangePicker label={null} ariaLabel={t().range} options={ranges} value={props.report.overview.range} />}
      scrollPreserveKey="admin-ai-usage"
    >
      <p class="text-sm text-dimmed">{t().interactiveSummary}</p>
      <StatGrid columns={5}>
        <StatCell
          label={t().turns}
          value={formatNumber(props.report.overview.turns, numberContext())}
          sub={t().activeUsers({ count: formatNumber(props.report.overview.activeUsers, numberContext()) })}
        />
        <StatCell
          label={t().tokens}
          value={formatNumber(props.report.overview.inputTokens + props.report.overview.outputTokens, {
            ...numberContext(),
            compact: true,
          })}
          sub={t().outputTokens({ count: formatNumber(props.report.overview.outputTokens, { ...numberContext(), compact: true }) })}
        />
        <StatCell
          label={t().credits}
          value={credits(props.report.overview.creditsUsed)}
          sub={t().turnsPriced({ percent: formatPercent(props.report.overview.creditsCoverage, numberContext()) })}
        />
        <StatCell
          label={t().turnErrors}
          value={formatNumber(props.report.overview.failedTurns, numberContext())}
          sub={rate(props.report.overview.failedTurns, props.report.overview.turns)}
          valueClass={props.report.overview.failedTurns > 0 ? "text-red-500" : undefined}
          accent={props.report.overview.failedTurns > 0 ? { tone: "red", icon: "ti ti-alert-circle" } : undefined}
        />
        <StatCell
          label={t().positiveFeedback}
          value={totalFeedback > 0 ? formatPercent(props.report.overview.positiveFeedback / totalFeedback, numberContext()) : "—"}
          sub={t().ratingCount({ count: formatNumber(totalFeedback, numberContext()) })}
        />
      </StatGrid>

      <AiUsageCharts timeline={props.report.timeline} range={props.report.overview.range} />

      <DataPanel
        title={t().models}
        subtitle={t().modelSummary({ count: formatNumber(props.report.overview.modelSwitches, numberContext()) })}
        class="min-w-0 overflow-hidden"
      >
        <DataTable
          rows={props.report.models}
          columns={modelColumns}
          getRowId={(row) => row.modelProfileId}
          density="compact"
          hoverRows
          class="overflow-x-auto"
          empty={t().noModels}
          renderCell={({ row, col, value, render }) => {
            if (col.id === "model")
              return (
                <div>
                  <div class="font-medium text-primary">{row.modelProfileId}</div>
                  <div class="text-[10px] text-dimmed">{row.providerModel ?? t().providerModelUnavailable}</div>
                </div>
              );
            if (col.id === "turns" || col.id === "tokens" || col.id === "switches")
              return <span class="tabular-nums">{formatNumber(Number(value), numberContext())}</span>;
            if (col.id === "credits") return <span class="tabular-nums">{credits(row.credits)}</span>;
            if (col.id === "speed")
              return (
                <span class="tabular-nums">
                  {row.avgOutputTokensPerSecond === null
                    ? "—"
                    : `${formatNumber(row.avgOutputTokensPerSecond, { ...numberContext(), decimals: 1 })} tok/s`}
                </span>
              );
            if (col.id === "latency")
              return (
                <span class="tabular-nums" title={`p95 ${formatDurationMs(row.p95GenerationMs, numberContext())}`}>
                  {formatDurationMs(row.avgGenerationMs, numberContext())}
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

      <DataPanel footer={pagination("users")} title={t().usersTitle} subtitle={t().usersDescription} class="min-w-0 overflow-hidden">
        <DataTable
          rows={props.report.users}
          columns={userColumns}
          getRowId={(row) => row.userId}
          density="compact"
          hoverRows
          class="overflow-x-auto"
          empty={t().noUsers}
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
        footer={pagination("capabilities")}
        title={t().capabilitiesTitle}
        subtitle={t().capabilitiesDescription}
        class="min-w-0 overflow-hidden"
      >
        <DataTable
          rows={props.report.capabilities}
          columns={capabilityColumns}
          getRowId={(row) => row.name}
          density="compact"
          hoverRows
          class="overflow-x-auto"
          empty={t().noCapabilities}
          renderCell={({ row, col, value, render }) => {
            if (col.id === "capability") return <code class="text-[10px] text-primary">{row.name}</code>;
            if (col.id === "duration") return <span class="tabular-nums">{formatDurationMs(row.avgDurationMs, numberContext())}</span>;
            if (col.id === "errors")
              return <StatusBadge label={`${row.failed} · ${rate(row.failed, row.calls)}`} tone={row.failed > 0 ? "error" : "neutral"} />;
            return render(value);
          }}
        />
      </DataPanel>

      <DataPanel
        footer={pagination("backgroundTasks")}
        title={t().backgroundAi}
        subtitle={t().backgroundDescription}
        class="min-w-0 overflow-hidden"
      >
        <DataTable
          rows={props.report.backgroundTasks}
          columns={backgroundColumns}
          getRowId={(row) => `${row.appId}:${row.task}:${row.modelProfileId ?? "unknown"}`}
          density="compact"
          hoverRows
          class="overflow-x-auto"
          empty={t().noBackground}
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
            if (col.id === "model") return <code class="text-[10px]">{row.modelProfileId ?? t().unresolved}</code>;
            if (col.id === "credits") return <span class="tabular-nums">{credits(row.credits)}</span>;
            if (col.id === "coverage") return <span class="tabular-nums">{formatPercent(row.creditsCoverage, numberContext())}</span>;
            if (col.id === "duration") return <span class="tabular-nums">{formatDurationMs(row.avgDurationMs, numberContext())}</span>;
            if (col.id === "errors")
              return (
                <StatusBadge
                  label={`${row.failed} · ${rate(row.failed, row.runs)}`}
                  tone={row.failed > 0 ? "error" : "neutral"}
                  title={row.lastError ?? undefined}
                />
              );
            if (col.id === "last")
              return <span class="whitespace-nowrap text-xs text-dimmed">{formatDateTime(row.lastRunAt, dateContext())}</span>;
            return render(value);
          }}
        />
      </DataPanel>

      <div class="grid min-w-0 gap-2 xl:grid-cols-2">
        <DataPanel
          title={t().launchedByApps}
          subtitle={t().launchedDescription({ count: formatNumber(props.report.overview.launchedChats, numberContext()) })}
          class="min-w-0 overflow-hidden"
        >
          <DataTable
            rows={props.report.launches}
            columns={[
              { id: "app", header: t().application, value: (row) => row.appId },
              { id: "chats", header: t().chats, value: (row) => row.chats, align: "right" },
              { id: "users", header: t().users, value: (row) => row.users, align: "right" },
            ]}
            getRowId={(row) => row.appId}
            density="compact"
            empty={t().noLaunches}
          />
        </DataPanel>
        <DataPanel
          footer={pagination("feedback")}
          title={t().messageRanking}
          subtitle={t().messageRankingDescription}
          class="min-w-0 overflow-hidden"
        >
          <DataTable
            rows={props.report.feedback}
            columns={feedbackColumns}
            getRowId={(row) => `${row.conversationId}:${row.messageId}`}
            density="compact"
            hoverRows
            class="overflow-x-auto"
            empty={t().noMessageFeedback}
            renderCell={({ row, col, value, render }) => {
              if (col.id === "rating")
                return (
                  <StatusBadge label={row.rating === "up" ? t().helpful : t().needsWork} tone={row.rating === "up" ? "ok" : "error"} />
                );
              if (col.id === "message")
                return (
                  <div class="max-w-64">
                    <div class="truncate font-medium text-primary">{row.conversationTitle}</div>
                    <div class="truncate text-[10px] text-dimmed">
                      {row.conversationId} · {row.messageId}
                    </div>
                  </div>
                );
              if (col.id === "model") return <code class="text-[10px]">{row.modelProfileId ?? t().unknown}</code>;
              if (col.id === "reason")
                return (
                  <div class="max-w-80 text-xs">
                    <div>{row.reasons.map((reason) => feedbackReasonLabels()[reason] ?? reason).join(", ") || t().commentOnly}</div>
                    {row.comment ? (
                      <div class="truncate text-dimmed" title={row.comment}>
                        {row.comment}
                      </div>
                    ) : null}
                  </div>
                );
              if (col.id === "when")
                return <span class="whitespace-nowrap text-xs text-dimmed">{formatDateTime(row.updatedAt, dateContext())}</span>;
              return render(value);
            }}
          />
        </DataPanel>
      </div>
    </SettingsPage>
  );
}
