import type { WorkflowJsonValue } from "@k2b/cloud/workflows";
import { mutation as mutations } from "@k2b/stdlib/solid";
import { dialogCore, PanelDialog, Placeholder, panelDialogWorkspaceOptions, prompts, useLocale } from "@k2b/ui";
import {
  Bar,
  Button,
  Cells,
  Chip,
  Empty,
  FilterBar,
  Loading,
  Menu,
  type MenuEntry,
  Notice,
  Pane,
  RecordHead,
  Row,
  Section,
  type Status,
  Table,
} from "@k2b/ui/v2";
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
import type { WorkspaceRevision } from "../../../service/workspace-revision";
import { scannerLauncherPromptInputSources } from "../../../workflows/contracts";
import GridsFrame, { LiveNotice } from "../frame/GridsFrame";
import { errorMessage } from "../utils/api-helpers";
import type { NavigationState } from "../workspace/navigation-catalog";
import type {
  PublicWorkflow,
  PublicWorkflowLauncher,
  PublicWorkflowRun,
  PublicWorkflowRunStats,
  PublicWorkflowTriggerRuntimeState,
  PublicWorkspaceWorkflowOverview,
  PublicWorkspaceWorkflowRunDetail,
} from "../workspace/workspace-public-state-model";
import { workflowMessages } from "./messages";
import { WorkflowAutomaticTriggerState } from "./WorkflowAutomaticTriggerState";
import { WorkflowEditor } from "./WorkflowEditor";
import { openWorkflowEmailActivity } from "./WorkflowEmailActivity";
import { WorkflowLauncherManager } from "./WorkflowLauncherManager";
import { WorkflowRevisionHistory } from "./WorkflowRevisionHistory";
import { WorkflowRunDetailPanel } from "./WorkflowRunDetailPanel";
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
import { runsListState, urlStateOf, type WorkflowRunsListState, workflowRunsQuery } from "./workflow-runs-query";
import {
  parseWorkflowUrlState,
  type WorkflowRunChannelFilter,
  type WorkflowRunStatusFilter,
  type WorkflowUrlState,
  workflowUrlStateHref,
} from "./workflow-url-state";

const WorkflowScannerSurface = lazy(() => import("./WorkflowScannerSurface"));

type WorkflowRunStatsWindow = PublicWorkflowRunStats["window"];

export type WorkflowScreenProps = {
  frame: NavigationState;
  revision?: WorkspaceRevision;
  baseId: string;
  tables: PublicTable[];
  activeWorkflow: PublicWorkflow | null;
  /** The address of the workflow without its filters, such as `/app/grids/<base>/workflows/<workflow>`. */
  workflowHref: string;
  /** The run the address opens (`?run=`), and its detail as the server read it. */
  selectedRunId: string | null;
  initialSelectedRun: PublicWorkspaceWorkflowRunDetail | null;
  workflows: PublicWorkflow[];
  workflowLevels: Record<string, "none" | "read" | "write" | "admin">;
  canRunActiveWorkflow: boolean;
  canManageActiveWorkflow: boolean;
  editMode: boolean;
  initialOverview: PublicWorkspaceWorkflowOverview;
  /** The page's live cursor, for the scanner's and the run's updates. */
  liveCursor: string | null;
};

type WorkflowRunPage = {
  items: PublicWorkflowRun[];
  nextCursor?: string | null;
};

type WorkflowEmailDeliveryPage = z.infer<typeof PublicGridsWorkflowEmailDeliveryListSchema>;

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

const STATS_WINDOWS: WorkflowRunStatsWindow[] = ["10m", "1h", "12h", "24h", "7d", "30d"];

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

/**
 * A workflow of a base on v2: its name, state and deeds in the head; how it ran (last run, runs, error rate) as one
 * strip of figures; its automatic triggers; its runs, filtered in the address, with the open run beside them.
 */
