import { mutation as mutations } from "@k2b/stdlib/solid";
import {
  Button,
  DataTable,
  type DataTableColumn,
  dialogCore,
  FilterChip,
  type FilterChipSection,
  NoticeCard,
  PanelDialog,
  Placeholder,
  panelDialogWorkspaceOptions,
  prompts,
  StatCell,
  StatGrid,
  StatusBadge,
  Tag,
  useLocale,
} from "@k2b/ui";
import type { WorkflowJsonValue } from "@valentinkolb/cloud/workflows";
import { createEffect, createMemo, createSignal, For, lazy, onCleanup, onMount, Show, Suspense } from "solid-js";
import type { z } from "zod";
import { apiClient } from "../../../api/client";
import type { PublicTable } from "../../../api/public-dto";
import {
  PublicGridsWorkflowEmailDeliveryListSchema,
  PublicGridsWorkflowLauncherListSchema,
  PublicGridsWorkflowRunListSchema,
  PublicGridsWorkflowRunStatsSchema,
  PublicWorkflowInvocationReceiptSchema,
  PublicWorkflowTriggerRuntimeStateSchema,
} from "../../../api/workflow-public-contracts";
import { scannerLauncherPromptInputSources } from "../../../workflows/contracts";
import { errorMessage } from "../utils/api-helpers";
import type {
  PublicWorkflow,
  PublicWorkflowLauncher,
  PublicWorkflowRun,
  PublicWorkflowRunStats,
  PublicWorkflowTriggerRuntimeState,
  PublicWorkspaceWorkflowOverview,
} from "../workspace/workspace-public-state-model";
import { workflowMessages } from "./messages";
import { WorkflowAutomaticTriggerState } from "./WorkflowAutomaticTriggerState";
import { WorkflowEditor } from "./WorkflowEditor";
import { WorkflowLauncherManager } from "./WorkflowLauncherManager";
import { WorkflowRevisionHistory } from "./WorkflowRevisionHistory";
import { requestWorkflowRunInput } from "./WorkflowRunInputDialog";
import type { WorkflowScannerState } from "./WorkflowScannerSurface";
import {
  formatWorkflowRunDate as formatDate,
  formatWorkflowRunDuration as formatDuration,
  isTerminalWorkflowRunStatus,
  workflowChannelLabel,
  workflowRunStatusLabel,
  workflowRunStatusTone,
} from "./workflow-display";
import { reconcileWorkflowRunList, type WorkflowRunListFilter } from "./workflow-run-list";
import {
  parseWorkflowUrlState,
  type WorkflowRunChannelFilter,
  type WorkflowRunStatusFilter,
  type WorkflowUrlState,
  workflowUrlStateHref,
} from "./workflow-url-state";

const WorkflowScannerSurface = lazy(() => import("./WorkflowScannerSurface"));

type WorkflowRunStatsWindow = PublicWorkflowRunStats["window"];

type Props = {
  baseId: string;
  tables: PublicTable[];
  activeWorkflow: PublicWorkflow | null;
  selectedRunId: string | null;
  runUpdate: PublicWorkflowRun | null;
  canCreateWorkflows: boolean;
  canRunActiveWorkflow: boolean;
  canManageActiveWorkflow: boolean;
  editMode: boolean;
  initialOverview: PublicWorkspaceWorkflowOverview;
  onWorkflowChanged: () => void;
  onSelectRun: (runId: string | null) => void;
};

type WorkflowRunPage = {
  items: PublicWorkflowRun[];
  nextCursor?: string | null;
};

type WorkflowEmailDeliveryPage = z.infer<typeof PublicGridsWorkflowEmailDeliveryListSchema>;
type WorkflowEmailDelivery = WorkflowEmailDeliveryPage["items"][number];

type WorkflowsPageApi = {
  "by-base": {
    ":baseId": {
      "run-stats": {
        $get: (input: { param: { baseId: string }; query: { window: string } }, options?: { init?: RequestInit }) => Promise<Response>;
      };
      runs: {
        $get: (input: { param: { baseId: string }; query: Record<string, string> }, options?: { init?: RequestInit }) => Promise<Response>;
      };
      "email-deliveries": {
        $get: (input: { param: { baseId: string }; query: Record<string, string> }, options?: { init?: RequestInit }) => Promise<Response>;
      };
    };
  };
  ":workflowId": {
    launchers: { $get: (input: { param: { workflowId: string } }, options?: { init?: RequestInit }) => Promise<Response> };
    "trigger-state": { $get: (input: { param: { workflowId: string } }, options?: { init?: RequestInit }) => Promise<Response> };
    invoke: {
      manual: {
        $post: (input: { param: { workflowId: string }; json: unknown }, options?: { init?: RequestInit }) => Promise<Response>;
      };
    };
  };
};

