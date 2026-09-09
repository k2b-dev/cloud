import { navigateTo } from "@k2b/ssr/nav";
import { createSignal, For, Show } from "solid-js";
import {
  FilterChip,
  Button,
  ButtonLink,
  CopyButton,
  Disclosure,
  DataPanel,
  DataTable,
  type DataTableColumn,
  dialogCore,
  PanelDialog,
  panelDialogWideOptions,
  Pagination,
  Select,
  SettingsPage,
  StatCell,
  StatGrid,
  TextInput,
  useLocale,
} from "@k2b/ui";
import type { AiUsageFeedback, AiUsageGroup, AiUsagePage, AiUsageReport, AiUsageRun, AiUsageStats } from "@k2b/cloud/ai/admin";
import {
  aiUsageHref,
  AiUsageQuerySchema,
  AI_USAGE_RANGES,
  AI_USAGE_REASONS,
  AI_USAGE_VIEWS,
  type AiUsageQuery,
  formatDateTime,
  formatDurationMs,
  formatNumber,
  formatPercent,
} from "@k2b/cloud/shared";
import { coreClient } from "@k2b/cloud/clients/core";
import { aiUsageMessages } from "./ai-usage-messages";
import AiUsageCharts from "./AiUsageCharts";

export default function AiUsageExplorer(props: { report: AiUsageReport }) {
  const locale = useLocale();
  const t = () => aiUsageMessages.resolve([locale()]).t;
  const report = () => props.report;
  const q = () => report().query;
  const [draft, setDraft] = createSignal(q());
  const [comparison, setComparison] = createSignal<"users" | "models">("users");
  const n = (value: number | null) => formatNumber(value, { locale: locale(), decimals: 0 });
  const credits = (value: number | null) => formatNumber(value, { locale: locale(), decimals: 4 });
  const percent = (part: number, total: number) => (total ? formatPercent(part / total, { locale: locale() }) : "—");
  const date = (value: string) => formatDateTime(value, { locale: locale() });
  const duration = (value: number | null) => formatDurationMs(value, { locale: locale() });
  const change = (key: keyof AiUsageQuery, value: string | undefined) =>
    navigateTo(aiUsageHref(AiUsageQuerySchema.parse({ ...q(), [key]: value, page: 1 })));
  const href = (patch: Partial<AiUsageQuery>) => aiUsageHref({ ...q(), page: 1, ...patch });
  const runHref = (patch: Partial<AiUsageQuery>) =>
    href({ view: "runs", kind: undefined, status: undefined, task: undefined, errorCode: undefined, search: undefined, ...patch });
  const views = () => ({ overview: t().overviewTab, comparisons: t().comparisonsTab, feedback: t().feedback, runs: t().runsTab });
  const reasons = () => ({
    incorrect: t().incorrect,
    did_not_follow_request: t().didNotFollowRequest,
    incomplete: t().incomplete,
    poor_tool_choice: t().poorToolChoice,
    too_slow: t().tooSlow,
    other: t().other,
  });
  const statuses = () => ({
    completed: t().completed,
    failed: t().failed,
    aborted: t().aborted,
    queued: t().queued,
    running: t().running,
    waiting_for_action: t().waiting,
    pending: t().waiting,
    rejected: t().rejected,
    waiting_for_approval: t().waiting,
    waiting_for_frontend: t().waiting,
  });
  const status = (value: string) => Object.entries(statuses()).find(([key]) => key === value)?.[1] ?? value;
  const kindLabel = (kind: AiUsageRun["kind"]) =>
    kind === "chat" ? t().chatRuns : kind === "background" ? t().backgroundAi : t().toolRuns;
  const chip = (key: keyof AiUsageQuery, label: string, icon: string, options: { value: string; label: string }[], fallback = "") => (
    <FilterChip
      position="bottom-right"
      label={label}
      icon={icon}
      options={[{ options }]}
      value={[String(q()[key] ?? fallback)]}
      defaultValue={[fallback]}
      isActive={String(q()[key] ?? fallback) !== fallback}
      onValueChange={(values) => change(key, values[0] || fallback || undefined)}
    />
  );
  const facets = (field: "userId" | "modelProfileId" | "providerModel" | "appId" | "task", label: string) => (
    <Select
      class={`ai-usage-filter ${q()[field] ? "ai-usage-filter--active" : ""}`}
      aria-label={label}
      value={() => q()[field] ?? null}
      placeholder={label}
      clearable
      searchable
      selectedLabel={() =>
        field === "userId"
          ? q()[field] === "unassigned"
            ? t().unassigned
            : (report().users.items.find((row) => row.id === q()[field])?.label ?? undefined)
          : q()[field]
      }
      onValueChange={(value) => change(field, value ?? undefined)}
      loadOptions={async (search, signal) => {
        const response = await coreClient.admin.core["ai-usage"].facets.$get(
          { query: { field, search, range: q().range, until: q().until } },
          { init: { signal } },
        );
        if (!response.ok) throw new Error(t().filterLoadFailed);
        const data = await response.json();
        return [
          ...(field === "userId" && !search ? [{ value: "unassigned", label: t().unassigned }] : []),
          ...data.items.map((item) => ({ value: item.id, label: item.label })),
        ];
      }}
    />
  );
  const footer = <T,>(page: AiUsagePage<T>) => (
    <div class="flex flex-wrap items-center justify-between gap-2">
      <span class="text-xs text-dimmed">{t().shownOfTotal({ shown: n(page.items.length), total: n(page.total) })}</span>
      <Pagination
        currentPage={page.page}
        totalPages={Math.ceil(page.total / page.perPage)}
        baseUrl={`${aiUsageHref({ ...q(), page: undefined })}&page=`}
      />
    </div>
  );
  const details = (title: string, fields: { label: string; value: string | null | undefined }[]) =>
    dialogCore.open<void>(
      (close) => (
        <PanelDialog>
          <PanelDialog.Header title={title} icon="ti ti-file-search" close={close} />
          <PanelDialog.Body>
            <dl class="grid gap-x-6 gap-y-4 sm:grid-cols-2">
              <For each={fields.filter((field) => field.value !== null && field.value !== undefined)}>
                {(field) => (
                  <div class={field.label === t().error || field.label === t().comment ? "min-w-0 sm:col-span-2" : "min-w-0"}>
                    <dt class="text-xs text-dimmed">{field.label}</dt>
                    <dd class="m-0 whitespace-pre-wrap break-words text-sm">{field.value}</dd>
                  </div>
                )}
              </For>
            </dl>
          </PanelDialog.Body>
          <PanelDialog.Footer>
            <CopyButton
              value={fields
                .filter((f) => f.value != null)
                .map((f) => `${f.label}: ${f.value}`)
                .join("\n\n")}
              label={t().copyDetails}
            />
          </PanelDialog.Footer>
        </PanelDialog>
      ),
      panelDialogWideOptions,
    );
  const openRun = (row: AiUsageRun) =>
    details(row.task, [
      { label: t().error, value: row.error ?? (row.status === "failed" ? t().noStoredError : null) },
      { label: t().errorCode, value: row.errorCode },
      { label: t().status, value: status(row.status) },
      { label: t().received, value: date(row.createdAt) },
      { label: t().user, value: row.userLabel ?? row.userId ?? t().unassigned },
      { label: t().model, value: row.modelProfileId },
      { label: t().providerModel, value: row.providerModel },
      { label: t().application, value: row.appId },
      { label: t().runId, value: row.id },
      { label: t().conversationId, value: row.conversationId },
      { label: t().turnId, value: row.turnId },
      { label: t().workflowRunId, value: row.workflowRunId },
      { label: t().traceId, value: row.traceId },
      { label: t().tokens, value: n(row.tokens) },
      { label: t().credits, value: credits(row.credits) },
      { label: t().averageDuration, value: duration(row.durationMs) },
      { label: t().attempts, value: row.attempts === null ? null : n(row.attempts) },
    ]);
  const openFeedback = (row: AiUsageFeedback) =>
    details(t().feedback, [
      { label: t().rating, value: row.rating === "up" ? t().helpful : t().needsWork },
      {
        label: t().reason,
        value: row.reasons.map((reason) => Object.entries(reasons()).find(([key]) => key === reason)?.[1] ?? reason).join(", "),
      },
      { label: t().comment, value: row.comment },
      { label: t().user, value: row.userLabel ?? row.userId ?? t().unassigned },
      { label: t().model, value: row.modelProfileId },
      { label: t().providerModel, value: row.providerModel },
      { label: t().message, value: row.conversationTitle },
      { label: t().conversationId, value: row.conversationId },
      { label: t().messageId, value: row.id },
      { label: t().responseCreated, value: date(row.createdAt) },
      { label: t().ratingUpdated, value: date(row.updatedAt) },
    ]);
  const stats = (value: AiUsageStats) => (
    <StatGrid columns={4}>
      <StatCell label={t().runs} value={n(value.runs)} sub={`${n(value.failed)} ${t().errors}`} />
      <StatCell
        label={t().tokens}
        value={n(value.tokens)}
        sub={`${formatPercent(value.tokenCoverage, { locale: locale() })} ${t().measured}`}
      />
      <StatCell
        label={t().credits}
        value={credits(value.credits)}
        sub={`${formatPercent(value.creditsCoverage, { locale: locale() })} ${t().measured}`}
      />
      <StatCell
        label={t().negativeFeedback}
        value={`${n(value.negative)} / ${n(value.rated)}`}
        sub={`${percent(value.negative, value.rated)} · ${t().feedbackCoverage}: ${percent(value.rated, value.assistantMessages)}`}
      />
    </StatGrid>
  );
  const groupTable = (dimension: "users" | "models" | "tasks" | "apps" | "capabilities", title: string) => {
    const columns: DataTableColumn<AiUsageGroup>[] = [
      { id: "name", header: title, value: (row) => row.label ?? row.id ?? t().unassigned },
      { id: "runs", header: t().runs, value: (row) => row.runs, align: "right" },
      { id: "tokens", header: t().tokens, value: (row) => row.tokens, align: "right" },
      { id: "credits", header: t().credits, value: (row) => row.credits, align: "right" },
      { id: "failed", header: t().errors, value: (row) => row.failed, align: "right" },
      { id: "feedback", header: t().feedback, value: (row) => row.negative, align: "right" },
    ];
    const patch = (row: AiUsageGroup): Partial<AiUsageQuery> =>
      dimension === "users"
        ? { userId: row.id ?? "unassigned" }
        : dimension === "models"
          ? { modelProfileId: row.id ?? undefined, providerModel: row.providerModel ?? undefined }
          : dimension === "tasks" || dimension === "capabilities"
            ? { task: row.id ?? undefined, view: "runs", kind: dimension === "capabilities" ? "tool" : undefined }
            : { appId: row.id ?? undefined };
    const linkable = (row: AiUsageGroup) =>
      dimension === "users" || (row.id !== null && (dimension !== "models" || row.providerModel !== null));
    return (
      <DataPanel title={title} footer={footer(report()[dimension])} class="min-w-0">
        <DataTable
          rows={report()[dimension].items}
          columns={columns}
          getRowId={(row) => `${row.id}:${row.providerModel ?? ""}`}
          density="compact"
          class="overflow-x-auto"
          empty={t().noResults}
          renderCell={({ row, col, value, render }) => {
            if (col.id === "name")
              return (
                <div>
                  <Show when={linkable(row)} fallback={row.label ?? row.id ?? t().unassigned}>
                    <ButtonLink variant="text" size="sm" href={href(patch(row))}>
                      {row.label ?? row.id ?? t().unassigned}
                    </ButtonLink>
                  </Show>
                  <Show when={row.providerModel}>
                    <div class="text-xs text-dimmed">{row.providerModel}</div>
                  </Show>
                  <div class="text-xs text-dimmed">
                    {t().averageDuration}: {duration(row.avgDurationMs)} · p95 {duration(row.p95DurationMs)}
                    <Show when={dimension === "models"}>
                      {" "}
                      · {n(row.avgOutputTokensPerSecond)} tok/s · {n(row.switchesAway)} {t().switchedAway}
                    </Show>
                    <Show when={dimension === "users"}>
                      {" "}
                      · {n(row.capabilities)} {t().capabilities}
                    </Show>
                  </div>
                </div>
              );
            if (col.id === "tokens")
              return <span title={`${formatPercent(row.tokenCoverage, { locale: locale() })} ${t().measured}`}>{n(row.tokens)}</span>;
            if (col.id === "credits")
              return (
                <span title={`${formatPercent(row.creditsCoverage, { locale: locale() })} ${t().measured}`}>{credits(row.credits)}</span>
              );
            if (col.id === "failed")
              return (
                <Show when={linkable(row)} fallback={n(row.failed)}>
                  <ButtonLink variant="text" size="sm" href={runHref({ ...patch(row), view: "runs", status: "failed" })}>
                    {n(row.failed)} · {percent(row.failed, row.runs)}
                  </ButtonLink>
                </Show>
              );
            if (col.id === "feedback" && (!linkable(row) || dimension === "capabilities" || dimension === "tasks"))
              return row.rated ? `${n(row.negative)} / ${n(row.rated)}` : "—";
            if (col.id === "feedback")
              return (
                <div>
                  <ButtonLink variant="text" size="sm" href={href({ ...patch(row), view: "feedback", rating: "down" })}>
                    {n(row.negative)} / {n(row.rated)} · {percent(row.negative, row.rated)} {t().negative}
                  </ButtonLink>
                  <div class="text-xs text-dimmed">
                    {n(row.positive)} {t().positive} · {t().feedbackCoverage}: {percent(row.rated, row.assistantMessages)}
                  </div>
                </div>
              );
            return render(value);
          }}
        />
      </DataPanel>
    );
  };
  const runColumns: DataTableColumn<AiUsageRun>[] = [
    { id: "task", header: t().backgroundTask, value: (row) => row.task },
    { id: "status", header: t().status, value: (row) => row.status },
    { id: "model", header: t().model, value: (row) => row.modelProfileId },
    { id: "user", header: t().user, value: (row) => row.userLabel },
    { id: "when", header: t().received, value: (row) => row.createdAt },
    { id: "details", header: t().details, value: (row) => row.error },
  ];
  const feedbackColumns: DataTableColumn<AiUsageFeedback>[] = [
    { id: "rating", header: t().rating, value: (row) => row.rating },
    { id: "user", header: t().user, value: (row) => row.userLabel },
    { id: "model", header: t().model, value: (row) => row.modelProfileId },
    { id: "reason", header: t().reason, value: (row) => row.reasons.join(", ") },
    { id: "comment", header: t().comment, value: (row) => row.comment },
    { id: "details", header: t().details, value: (row) => row.id },
  ];
  return (
    <SettingsPage
      class="ai-usage-page"
      title={t().title}
      subtitle={t().description}
      icon="ti ti-chart-histogram"
      scrollPreserveKey="admin-ai-usage"
    >
      <nav class="flex flex-wrap gap-2" aria-label={t().views}>
        <For each={AI_USAGE_VIEWS}>
          {(view) => (
            <ButtonLink
              size="sm"
              variant={q().view === view ? "primary" : "secondary"}
              aria-current={q().view === view ? "page" : undefined}
              href={href({ view })}
            >
              {views()[view]}
            </ButtonLink>
          )}
        </For>
      </nav>
      <div class="flex flex-col gap-2">
        <Show when={q().view === "runs"}>
          <form
            class="flex flex-wrap gap-2"
            role="search"
            onSubmit={(event) => {
              event.preventDefault();
              navigateTo(href({ search: draft().search || undefined, errorCode: draft().errorCode || undefined }));
            }}
          >
            <TextInput
              class="min-w-48 flex-1"
              type="search"
              icon="ti ti-search"
              maxLength={200}
              aria-label={t().searchErrors}
              placeholder={t().searchErrors}
              value={() => draft().search ?? ""}
              onValueChange={(value) => setDraft((prev) => ({ ...prev, search: value }))}
              clearable
              onClear={() => navigateTo(href({ search: undefined }))}
            />
            <TextInput
              class="w-48"
              type="search"
              maxLength={200}
              aria-label={t().errorCode}
              placeholder={t().errorCode}
              value={() => draft().errorCode ?? ""}
              onValueChange={(value) => setDraft((prev) => ({ ...prev, errorCode: value }))}
              clearable
              onClear={() => navigateTo(href({ errorCode: undefined }))}
            />
            <button type="submit" class="hidden">
              {t().applyFilters}
            </button>
          </form>
        </Show>
        <div class="flex flex-wrap items-center gap-2">
          {chip(
            "range",
            t().range,
            "ti ti-calendar",
            AI_USAGE_RANGES.map((value) => ({ value, label: value })),
            "30d",
          )}
          {facets("userId", t().user)}
          {facets("modelProfileId", t().model)}
          {facets("providerModel", t().providerModel)}
          {facets("appId", t().application)}
          <Show when={q().view === "comparisons"}>
            {chip(
              "sort",
              t().sort,
              "ti ti-sort-descending",
              [
                { value: "runs", label: t().runs },
                { value: "tokens", label: t().tokens },
                { value: "credits", label: t().credits },
                { value: "errors", label: t().errors },
                { value: "negative", label: t().negativeFeedback },
                { value: "negativeRate", label: t().negativeRate },
              ],
              "runs",
            )}
          </Show>
          <Show when={q().view === "feedback"}>
            {chip("rating", t().rating, "ti ti-thumb-up", [
              { value: "", label: t().all },
              { value: "up", label: t().helpful },
              { value: "down", label: t().needsWork },
            ])}
            {chip("reason", t().reason, "ti ti-message", [
              { value: "", label: t().all },
              ...AI_USAGE_REASONS.map((value) => ({ value, label: reasons()[value] })),
            ])}
          </Show>
          <Show when={q().view === "runs"}>
            {chip("kind", t().runKind, "ti ti-category", [
              { value: "", label: t().all },
              ...(["chat", "background", "tool"] as const).map((value) => ({ value, label: kindLabel(value) })),
            ])}
            {chip("status", t().status, "ti ti-activity", [
              { value: "", label: t().all },
              ...Object.entries(statuses()).map(([value, label]) => ({ value, label })),
            ])}
            {facets("task", t().backgroundTask)}
          </Show>
          <div class="ml-auto flex shrink-0 items-center gap-2">
            <ButtonLink size="sm" variant="text" href={aiUsageHref({ view: q().view, range: q().range })}>
              {t().resetFilters}
            </ButtonLink>
            <ButtonLink size="sm" variant="secondary" href={href({ until: undefined })}>
              <i class="ti ti-refresh" aria-hidden="true" />
              {t().refresh}
            </ButtonLink>
          </div>
        </div>
      </div>
      <Disclosure summary={t().dataNotes}>
        <div class="ai-usage-note flex flex-col gap-2 text-xs text-dimmed">
          <p class="m-0">
            {t().periodHelp} {date(report().since)} – {date(report().until)}
          </p>
          <Show when={report().unassignedBackgroundRuns > 0}>
            <p class="m-0">{t().unassignedHelp({ count: n(report().unassignedBackgroundRuns) })}</p>
            <div>
              <ButtonLink size="xs" variant="text" href={runHref({ kind: "background", userId: "unassigned" })}>
                {t().showUnassigned}
              </ButtonLink>
            </div>
          </Show>
        </div>
      </Disclosure>
      <Show when={q().view === "overview"}>
        <p class="text-xs text-dimmed">{t().totalsHelp}</p>
        {stats(report().overview)}
        <div class="grid gap-3 lg:grid-cols-3">
          <For each={["chat", "background", "tool"] as const}>
            {(kind) => (
              <DataPanel title={kindLabel(kind)}>
                <div class="ai-usage-summary flex flex-wrap items-center gap-2 p-3 text-xs font-normal">
                  <span>
                    {n(report()[kind].runs)} {t().runs}
                  </span>
                  <ButtonLink variant="text" size="sm" href={runHref({ kind, status: "failed" })}>
                    {n(report()[kind].failed)} {t().errors}
                  </ButtonLink>
                </div>
              </DataPanel>
            )}
          </For>
        </div>
        <AiUsageCharts timeline={report().timeline} range={q().range} />
        <Disclosure summary={t().additionalStatistics}>
          {groupTable("apps", t().application)}
          <DataPanel title={t().launchedByApps} footer={footer(report().launches)}>
            <DataTable
              rows={report().launches.items}
              columns={[
                { id: "app", header: t().application, value: (row) => row.appId },
                { id: "chats", header: t().chats, value: (row) => row.chats },
                { id: "users", header: t().users, value: (row) => row.users },
              ]}
              getRowId={(row) => row.appId}
              empty={t().noResults}
            />
          </DataPanel>
          {groupTable("capabilities", t().capabilities)}
        </Disclosure>
      </Show>
      <Show when={q().view === "comparisons"}>
        <p class="text-xs text-dimmed">{t().comparisonHelp}</p>
        <div class="flex gap-2">
          <Button
            size="sm"
            variant={comparison() === "users" ? "primary" : "secondary"}
            aria-pressed={comparison() === "users"}
            onClick={() => setComparison("users")}
          >
            {t().usersTitle}
          </Button>
          <Button
            size="sm"
            variant={comparison() === "models" ? "primary" : "secondary"}
            aria-pressed={comparison() === "models"}
            onClick={() => setComparison("models")}
          >
            {t().models}
          </Button>
        </div>
        {groupTable(comparison(), comparison() === "users" ? t().usersTitle : t().models)}
      </Show>
      <Show when={q().view === "feedback"}>
        {stats(report().chat)}
        <p class="text-xs text-dimmed">{t().feedbackHelp}</p>
        <DataPanel title={t().feedback} footer={footer(report().feedback)}>
          <DataTable
            rows={report().feedback.items}
            columns={feedbackColumns}
            getRowId={(row) => row.id}
            class="overflow-x-auto"
            empty={t().noResults}
            renderCell={({ row, col, value, render }) => {
              if (col.id === "rating") return row.rating === "up" ? t().helpful : t().needsWork;
              if (col.id === "user")
                return (
                  <ButtonLink size="sm" variant="text" href={href({ userId: row.userId ?? "unassigned" })}>
                    {row.userLabel ?? t().unassigned}
                  </ButtonLink>
                );
              if (col.id === "model")
                return (
                  <ButtonLink
                    size="sm"
                    variant="text"
                    href={href({ modelProfileId: row.modelProfileId ?? undefined, providerModel: row.providerModel ?? undefined })}
                  >
                    {row.modelProfileId ?? t().unknown}
                  </ButtonLink>
                );
              if (col.id === "reason")
                return row.reasons.map((reason) => Object.entries(reasons()).find(([key]) => key === reason)?.[1] ?? reason).join(", ");
              if (col.id === "comment") return <span class="line-clamp-2 max-w-64">{row.comment}</span>;
              if (col.id === "details")
                return (
                  <Button size="sm" variant="secondary" onClick={() => openFeedback(row)}>
                    {t().details}
                  </Button>
                );
              return render(value);
            }}
          />
        </DataPanel>
      </Show>
      <Show when={q().view === "runs"}>
        <p class="text-xs text-dimmed">{t().runsHelp}</p>
        <DataPanel title={t().runsTab} footer={footer(report().runs)}>
          <DataTable
            rows={report().runs.items}
            columns={runColumns}
            getRowId={(row) => `${row.kind}:${row.id}`}
            class="overflow-x-auto"
            empty={t().noResults}
            renderCell={({ row, col, value, render }) => {
              if (col.id === "task")
                return (
                  <div class="max-w-72">
                    <ButtonLink size="sm" variant="text" href={href({ task: row.task, kind: row.kind })}>
                      {row.task}
                    </ButtonLink>
                    <div class="text-xs text-dimmed">
                      {kindLabel(row.kind)} · {row.appId ?? t().unassigned}
                    </div>
                    <Show when={row.error}>
                      <div class="line-clamp-2 text-xs text-red-500">{row.error}</div>
                    </Show>
                  </div>
                );
              if (col.id === "status")
                return <span class={row.status === "failed" ? "text-red-500" : "text-dimmed"}>{status(row.status)}</span>;
              if (col.id === "model")
                return (
                  <div>
                    {row.modelProfileId ?? t().unknown}
                    <div class="text-xs text-dimmed">{row.providerModel}</div>
                  </div>
                );
              if (col.id === "user") return row.userLabel ?? row.userId ?? t().unassigned;
              if (col.id === "when") return <span class="whitespace-nowrap text-xs">{date(row.createdAt)}</span>;
              if (col.id === "details")
                return (
                  <Button size="sm" variant="secondary" onClick={() => openRun(row)}>
                    {row.status === "failed" ? t().showError : t().details}
                  </Button>
                );
              return render(value);
            }}
          />
        </DataPanel>
      </Show>
    </SettingsPage>
  );
}