export default function WorkflowScreen(props: WorkflowScreenProps) {
  const locale = useLocale();
  const t = () => workflowMessages.resolve([locale()]).t;
  const [selectedRunId, setSelectedRunId] = createSignal(props.selectedRunId);
  const [runUpdate, setRunUpdate] = createSignal<PublicWorkflowRun | null>(null);
  /** Opens a run (or closes it with `null`) as a step in the address, so Back closes it again. */
  const selectRun = (runId: string | null) => {
    const url = new URL(window.location.href);
    if (runId) url.searchParams.set("run", runId);
    else url.searchParams.delete("run");
    window.history.pushState(null, "", `${url.pathname}${url.search}`);
    setRunUpdate(null);
    setSelectedRunId(runId);
  };
  onMount(() => {
    const step = () => {
      setRunUpdate(null);
      setSelectedRunId(new URL(window.location.href).searchParams.get("run"));
    };
    window.addEventListener("popstate", step);
    onCleanup(() => window.removeEventListener("popstate", step));
  });
  const workflowChanged = () => window.location.reload();
  const [statsWindow, setStatsWindow] = createSignal<WorkflowRunStatsWindow>(props.initialOverview.filters.window);
  const [runStatus, setRunStatus] = createSignal<WorkflowRunStatusFilter>(props.initialOverview.filters.status);
  const [runChannel, setRunChannel] = createSignal<WorkflowRunChannelFilter>(props.initialOverview.filters.channel);
  const [launchers, setLaunchers] = createSignal<PublicWorkflowLauncher[]>(props.initialOverview.launchers);
  const [triggerState, setTriggerState] = createSignal<PublicWorkflowTriggerRuntimeState | null>(props.initialOverview.triggerState);
  const [stats, setStats] = createSignal<PublicWorkflowRunStats | null>(props.initialOverview.stats);
  const [runs, setRuns] = createSignal<PublicWorkflowRun[]>(props.initialOverview.runs.items);
  const [nextCursor, setNextCursor] = createSignal<string | null>(props.initialOverview.runs.nextCursor);
  // counts finished runs, so an open e-mail activity reads again
  const [emailRefresh, setEmailRefresh] = createSignal(0);
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
    // Filter changes and live updates replace a read in flight.
    concurrency: "replace",
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
    // Filter changes and live updates replace a read in flight.
    concurrency: "replace",
    mutation: async (_, { abortSignal }) => {
      return fetchRuns(null, abortSignal);
    },
    onSuccess: (page) => {
      setRuns(reconcileWorkflowRunList(page.items, runUpdate(), currentRunFilter(), true));
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
      setRuns((current) => reconcileWorkflowRunList([...current, ...page.items], runUpdate(), currentRunFilter(), true));
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
    const update = runUpdate();
    if (!update) return;
    const signature = `${update.id}:${update.status}:${update.finishedAt ?? ""}:${update.error?.message ?? ""}`;
    if (signature === appliedRunUpdate) return;
    appliedRunUpdate = signature;

    setRuns((current) => reconcileWorkflowRunList(current, update, currentRunFilter(), true));

    if (isTerminalWorkflowRunStatus(update.status)) {
      scheduleStatsRefresh();
      setEmailRefresh((count) => count + 1);
    }
  });

  onCleanup(() => {
    if (statsRefreshTimer) clearTimeout(statsRefreshTimer);
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
      (close, context) => (
        <WorkflowEditor
          baseId={props.baseId}
          tables={props.tables}
          workflow={workflow}
          setDismissHandler={context.setDismissHandler}
          onChanged={workflowChanged}
          onClose={close}
        />
      ),
      panelDialogWorkspaceOptions,
    );
  };

  const openLaunchers = async (workflow: PublicWorkflow) => {
    await dialogCore.open<void>(
      (close, context) => (
        <WorkflowLauncherManager
          workflow={workflow}
          tables={props.tables}
          onChanged={workflowChanged}
          onClose={close}
          setDismissHandler={context.setDismissHandler}
        />
      ),
      panelDialogWorkspaceOptions,
    );
  };

  const openHistory = async (workflow: PublicWorkflow) => {
    await dialogCore.open<void>(
      (close) => (
        <WorkflowRevisionHistory
          workflow={workflow}
          canRestore={props.canManageActiveWorkflow}
          onChanged={workflowChanged}
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
                    liveCursor: props.liveCursor,
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
      selectRun(receipt.runId);
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

  // k2b-ui gap: the e-mail activity stays its v1 dialog (a table of deliveries) until a v2 dialog with a table exists
  const openEmailActivity = () => {
    const workflow = activeWorkflow();
    if (!workflow) return;
    void openWorkflowEmailActivity({
      title: t().emailActivity,
      subtitle: t().messagesSentBy({ name: workflow.name }),
      load: fetchEmailDeliveries,
      refresh: emailRefresh,
    });
  };

  const runsQuery = createMemo(() => workflowRunsQuery(locale()));
  const changeRuns = (next: WorkflowRunsListState) => {
    const state = urlStateOf(next, currentUrlState());
    if (state.status === runStatus() && state.channel === runChannel()) return;
    setRunStatus(state.status);
    setRunChannel(state.channel);
    replaceUrlState(state);
    runsMut.mutate();
  };
  const windowChoice = (): MenuEntry[] => [
    {
      title: t().metricsWindow,
      choice: statsWindow(),
      onChoose: (value) => changeStatsWindow([value]),
      items: STATS_WINDOWS.map((value) => ({ label: statsWindowLabel(value, locale()), value })),
    },
  ];
  const failing = () => (activeStats()?.failed ?? 0) + (activeStats()?.needsAttention ?? 0) > 0;
  const runTone = (status: PublicWorkflowRun["status"]): Status | undefined => {
    const tone = workflowRunStatusTone(status);
    // direction B: a run that went well or runs is a quiet word; colour only where it went wrong
    return tone === "error" ? (status === "needs_attention" ? "warn" : "bad") : undefined;
  };
  const runChipOf = (value: PublicWorkflowRun["status"]) => {
    const status = runTone(value);
    const label = workflowRunStatusLabel(value, locale());
    return status ? <Chip status={status}>{label}</Chip> : label;
  };
  const runChip = (run: PublicWorkflowRun) => runChipOf(run.status);
  /** The workflow's address with its filters, and the run it opens. */
  const runHref = (runId: string | null) => {
    const filtered = workflowUrlStateHref(new URL(props.workflowHref, "https://grids.invalid"), currentUrlState());
    const url = new URL(filtered, "https://grids.invalid");
    if (runId) url.searchParams.set("run", runId);
    return `${url.pathname}${url.search}`;
  };

  const more = (workflow: PublicWorkflow): MenuEntry[] => [
    { label: t().emailActivity, icon: "mail", onClick: openEmailActivity },
    { label: t().refresh, icon: "refresh", onClick: reloadAll },
    ...(props.canManageActiveWorkflow
      ? [
          {
            title: t().manage,
            items: [
              { label: t().runOptions, icon: "rocket", onClick: () => void openLaunchers(workflow) },
              { label: t().history, icon: "history", onClick: () => void openHistory(workflow) },
              { label: t().manage, icon: "settings", onClick: () => void openEditor(workflow) },
            ],
          },
        ]
      : []),
  ];

  const head = (workflow: PublicWorkflow) => (
    <Bar
      start={
        // k2b-ui gap: RecordHead hides its ids at 0 px, which the layout rules reject; until MW fixes it the head shows
        // the name and the state, the triggers stand in their section and the description as the author's note below
        <RecordHead name={workflow.name} kinds={[workflow.enabled ? t().enabled : t().disabled]} />
      }
      end={
        <>
          <Show when={props.canRunActiveWorkflow}>
            <For each={scannerLaunchers()}>
              {(launcher) => (
                <Button icon="barcode" onClick={() => void openScanner(workflow, launcher)}>
                  {launcher.name}
                </Button>
              )}
            </For>
            <Button icon="flask" disabled={runMut.loading()} onClick={() => void runWorkflow("dryRun")}>
              {t().dryRun}
            </Button>
          </Show>
          <Menu items={more(workflow)} />
          <Show when={props.canRunActiveWorkflow}>
            <Button
              variant="primary"
              icon="player-play"
              busy={runMut.loading()}
              disabled={!workflow.enabled}
              onClick={() => void runWorkflow()}
            >
              {t().runWorkflow}
            </Button>
          </Show>
        </>
      }
    />
  );

  return (
    <GridsFrame
      state={props.frame}
      activeKeys={props.activeWorkflow ? [`workflow:${props.activeWorkflow.id}`] : []}
      revision={props.revision}
      head={
        <Show when={activeWorkflow()} fallback={<Bar />}>
          {(workflow) => head(workflow())}
        </Show>
      }
      primary={
        props.canRunActiveWorkflow && activeWorkflow()?.enabled
          ? { label: t().runWorkflow, icon: "player-play", onClick: () => void runWorkflow() }
          : undefined
      }
    >
      <Show
        when={activeWorkflow()}
        fallback={
          <Pane label={t().workflowRuns}>
            <Empty icon="route" text={props.editMode ? t().createWorkflowSidebar : t().enableEditMode} />
          </Pane>
        }
      >
        {(workflow) => (
          <Pane.Split>
            <Pane
              label={t().workflowRuns}
              scrollKey={`grids-workflow-runs-${workflow().id}`}
              status={
                <FilterBar
                  query={runsQuery()}
                  state={runsListState(runsQuery(), currentUrlState())}
                  onChange={changeRuns}
                  icons={{ status: "circle-dashed", channel: "route" }}
                  results={t().runCount({ count: runs().length, more: Boolean(nextCursor()) })}
                />
              }
            >
              <LiveNotice />
              <Show when={workflow().description}>{(description) => <Notice tone="note">{description()}</Notice>}</Show>
              <Show when={loadError()}>
                {(message) => (
                  <Notice tone="bad" actions={[{ label: t().retry, icon: "refresh", onClick: reloadAll }]}>
                    {message()}
                  </Notice>
                )}
              </Show>
              {/* The hero of the screen: how the workflow runs. Direction B wants one figure (--t-figure) with its real
                  trend and the exceptions under it; until DP's hero band lands, it is this band of three cells. The
                  runs have no series per day yet (stats are totals, the run list is paged), so no trend is drawn. */}
              <Bar
                start={t().healthOver({ window: statsWindowLabel(statsWindow(), locale()) })}
                end={<Menu icon="clock" label={t().metricsWindow} items={windowChoice()} />}
              />
              <Show when={stats()} fallback={<Loading rows={1} lines={2} />}>
                <Cells>
                  <Cells.Cell
                    icon="activity"
                    label={t().lastRun}
                    value={activeStats()?.latestStatus ? runChipOf(activeStats()!.latestStatus!) : t().noRuns}
                    meta={activeStats()?.lastRunAt ? formatDate(activeStats()!.lastRunAt!, locale()) : undefined}
                  />
                  <Cells.Cell
                    icon="list"
                    label={t().runs}
                    value={(activeStats()?.total ?? 0).toLocaleString(locale())}
                    meta={t().activeNow({ count: activeStats()?.active ?? 0 })}
                  />
                  <Cells.Cell
                    icon="alert-triangle"
                    label={t().errorRate}
                    value={
                      failing() ? (
                        <Chip status="bad">{formatPercent(activeStats()?.errorRate ?? 0, locale())}</Chip>
                      ) : (
                        formatPercent(activeStats()?.errorRate ?? 0, locale())
                      )
                    }
                    meta={t().p99Meta({ value: formatMetricDuration(activeStats()?.p99DurationMs ?? null, locale()) })}
                  />
                </Cells>
              </Show>
              <Show
                when={triggerState() && (triggerState()!.schedule || triggerState()!.recordEvents.length > 0) ? triggerState() : null}
                fallback={
                  <Section title={t().automaticTriggers}>
                    <Row icon="hand-click" lines={[triggerSummary(workflow(), locale())]} />
                  </Section>
                }
              >
                {(state) => <WorkflowAutomaticTriggerState state={state()} tables={props.tables} />}
              </Show>
              <Table
                label={t().workflowRuns}
                rows={runs()}
                rowKey={(run) => run.id}
                sticky
                current={selectedRunId() ?? undefined}
                loading={runsMut.loading() && runs().length === 0}
                open={(run) => ({
                  href: runHref(run.id),
                  onNavigate: () => selectRun(run.id),
                })}
                empty={{ icon: "player-play", text: t().noMatchingRuns }}
                phone={(run) => ({
                  lines: [
                    run.error?.message ?? run.resultMessage ?? workflowRunStatusLabel(run.status, locale()),
                    `${workflowChannelLabel(run.channel, locale())} · ${run.mode === "dryRun" ? t().dryRun : t().execute} · ${formatDuration(run, locale())}`,
                  ],
                  time: formatDate(run.createdAt, locale()),
                  marks: runTone(run.status) ? (
                    <Chip status={runTone(run.status)!}>{workflowRunStatusLabel(run.status, locale())}</Chip>
                  ) : undefined,
                })}
                columns={[
                  { title: t().status, width: { min: 180, default: 190 }, cell: runChip },
                  { title: t().started, width: { min: 160, default: 170 }, cell: (run) => formatDate(run.createdAt, locale()) },
                  {
                    title: t().channel,
                    width: { min: 100, default: 120 },
                    drop: true,
                    cell: (run) => `${workflowChannelLabel(run.channel, locale())}${run.mode === "dryRun" ? ` · ${t().dryRun}` : ""}`,
                  },
                  {
                    title: t().result,
                    width: { min: 160, default: 280 },
                    drop: true,
                    cell: (run) => run.error?.message ?? run.resultMessage ?? "–",
                  },
                  { title: t().duration, width: { min: 70, default: 90 }, align: "end", cell: (run) => formatDuration(run, locale()) },
                  // A revision is a version number: its digits stay ungrouped.
                  { title: t().revision, align: "end", drop: true, cell: (run) => String(run.workflowRevision) },
                ]}
              />
              <Show when={nextCursor()}>
                <Bar
                  end={
                    <Button icon="chevrons-down" busy={loadMoreRunsMut.loading()} onClick={() => loadMoreRunsMut.mutate()}>
                      {t().moreRuns}
                    </Button>
                  }
                />
              </Show>
            </Pane>
            <Show keyed when={selectedRunId()}>
              {(runId) => (
                <WorkflowRunDetailPanel
                  runId={runId}
                  initialDetail={props.initialSelectedRun?.run.id === runId ? props.initialSelectedRun : null}
                  workflows={props.workflows}
                  workflowLevels={props.workflowLevels}
                  tables={props.tables}
                  liveCursor={props.liveCursor}
                  onRunUpdated={setRunUpdate}
                  onSelectRun={selectRun}
                  onClose={() => selectRun(null)}
                  back={{ label: t().runs, href: runHref(null) }}
                />
              )}
            </Show>
          </Pane.Split>
        )}
      </Show>
    </GridsFrame>
  );
}