const workflowsPageApi = apiClient.workflows as unknown as WorkflowsPageApi;

const statsWindowLabel = (value: WorkflowRunStatsWindow, locale: string): string => {
  const t = workflowMessages.resolve([locale]).t;
  return { "10m": t.tenMinutes, "1h": t.oneHour, "12h": t.twelveHours, "24h": t.twentyFourHours, "7d": t.sevenDays, "30d": t.thirtyDays }[
    value
  ];
};

type WorkflowLoadArea = "stats" | "runs" | "launchers" | "triggers";

const formatMetricDuration = (ms: number | null, locale: string): string => {
  if (ms === null) return "-";
  const format = (value: number, maximumFractionDigits = 0) => new Intl.NumberFormat(locale, { maximumFractionDigits }).format(value);
  if (ms < 1000) return `${format(ms)}ms`;
  if (ms < 60_000) return `${format(ms / 1000, ms < 10_000 ? 1 : 0)}s`;
  return `${format(ms / 60_000)}m`;
};

const formatPercent = (value: number, locale: string): string =>
  new Intl.NumberFormat(locale, {
    style: "percent",
    maximumFractionDigits: value >= 10 ? 0 : 1,
  }).format(value / 100);

const triggerSummary = (workflow: PublicWorkflow, locale: string): string => {
  const t = workflowMessages.resolve([locale]).t;
  const triggers = workflow.plan.triggers.map((trigger) => trigger.kind);
  if (triggers.length === 0) return t.noAutomaticTrigger;
  return triggers.map((trigger) => (trigger === "recordEvent" ? t.recordEvent : t.schedule)).join(", ");
};

function EmailDeliveryTable(props: {
  deliveries: WorkflowEmailDelivery[];
  loading?: boolean;
  nextCursor?: string | null;
  onLoadMore?: () => void;
}) {
  const locale = useLocale();
  const t = () => workflowMessages.resolve([locale()]).t;
  const recipients = (delivery: WorkflowEmailDelivery) =>
    delivery.recipients.map((recipient) => `${recipient.kind}:${recipient.recipient}`).join(", ") || "-";
  const columns = createMemo<DataTableColumn<WorkflowEmailDelivery>[]>(() => [
    { id: "status", header: t().status, value: (delivery) => delivery.status },
    { id: "subject", header: t().subject, value: (delivery) => delivery.subject, cellClass: "max-w-72" },
    { id: "recipients", header: t().recipients, value: recipients, cellClass: "max-w-72" },
    { id: "sent", header: t().sent, value: (delivery) => delivery.createdAt, cellClass: "whitespace-nowrap" },
  ]);
  return (
    <section class="flex min-h-0 flex-1 flex-col">
      <DataTable
        ariaLabel={t().workflowEmailDeliveries}
        rows={props.deliveries}
        columns={columns()}
        getRowId={(delivery) =>
          [delivery.createdAt, delivery.workflowRunId ?? "", delivery.templateId ?? "", delivery.subject ?? ""].join(":")
        }
        density="compact"
        highlightColumns={false}
        class="paper min-h-[20rem] flex-1 overflow-auto"
        hasMore={!!props.nextCursor}
        loadingMore={props.loading}
        onLoadMore={props.onLoadMore}
        empty={props.loading ? t().loadingEmailDeliveries : t().noWorkflowEmails}
        renderCell={({ row: delivery, col, render, value }) => {
          if (col.id === "status") {
            return (
              <span class="flex min-w-0 flex-col items-start gap-1">
                <StatusBadge
                  tone={delivery.status === "failed" ? "error" : "ok"}
                  label={delivery.status === "failed" ? t().failed : t().sent}
                />
                <Show when={delivery.error}>
                  {(error) => <span class="block max-w-48 truncate text-red-600 dark:text-red-400">{error()}</span>}
                </Show>
              </span>
            );
          }
          if (col.id === "sent") return <span class="text-dimmed">{formatDate(delivery.createdAt, locale())}</span>;
          if (col.id === "recipients") return <span class="text-dimmed">{recipients(delivery)}</span>;
          return render(value);
        }}
      />
    </section>
  );
}

export default function WorkflowsPage(props: Props) {
  const locale = useLocale();
  const t = () => workflowMessages.resolve([locale()]).t;
  const statsWindowOptions = createMemo<FilterChipSection[]>(() => [
    {
      options: (["10m", "1h", "12h", "24h", "7d", "30d"] as WorkflowRunStatsWindow[]).map((value) => ({
        value,
        label: statsWindowLabel(value, locale()),
        icon: "ti ti-clock",
      })),
    },
  ]);
  const runStatusOptions = createMemo<FilterChipSection[]>(() => [
    {
      options: [
        { value: "all", label: t().allStatuses, icon: "ti ti-list" },
        { value: "queued", label: t().queued, icon: "ti ti-clock" },
        { value: "running", label: t().running, icon: "ti ti-loader" },
        { value: "waiting", label: t().waitingStatus, icon: "ti ti-hourglass" },
        { value: "succeeded", label: t().succeeded, icon: "ti ti-circle-check" },
        { value: "failed", label: t().failed, icon: "ti ti-alert-circle" },
        { value: "needs_attention", label: t().needsAttention, icon: "ti ti-alert-triangle" },
        { value: "canceled", label: t().canceled, icon: "ti ti-ban" },
      ],
    },
  ]);
  const runChannelOptions = createMemo<FilterChipSection[]>(() => [
    {
      options: [
        { value: "all", label: t().allChannels, icon: "ti ti-list" },
        ...(["api", "customApp", "scanner", "bulk", "record", "schedule", "recordEvent"] as PublicWorkflowRun["channel"][]).map(
          (value) => ({ value, label: workflowChannelLabel(value, locale()), icon: "ti ti-route" }),
        ),
      ],
    },
  ]);
  const [statsWindow, setStatsWindow] = createSignal<WorkflowRunStatsWindow>(props.initialOverview.filters.window);
  const [runStatus, setRunStatus] = createSignal<WorkflowRunStatusFilter>(props.initialOverview.filters.status);
  const [runChannel, setRunChannel] = createSignal<WorkflowRunChannelFilter>(props.initialOverview.filters.channel);
  const [launchers, setLaunchers] = createSignal<PublicWorkflowLauncher[]>(props.initialOverview.launchers);
  const [triggerState, setTriggerState] = createSignal<PublicWorkflowTriggerRuntimeState | null>(props.initialOverview.triggerState);
  const [stats, setStats] = createSignal<PublicWorkflowRunStats | null>(props.initialOverview.stats);
  const [runs, setRuns] = createSignal<PublicWorkflowRun[]>(props.initialOverview.runs.items);
  const [nextCursor, setNextCursor] = createSignal<string | null>(props.initialOverview.runs.nextCursor);
  const [emailDeliveries, setEmailDeliveries] = createSignal<WorkflowEmailDelivery[]>([]);
  const [nextEmailCursor, setNextEmailCursor] = createSignal<string | null>(null);
  const [emailLoadError, setEmailLoadError] = createSignal<string | null>(null);
  const [emailActivityOpen, setEmailActivityOpen] = createSignal(false);
  const [loadErrors, setLoadErrors] = createSignal<Partial<Record<WorkflowLoadArea, string>>>({});

  const activeStats = createMemo(() => {
    const workflow = props.activeWorkflow;
    return workflow ? (stats()?.byWorkflow.find((row) => row.workflowId === workflow.id) ?? null) : null;
  });
  const loadError = createMemo(() => Object.values(loadErrors())[0] ?? null);
  const setLoadFailure = (area: WorkflowLoadArea, message?: string) => {
    setLoadErrors((current) => {
      const next = { ...current };
      if (message) next[area] = message;
      else delete next[area];
      return next;
    });
  };
  const currentRunFilter = (): WorkflowRunListFilter => {
    const status = runStatus();
    const channel = runChannel();
    return {
      workflowId: props.activeWorkflow?.id ?? null,
      status: status === "all" ? null : status,
      channel: channel === "all" ? null : channel,
    };
  };

  const statsMut = mutations.create<void, void>({
    mutation: async (_, { abortSignal }) => {
      const res = await workflowsPageApi["by-base"][":baseId"]["run-stats"].$get(
        { param: { baseId: props.baseId }, query: { window: statsWindow() } },
        { init: { signal: abortSignal } },
      );
      if (!res.ok) throw new Error(await errorMessage(res, t().loadStatsFailed));
      setStats(PublicGridsWorkflowRunStatsSchema.parse(await res.json()));
    },
    onSuccess: () => setLoadFailure("stats"),
    onError: (error) => setLoadFailure("stats", error.message),
  });

  const fetchRuns = async (cursor?: string | null, signal?: AbortSignal): Promise<WorkflowRunPage> => {
    const res = await workflowsPageApi["by-base"][":baseId"].runs.$get(
      {
        param: { baseId: props.baseId },
        query: {
          limit: "50",
          ...(props.activeWorkflow ? { workflowId: props.activeWorkflow.id } : {}),
          ...(runStatus() !== "all" ? { status: runStatus() } : {}),
          ...(runChannel() !== "all" ? { channel: runChannel() } : {}),
          ...(cursor ? { cursor } : {}),
        },
      },
      { init: { signal } },
    );
    if (!res.ok) throw new Error(await errorMessage(res, t().loadRunsFailed));
    return PublicGridsWorkflowRunListSchema.parse(await res.json());
  };

  const runsMut = mutations.create<WorkflowRunPage, void>({
    mutation: async (_, { abortSignal }) => {
      return fetchRuns(null, abortSignal);
    },
    onSuccess: (page) => {
      setRuns(reconcileWorkflowRunList(page.items, props.runUpdate, currentRunFilter(), true));
      setNextCursor(page.nextCursor ?? null);
      setLoadFailure("runs");
    },
    onError: (error) => setLoadFailure("runs", error.message),
  });

  const loadMoreRunsMut = mutations.create<WorkflowRunPage | null, void>({
    mutation: async (_, { abortSignal }) => {
      const cursor = nextCursor();
      return cursor ? fetchRuns(cursor, abortSignal) : null;
    },
    onSuccess: (page) => {
      if (!page) return;
      setRuns((current) => reconcileWorkflowRunList([...current, ...page.items], props.runUpdate, currentRunFilter(), true));
      setNextCursor(page.nextCursor ?? null);
      setLoadFailure("runs");
    },
    onError: (error) => setLoadFailure("runs", error.message),
  });

  const fetchEmailDeliveries = async (cursor?: string | null, signal?: AbortSignal): Promise<WorkflowEmailDeliveryPage> => {
    const res = await workflowsPageApi["by-base"][":baseId"]["email-deliveries"].$get(
      {
        param: { baseId: props.baseId },
        query: {
          limit: "50",
          ...(props.activeWorkflow ? { workflowId: props.activeWorkflow.id } : {}),
          ...(cursor ? { cursor } : {}),
        },
      },
      { init: { signal } },
    );
    if (!res.ok) throw new Error(await errorMessage(res, t().loadEmailDeliveriesFailed));
    return PublicGridsWorkflowEmailDeliveryListSchema.parse(await res.json());
  };

  const emailDeliveriesMut = mutations.create<void, void>({
    mutation: async (_, { abortSignal }) => {
      const page = await fetchEmailDeliveries(null, abortSignal);
      setEmailDeliveries(page.items);
      setNextEmailCursor(page.nextCursor ?? null);
    },
    onSuccess: () => setEmailLoadError(null),
    onError: (error) => setEmailLoadError(error.message),
  });

  let statsRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleStatsRefresh = () => {
    if (statsRefreshTimer) clearTimeout(statsRefreshTimer);
    statsRefreshTimer = setTimeout(() => {
      statsRefreshTimer = undefined;
      statsMut.mutate();
    }, 250);
  };

  let appliedRunUpdate = "";
  createEffect(() => {
    const update = props.runUpdate;
    if (!update) return;
    const signature = `${update.id}:${update.status}:${update.finishedAt ?? ""}:${update.error?.message ?? ""}`;
    if (signature === appliedRunUpdate) return;
    appliedRunUpdate = signature;

    setRuns((current) => reconcileWorkflowRunList(current, update, currentRunFilter(), true));

    if (isTerminalWorkflowRunStatus(update.status)) {
      scheduleStatsRefresh();
      if (emailActivityOpen()) emailDeliveriesMut.mutate();
    }
  });

  onCleanup(() => {
    if (statsRefreshTimer) clearTimeout(statsRefreshTimer);
  });

  const loadMoreEmailDeliveriesMut = mutations.create<void, void>({
    mutation: async (_, { abortSignal }) => {
      const cursor = nextEmailCursor();
      if (!cursor) return;
      const page = await fetchEmailDeliveries(cursor, abortSignal);
      setEmailDeliveries((current) => [...current, ...page.items]);
      setNextEmailCursor(page.nextCursor ?? null);
    },
    onSuccess: () => setEmailLoadError(null),
    onError: (error) => setEmailLoadError(error.message),
  });

  const launchersMut = mutations.create<void, void>({
    mutation: async (_, { abortSignal }) => {
      const workflow = props.activeWorkflow;
      if (!workflow) {
        setLaunchers([]);
        return;
      }
      const res = await workflowsPageApi[":workflowId"].launchers.$get(
        { param: { workflowId: workflow.id } },
        { init: { signal: abortSignal } },
      );
      if (!res.ok) throw new Error(await errorMessage(res, t().loadLaunchersFailed));
      setLaunchers(PublicGridsWorkflowLauncherListSchema.parse(await res.json()).items);
    },
    onSuccess: () => setLoadFailure("launchers"),
    onError: (error) => setLoadFailure("launchers", error.message),
  });

  const triggerStateMut = mutations.create<void, void>({
    mutation: async (_, { abortSignal }) => {
      const workflow = props.activeWorkflow;
      if (!workflow) {
        setTriggerState(null);
        return;
      }
      const response = await workflowsPageApi[":workflowId"]["trigger-state"].$get(
        { param: { workflowId: workflow.id } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await errorMessage(response, t().loadTriggerStateFailed));
      setTriggerState(PublicWorkflowTriggerRuntimeStateSchema.parse(await response.json()));
    },
    onSuccess: () => setLoadFailure("triggers"),
    onError: (error) => setLoadFailure("triggers", error.message),
  });

  const reloadAll = () => {
    setLoadErrors({});
    statsMut.mutate();
    runsMut.mutate();
    launchersMut.mutate();
    triggerStateMut.mutate();
  };

  const currentUrlState = (): WorkflowUrlState => ({
    window: statsWindow(),
    status: runStatus(),
    channel: runChannel(),
  });

  const replaceUrlState = (state: WorkflowUrlState) => {
    const href = workflowUrlStateHref(new URL(window.location.href), state);
    window.history.replaceState(window.history.state, "", href);
  };

  const changeStatsWindow = (value: string[]) => {
    const next = (value[0] as WorkflowRunStatsWindow | undefined) ?? "24h";
    if (next === statsWindow()) return;
    setStatsWindow(next);
    replaceUrlState(currentUrlState());
    statsMut.mutate();
  };

  const changeRunStatus = (value: string[]) => {
    const next = (value[0] as WorkflowRunStatusFilter | undefined) ?? "all";
    if (next === runStatus()) return;
    setRunStatus(next);
    replaceUrlState(currentUrlState());
    runsMut.mutate();
  };

  const changeRunChannel = (value: string[]) => {
    const next = (value[0] as WorkflowRunChannelFilter | undefined) ?? "all";
    if (next === runChannel()) return;
    setRunChannel(next);
    replaceUrlState(currentUrlState());
    runsMut.mutate();
  };

  onMount(() => {
    const onPopState = () => {
      const next = parseWorkflowUrlState(new URL(window.location.href).searchParams);
      const refreshStats = next.window !== statsWindow();
      const refreshRuns = next.status !== runStatus() || next.channel !== runChannel();

      setStatsWindow(next.window);
      setRunStatus(next.status);
      setRunChannel(next.channel);
      if (refreshStats) statsMut.mutate();
      if (refreshRuns) runsMut.mutate();
    };

    window.addEventListener("popstate", onPopState);
    onCleanup(() => window.removeEventListener("popstate", onPopState));
  });

  const openEditor = async (workflow: PublicWorkflow) => {
    await dialogCore.open<void>(
      (close) => (
        <WorkflowEditor
          baseId={props.baseId}
          tables={props.tables}
          workflow={workflow}
          onChanged={() => props.onWorkflowChanged()}
          onClose={close}
        />
      ),
      { ...panelDialogWorkspaceOptions, cancelBehavior: "ignore" },
    );
  };

  const openLaunchers = async (workflow: PublicWorkflow) => {
    await dialogCore.open<void>(
      (close) => <WorkflowLauncherManager workflow={workflow} tables={props.tables} onChanged={props.onWorkflowChanged} onClose={close} />,
      panelDialogWorkspaceOptions,
    );
  };

  const openHistory = async (workflow: PublicWorkflow) => {
    await dialogCore.open<void>(
      (close) => (
        <WorkflowRevisionHistory
          workflow={workflow}
          canRestore={props.canManageActiveWorkflow}
          onChanged={props.onWorkflowChanged}
          onClose={close}
        />
      ),
      panelDialogWorkspaceOptions,
    );
  };

  const scannerReturnHref = (workflow: PublicWorkflow) =>
    `/app/grids/${encodeURIComponent(props.baseId)}/workflows/${encodeURIComponent(workflow.id)}`;

  const openScanner = async (workflow: PublicWorkflow, launcher: PublicWorkflowLauncher) => {
    if (launcher.config.kind !== "scanner" || !props.canRunActiveWorkflow) return;
    const scannerConfig = launcher.config;
    await dialogCore.open<void>(
      (close) => (
        <PanelDialog surface="floating">
          <PanelDialog.Header
            title={t().scannerNamed({ name: workflow.name })}
            subtitle={workflow.description ?? t().workflowScanner}
            icon="ti ti-barcode"
            close={() => close()}
          />
          <PanelDialog.Body>
            <Suspense fallback={<Placeholder state="loading" title={t().loadingScanner} />}>
              <WorkflowScannerSurface
                mode="dialog"
                state={
                  {
                    baseId: props.baseId,
                    launcherId: launcher.id,
                    expectedRevision: workflow.revision,
                    workflowId: workflow.id,
                    workflowName: workflow.name,
                    workflowDescription: workflow.description,
                    initialCode: null,
                    returnHref: scannerReturnHref(workflow),
                    inputContract: {
                      workflow: { id: workflow.id, name: workflow.name, plan: workflow.plan },
                      tables: props.tables,
                      inputSources: scannerLauncherPromptInputSources(scannerConfig),
                    },
                  } satisfies WorkflowScannerState
                }
              />
            </Suspense>
          </PanelDialog.Body>
        </PanelDialog>
      ),
      panelDialogWorkspaceOptions,
    );
  };

  const runMut = mutations.create<
    { runId: string; status: PublicWorkflowRun["status"] },
    { input: Record<string, unknown>; mode: "execute" | "dryRun" }
  >({
    mutation: async ({ input, mode }, { abortSignal }) => {
      const workflow = props.activeWorkflow;
      if (!workflow) throw new Error(t().chooseWorkflow);
      const res = await workflowsPageApi[":workflowId"].invoke.manual.$post(
        {
          param: { workflowId: workflow.id },
          json: {
            mode,
            inputs: input as Record<string, WorkflowJsonValue>,
            idempotencyKey: crypto.randomUUID(),
            expectedRevision: workflow.revision,
          },
        },
        { init: { signal: abortSignal } },
      );
      if (!res.ok) throw new Error(await errorMessage(res, t().runFailed));
      const receipt = PublicWorkflowInvocationReceiptSchema.parse(await res.json());
      return { runId: receipt.runId, status: receipt.status };
    },
    onSuccess: (receipt) => {
      props.onSelectRun(receipt.runId);
      runsMut.mutate();
      statsMut.mutate();
    },
    onError: (error) => prompts.error(error.message),
  });

  const activeWorkflow = () => props.activeWorkflow;
  const scannerLaunchers = createMemo(() => launchers().filter((launcher) => launcher.enabled && launcher.config.kind === "scanner"));
  const runWorkflow = async (mode: "execute" | "dryRun" = "execute") => {
    const workflow = activeWorkflow();
    if (!workflow) return;
    const input = await requestWorkflowRunInput({ workflow, tables: props.tables, mode });
    if (input === undefined) return;
    runMut.mutate({ input, mode });
  };

  const runColumns = createMemo<DataTableColumn<PublicWorkflowRun>[]>(() => [
    { id: "status", header: t().status, value: (run) => run.status, cellClass: "whitespace-nowrap" },
    { id: "started", header: t().started, value: (run) => run.createdAt, cellClass: "whitespace-nowrap" },
    { id: "channel", header: t().channel, value: (run) => run.channel, cellClass: "whitespace-nowrap" },
    { id: "mode", header: t().mode, value: (run) => run.mode, cellClass: "whitespace-nowrap" },
    { id: "result", header: t().result, value: (run) => run.error?.message ?? run.resultMessage, cellClass: "max-w-[32rem]" },
    { id: "duration", header: t().duration, value: (run) => formatDuration(run, locale()), cellClass: "whitespace-nowrap" },
    { id: "revision", header: t().revision, value: (run) => run.workflowRevision, align: "right" },
  ]);

  const openEmailActivity = async () => {
    const workflow = activeWorkflow();
    if (!workflow) return;
    setEmailDeliveries([]);
    setNextEmailCursor(null);
    setEmailLoadError(null);
    setEmailActivityOpen(true);
    emailDeliveriesMut.mutate();
    try {
      await dialogCore.open<void>(
        (close) => (
          <PanelDialog surface="floating">
            <PanelDialog.Header
              title={t().emailActivity}
              subtitle={t().messagesSentBy({ name: workflow.name })}
              icon="ti ti-mail"
              close={() => close()}
            />
            <PanelDialog.Body>
              <div class="flex min-h-[24rem] flex-1 flex-col gap-2">
                <Show when={emailLoadError()}>
                  {(message) => (
                    <NoticeCard tone="danger" icon={false} bodyClass="flex items-center justify-between gap-3" role="alert">
                      <span>{message()}</span>
                      <Button variant="ghost" size="sm" type="button" class="shrink-0" onClick={() => emailDeliveriesMut.mutate()}>
                        <i class="ti ti-refresh" aria-hidden="true" /> {t().retry}
                      </Button>
                    </NoticeCard>
                  )}
                </Show>
                <EmailDeliveryTable
                  deliveries={emailDeliveries()}
                  loading={emailDeliveriesMut.loading() || loadMoreEmailDeliveriesMut.loading()}
                  nextCursor={nextEmailCursor()}
                  onLoadMore={() => loadMoreEmailDeliveriesMut.mutate()}
                />
              </div>
            </PanelDialog.Body>
          </PanelDialog>
        ),
        panelDialogWorkspaceOptions,
      );
    } finally {
      setEmailActivityOpen(false);
      emailDeliveriesMut.abort();
      loadMoreEmailDeliveriesMut.abort();
    }
  };

  return (
    <Show
      when={activeWorkflow()}
      fallback={
        <div class="flex min-h-0 flex-1">
          <Placeholder
            surface="paper"
            class="flex-1"
            title={t().noWorkflows}
            description={props.editMode ? t().createWorkflowSidebar : t().enableEditMode}
          />
        </div>
      }
    >
      {(workflow) => (
        <div class="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden" data-scroll-preserve="grids-workflow-runs">
          <header class="flex min-w-0 flex-col gap-2" style="view-transition-name: grids-workflows-title">
            <div class="min-w-0">
              <div class="flex min-w-0 flex-wrap items-center gap-2">
                <h1 class="min-w-0 truncate text-base font-semibold text-primary">{workflow().name}</h1>
                <StatusBadge tone={workflow().enabled ? "ok" : "neutral"} label={workflow().enabled ? t().enabled : t().disabled} />
                <Tag size="sm">{triggerSummary(workflow(), locale())}</Tag>
              </div>
              <Show when={workflow().description}>{(description) => <p class="mt-0.5 text-xs text-dimmed">{description()}</p>}</Show>
            </div>
            <div class="flex min-w-0 flex-wrap items-center gap-2" role="toolbar" aria-label={t().workflowActions}>
              <Show when={props.canRunActiveWorkflow}>
                <Button
                  variant="primary"
                  size="sm"
                  type="button"
                  class="shrink-0"
                  disabled={runMut.loading() || !workflow().enabled}
                  onClick={() => void runWorkflow()}
                >
                  <i class={runMut.loading() ? "ti ti-loader-2 animate-spin" : "ti ti-player-play"} /> {t().runWorkflow}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  type="button"
                  class="shrink-0"
                  disabled={runMut.loading()}
                  onClick={() => void runWorkflow("dryRun")}
                >
                  <i class="ti ti-flask" /> {t().dryRun}
                </Button>
                <For each={scannerLaunchers()}>
                  {(launcher) => (
                    <Button
                      variant="secondary"
                      size="sm"
                      type="button"
                      class="shrink-0"
                      onClick={() => void openScanner(workflow(), launcher)}
                    >
                      <i class="ti ti-barcode" /> {launcher.name}
                    </Button>
                  )}
                </For>
              </Show>
              <Show when={props.editMode && props.canManageActiveWorkflow}>
                <Button variant="success" size="sm" type="button" class="shrink-0" onClick={() => void openLaunchers(workflow())}>
                  <i class="ti ti-rocket" /> {t().runOptions}
                </Button>
                <Button variant="success" size="sm" type="button" class="shrink-0" onClick={() => void openHistory(workflow())}>
                  <i class="ti ti-history" /> {t().history}
                </Button>
                <Button variant="success" size="sm" type="button" class="shrink-0" onClick={() => void openEditor(workflow())}>
                  <i class="ti ti-settings" /> {t().manage}
                </Button>
              </Show>
            </div>
          </header>

          <Show when={triggerState() && (triggerState()!.schedule || triggerState()!.recordEvents.length > 0) ? triggerState() : null}>
            {(state) => <WorkflowAutomaticTriggerState state={state()} tables={props.tables} />}
          </Show>

          <Show when={loadError()}>
            {(message) => (
              <NoticeCard tone="danger" icon={false} bodyClass="flex items-center justify-between gap-3" role="alert">
                <span>{message()}</span>
                <Button variant="ghost" size="sm" type="button" class="shrink-0" onClick={reloadAll}>
                  <i class="ti ti-refresh" aria-hidden="true" /> {t().retry}
                </Button>
              </NoticeCard>
            )}
          </Show>

          <div class="flex flex-wrap items-center justify-between gap-2">
            <span class="text-xs text-dimmed">{t().healthOver({ window: statsWindowLabel(statsWindow(), locale()) })}</span>
            <FilterChip
              label={t().metricsWindow}
              icon="ti ti-clock"
              options={statsWindowOptions()}
              value={[statsWindow()]}
              onValueChange={changeStatsWindow}
              defaultValue={["24h"]}
              isActive={statsWindow() !== "24h"}
            />
          </div>

          <Show
            when={stats()}
            fallback={
              <Placeholder
                surface="paper"
                state={statsMut.loading() ? "loading" : "error"}
                title={statsMut.loading() ? t().loadingStatistics : t().statisticsUnavailable}
              />
            }
          >
            <StatGrid columns={5} size="sm">
              <StatCell
                label={t().lastRun}
                value={activeStats()?.latestStatus ? workflowRunStatusLabel(activeStats()!.latestStatus!, locale()) : t().noRuns}
                sub={
                  activeStats()?.lastRunAt
                    ? formatDate(activeStats()?.lastRunAt ?? "", locale())
                    : statsWindowLabel(statsWindow(), locale())
                }
                valueClass={
                  activeStats()?.latestStatus === "failed" || activeStats()?.latestStatus === "needs_attention"
                    ? "text-red-600 dark:text-red-400"
                    : undefined
                }
              />
              <StatCell label={t().runs} value={activeStats()?.total ?? 0} accent={{ tone: "zinc", icon: "ti ti-list" }} />
              <StatCell label={t().active} value={activeStats()?.active ?? 0} accent={{ tone: "blue", icon: "ti ti-player-play" }} />
              <StatCell
                label={t().errorRate}
                value={formatPercent(activeStats()?.errorRate ?? 0, locale())}
                valueClass={
                  (activeStats()?.failed ?? 0) + (activeStats()?.needsAttention ?? 0) > 0 ? "text-red-600 dark:text-red-400" : undefined
                }
                accent={
                  (activeStats()?.failed ?? 0) + (activeStats()?.needsAttention ?? 0) > 0
                    ? { tone: "red", icon: "ti ti-alert-triangle" }
                    : undefined
                }
              />
              <StatCell
                label={t().p99Runtime}
                value={formatMetricDuration(activeStats()?.p99DurationMs ?? null, locale())}
                accent={{ tone: "zinc", icon: "ti ti-hourglass" }}
              />
            </StatGrid>
          </Show>

          <section class="flex min-h-0 flex-1 flex-col gap-2">
            <div class="flex flex-wrap items-end justify-between gap-2">
              <div class="min-w-0">
                <h2 class="text-sm font-semibold text-primary">{t().runs}</h2>
                <p class="text-xs text-dimmed">{t().runsDescription}</p>
              </div>
              <Button variant="secondary" size="sm" type="button" class="shrink-0" onClick={() => void openEmailActivity()}>
                <i class="ti ti-mail" /> {t().emailActivity}
              </Button>
            </div>
            <div class="flex flex-wrap items-center gap-2">
              <FilterChip
                label={t().status}
                icon="ti ti-filter"
                options={runStatusOptions()}
                value={[runStatus()]}
                onValueChange={changeRunStatus}
                defaultValue={["all"]}
                isActive={runStatus() !== "all"}
              />
              <FilterChip
                label={t().channel}
                icon="ti ti-route"
                options={runChannelOptions()}
                value={[runChannel()]}
                onValueChange={changeRunChannel}
                defaultValue={["all"]}
                isActive={runChannel() !== "all"}
              />
              <Button variant="ghost" size="sm" type="button" class="ml-auto" onClick={reloadAll}>
                <i
                  class={
                    runsMut.loading() || statsMut.loading() || triggerStateMut.loading() ? "ti ti-loader-2 animate-spin" : "ti ti-refresh"
                  }
                />{" "}
                {t().refresh}
              </Button>
            </div>
            <DataTable
              ariaLabel={t().workflowRuns}
              rows={runs()}
              columns={runColumns()}
              getRowId={(run) => run.id}
              selectedRowId={props.selectedRunId}
              density="compact"
              highlightColumns={false}
              fillHeight
              class="paper min-h-[18rem] flex-1 overflow-auto"
              scrollPreserveKey={`grids-workflow-runs-${workflow().id}`}
              hasMore={!!nextCursor()}
              loadingMore={runsMut.loading() || loadMoreRunsMut.loading()}
              onLoadMore={() => loadMoreRunsMut.mutate()}
              onRowClick={(run) => props.onSelectRun(run.id)}
              empty={runsMut.loading() ? t().loadingRuns : t().noMatchingRuns}
              renderCell={({ row: run, col, render, value }) => {
                if (col.id === "status") {
                  return <StatusBadge tone={workflowRunStatusTone(run.status)} label={workflowRunStatusLabel(run.status, locale())} />;
                }
                if (col.id === "started") return <span class="text-dimmed">{formatDate(run.createdAt, locale())}</span>;
                if (col.id === "channel") return workflowChannelLabel(run.channel, locale());
                if (col.id === "mode") return run.mode === "dryRun" ? t().dryRun : t().execute;
                if (col.id === "result") {
                  return (
                    <span class={run.error ? "text-red-600 dark:text-red-400" : "text-dimmed"}>
                      {run.error?.message ?? run.resultMessage ?? "—"}
                    </span>
                  );
                }
                return render(value);
              }}
            />
          </section>
        </div>
      )}
    </Show>
  );
}
