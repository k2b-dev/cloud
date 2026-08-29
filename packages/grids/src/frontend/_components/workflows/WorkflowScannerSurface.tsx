import { Button, dialogCore, IconButtonLink, PanelDialog, panelDialogOptions, TextInput, Tooltip, useLocale } from "@k2b/ui";
import type { WorkflowBoundPlan, WorkflowJsonValue } from "@valentinkolb/cloud/workflows";
import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { apiClient } from "../../../api/client";
import type { PublicTable } from "../../../api/public-dto";
import {
  PublicGridsWorkflowRunSchema,
  PublicGridsWorkflowStepRunListSchema,
  PublicWorkflowInvocationReceiptSchema,
} from "../../../api/workflow-public-contracts";
import type { GridsScannerPromptInputSource } from "../../../workflows/contracts";
import { errorMessage } from "../utils/api-helpers";
import { createScannerEngine, type ScannerDetection, type ScannerEngine } from "./scanner-engine";
import { workflowStepStatusTextClass as stepStatusTextClass, workflowRunStatusLabel, workflowStepStatusLabel } from "./workflow-display";
import { createWorkflowRunEventBuffer } from "./workflow-run-event-buffer";
import type { PublicWorkflowRunEventSummary, PublicWorkflowRunStepSummary } from "./workflow-run-public-event";

type WorkflowRunsApi = {
  [":runId"]: {
    $get: (input: { param: { runId: string } }) => Promise<Response>;
    steps: { $get: (input: { param: { runId: string } }) => Promise<Response> };
  };
};

const workflowRunsApi = apiClient.workflows.runs as unknown as WorkflowRunsApi;

import { workflowMessages } from "./messages";
import { requestWorkflowRunInput } from "./WorkflowRunInputDialog";
import { createWorkflowRunEventsProvider, isTerminalWorkflowRunLiveErrorCode } from "./workflow-run-events-provider";
import { acquireScannerStream, stopScannerStream } from "./workflow-scanner-camera";
import { retainVisibleScannerLogs } from "./workflow-scanner-log";
import { invokeWorkflowScannerRequest, type WorkflowScannerTransport, workflowScannerResponseKind } from "./workflow-scanner-request";

type WorkflowScannerInputContract = {
  workflow: {
    id: string;
    name: string;
    plan: Pick<WorkflowBoundPlan, "inputs" | "bindings">;
  };
  tables: Array<Pick<PublicTable, "id" | "name">>;
  inputSources: Record<string, GridsScannerPromptInputSource>;
};

export type WorkflowScannerState = {
  baseId: string;
  launcherId: string;
  expectedRevision: number;
  workflowId: string;
  workflowName: string;
  workflowDescription: string | null;
  initialCode: string | null;
  returnHref: string | null;
  inputContract?: WorkflowScannerInputContract;
};

type ScanStatus = "queued" | "running" | "succeeded" | "failed";

type ScanLogItem = {
  id: string;
  code: string;
  format: string | null;
  status: ScanStatus;
  message: string;
  runId: string | null;
  run: PublicWorkflowRunEventSummary | null;
  steps: PublicWorkflowRunStepSummary[];
  inputs: Record<string, WorkflowJsonValue>;
  createdAt: number;
};

type Props = {
  state: WorkflowScannerState;
  mode: "page" | "dialog";
  transport?: WorkflowScannerSurfaceTransport;
};

export type WorkflowScannerSurfaceTransport = {
  invokeLauncher: WorkflowScannerTransport["invokeLauncher"];
  getRun: (runId: string) => Promise<Response>;
  getSteps?: (runId: string) => Promise<Response>;
  live?: boolean;
};

type VideoBox = { x: number; y: number; width: number; height: number };

type ScanAnnouncement = {
  id: number;
  text: string;
};

const MAX_ACTIVE_SCAN_RUNS = 8;
const MAX_VISIBLE_SCAN_LOGS = 100;

const isTerminal = (run: PublicWorkflowRunEventSummary): boolean =>
  run.status === "succeeded" || run.status === "failed" || run.status === "canceled" || run.status === "needs_attention";

const statusClass = (status: ScanStatus) =>
  status === "succeeded"
    ? "text-emerald-700 dark:text-emerald-300"
    : status === "failed"
      ? "text-red-700 dark:text-red-300"
      : "text-blue-700 dark:text-blue-300";

const displayTime = (value: number, locale: string) =>
  new Date(value).toLocaleTimeString(locale, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

async function openScanDetails(item: ScanLogItem, retry?: () => void) {
  await dialogCore.open<void>((close) => {
    const locale = useLocale();
    const t = () => workflowMessages.resolve([locale()]).t;
    return (
      <PanelDialog>
        <PanelDialog.Header title={t().scanDetails} subtitle={item.runId ?? item.code} icon="ti ti-barcode" close={() => close()} />
        <PanelDialog.Body>
          <PanelDialog.Section title={t().result} icon="ti ti-activity">
            <dl class="grid gap-x-3 gap-y-2 text-sm sm:grid-cols-[7rem_minmax(0,1fr)]">
              <dt class="text-dimmed">{t().status}</dt>
              <dd class={`font-semibold ${statusClass(item.status)}`}>{workflowRunStatusLabel(item.status, locale())}</dd>
              <dt class="text-dimmed">{t().format}</dt>
              <dd class="font-mono">{item.format ?? "-"}</dd>
              <dt class="text-dimmed">{t().message}</dt>
              <dd>{item.message}</dd>
              <dt class="text-dimmed">{t().scannedValue}</dt>
              <dd class="break-all font-mono text-xs">{item.code}</dd>
            </dl>
          </PanelDialog.Section>
          <PanelDialog.Section title={t().steps} icon="ti ti-list-details">
            <Show when={item.steps.length > 0} fallback={<p class="text-sm text-dimmed">{t().noStepData}</p>}>
              <div class="flex flex-col gap-2">
                <For each={item.steps}>
                  {(step) => (
                    <div class="grid grid-cols-[minmax(0,1fr)_auto] gap-3 py-1 text-sm">
                      <div class="min-w-0">
                        <p class="truncate font-medium text-primary">{step.sourcePath?.length ? step.sourcePath.join(".") : step.key}</p>
                        <p class="text-xs text-dimmed">{step.action ?? step.kind}</p>
                      </div>
                      <span class={`text-xs font-semibold ${stepStatusTextClass(step.status)}`}>
                        {workflowStepStatusLabel(step.status, locale())}
                      </span>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </PanelDialog.Section>
        </PanelDialog.Body>
        <PanelDialog.Footer>
          <Show when={retry} fallback={<span />}>
            {(retryAction) => (
              <Button
                variant="secondary"
                type="button"
                onClick={() => {
                  close();
                  retryAction()();
                }}
              >
                <i class="ti ti-refresh" aria-hidden="true" /> {t().retry}
              </Button>
            )}
          </Show>
          <Button variant="secondary" type="button" onClick={() => close()}>
            {t().close}
          </Button>
        </PanelDialog.Footer>
      </PanelDialog>
    );
  }, panelDialogOptions);
}

export default function WorkflowScannerSurface(props: Props) {
  const locale = useLocale();
  const t = () => workflowMessages.resolve([locale()]).t;
  let cameraFrame: HTMLElement | undefined;
  let video: HTMLVideoElement | undefined;
  let stream: MediaStream | null = null;
  let engine: ScannerEngine | null = null;
  let disposed = false;
  let decoding = false;
  let initialCodeSubmitted = false;
  let fallbackTimer: ReturnType<typeof setInterval> | null = null;
  let watchdogTimer: ReturnType<typeof setInterval> | null = null;
  let streamReady = false;
  const pendingRunEvents = createWorkflowRunEventBuffer();

  const [cameraRunning, setCameraRunning] = createSignal(false);
  const [cameraError, setCameraError] = createSignal<string | null>(null);
  const [pauseReason, setPauseReason] = createSignal<string | null>(null);
  const [detections, setDetections] = createSignal<ScannerDetection[]>([]);
  const [logs, setLogs] = createSignal<ScanLogItem[]>([]);
  const [completedCounts, setCompletedCounts] = createSignal({ total: 0, ok: 0, failed: 0 });
  const [activeScanIds, setActiveScanIds] = createSignal<Set<string>>(new Set());
  const [announcements, setAnnouncements] = createSignal<ScanAnnouncement[]>([]);
  const [manualCode, setManualCode] = createSignal("");
  const [inputContract, setInputContract] = createSignal<WorkflowScannerInputContract | null>(props.state.inputContract ?? null);
  const [sessionInputs, setSessionInputs] = createSignal<Record<string, WorkflowJsonValue>>({});
  const [setupReady, setSetupReady] = createSignal(false);
  const [setupError, setSetupError] = createSignal<string | null>(null);
  const [collectingInput, setCollectingInput] = createSignal(false);
  const [videoBox, setVideoBox] = createSignal<VideoBox>({ x: 0, y: 0, width: 1, height: 1 });
  const recentCodes = new Map<string, number>();
  const scanStatuses = new Map<string, ScanStatus>();
  let announcementId = 0;
  const scannerTransport: WorkflowScannerTransport = props.transport ?? {
    invokeLauncher: (input) => apiClient.workflows.launchers[":launcherId"].invoke.scanner.$post(input),
  };
  const getRun = (runId: string) => props.transport?.getRun(runId) ?? workflowRunsApi[":runId"].$get({ param: { runId } });

  const counts = () => ({ ...completedCounts(), active: activeScanIds().size });
  const promptContract = (kind: "session" | "afterScan") => {
    const contract = inputContract();
    if (!contract) return null;
    const inputs = contract.workflow.plan.inputs.filter((candidate) => contract.inputSources[candidate.name]?.kind === kind);
    return {
      workflow: {
        ...contract.workflow,
        plan: {
          inputs,
          bindings: Object.fromEntries(
            inputs.flatMap((candidate) => {
              const key = `inputs.${candidate.name}.table`;
              const value = contract.workflow.plan.bindings[key];
              return value === undefined ? [] : [[key, value]];
            }),
          ),
        },
      },
      tables: contract.tables,
    };
  };

  const loadInputContract = async (): Promise<WorkflowScannerInputContract> => {
    if (props.state.inputContract) return props.state.inputContract;
    throw new Error(t().scannerInputUnavailable);
  };

  const requestSessionInputs = async (changing = false): Promise<boolean> => {
    const contract = promptContract("session");
    if (!contract || contract.workflow.plan.inputs.length === 0) {
      setSetupReady(true);
      return true;
    }
    setCollectingInput(true);
    try {
      const prompted = await requestWorkflowRunInput({
        ...contract,
        mode: "execute",
        initialValues: sessionInputs(),
        title: changing ? t().changeScannerContext : t().setupScanner,
        subtitle: t().scannerContextDescription,
        submitLabel: changing ? t().apply : t().startScanning,
        icon: "ti ti-adjustments",
      });
      if (prompted === undefined) return false;
      setSessionInputs(prompted);
      setSetupReady(true);
      setSetupError(null);
      return true;
    } finally {
      setCollectingInput(false);
    }
  };
  const announceLog = (item: ScanLogItem) => {
    const announcement = {
      id: ++announcementId,
      text: t().scanAnnouncement({ code: item.code, message: item.message, status: workflowRunStatusLabel(item.status, locale()) }),
    };
    setAnnouncements((items) => [...items.slice(-9), announcement]);
  };

  const prependLog = (item: ScanLogItem) => {
    scanStatuses.set(item.id, item.status);
    setCompletedCounts((counts) => ({
      total: counts.total + 1,
      ok: counts.ok + (item.status === "succeeded" ? 1 : 0),
      failed: counts.failed + (item.status === "failed" ? 1 : 0),
    }));
    setLogs((items) => {
      const next = retainVisibleScannerLogs([item, ...items], MAX_VISIBLE_SCAN_LOGS);
      const visibleIds = new Set(next.map((entry) => entry.id));
      for (const entry of items) {
        if (!visibleIds.has(entry.id) && entry.status !== "queued" && entry.status !== "running") scanStatuses.delete(entry.id);
      }
      return next;
    });
    announceLog(item);
  };

  const updateLog = (id: string, patch: Partial<ScanLogItem>) => {
    const previousStatus = scanStatuses.get(id);
    if (!previousStatus) return;
    const nextStatus = patch.status ?? previousStatus;
    if (patch.status === "queued" || patch.status === "running") {
      setActiveScanIds((ids) => new Set(ids).add(id));
    } else if (patch.status) {
      setActiveScanIds((ids) => {
        const next = new Set(ids);
        next.delete(id);
        return next;
      });
    }
    if (nextStatus !== previousStatus) {
      setCompletedCounts((counts) => ({
        ...counts,
        ok: counts.ok - (previousStatus === "succeeded" ? 1 : 0) + (nextStatus === "succeeded" ? 1 : 0),
        failed: counts.failed - (previousStatus === "failed" ? 1 : 0) + (nextStatus === "failed" ? 1 : 0),
      }));
      scanStatuses.set(id, nextStatus);
    }
    const current = logs().find((item) => item.id === id);
    if (!current) {
      if (nextStatus === "succeeded" || nextStatus === "failed") scanStatuses.delete(id);
      return;
    }
    const next = { ...current, ...patch };
    setLogs((items) => items.map((item) => (item.id === id ? next : item)));
    if (next.status !== current.status || next.message !== current.message) announceLog(next);
  };

  const fetchSteps = async (runId: string): Promise<PublicWorkflowRunStepSummary[]> => {
    if (props.transport && !props.transport.getSteps) return [];
    const res = props.transport?.getSteps
      ? await props.transport.getSteps(runId)
      : await workflowRunsApi[":runId"].steps.$get({ param: { runId } });
    if (!res.ok) throw new Error(await errorMessage(res, t().requestFailed));
    const payload = PublicGridsWorkflowStepRunListSchema.parse(await res.json());
    return payload.items;
  };

  const applyRun = (logId: string, run: PublicWorkflowRunEventSummary, steps?: PublicWorkflowRunStepSummary[]) => {
    const status: ScanStatus =
      run.status === "succeeded"
        ? "succeeded"
        : run.status === "failed" || run.status === "canceled" || run.status === "needs_attention"
          ? "failed"
          : "running";
    updateLog(logId, {
      run,
      status,
      runId: run.id,
      message:
        run.resultMessage ??
        run.error?.message ??
        run.operatorMessage ??
        (status === "succeeded" ? t().succeeded : status === "failed" ? t().workflowFailed : t().running),
      ...(steps ? { steps } : {}),
    });
  };

  const refreshRun = async (logId: string, runId: string) => {
    const res = await getRun(runId);
    if (!res.ok) throw new Error(await errorMessage(res, t().requestFailed));
    const run = PublicGridsWorkflowRunSchema.parse(await res.json());
    let steps: PublicWorkflowRunStepSummary[] | undefined;
    if (isTerminal(run)) {
      try {
        steps = await fetchSteps(run.id);
      } catch {
        // The run result remains useful when optional step details cannot be loaded.
      }
    }
    applyRun(logId, run, steps);
  };

  const refreshActiveRuns = async () => {
    const active = logs().filter((item) => item.runId && (item.status === "queued" || item.status === "running"));
    await Promise.all(active.map((item) => refreshRun(item.id, item.runId!).catch(() => undefined)));
  };

  const stopFallback = () => {
    if (fallbackTimer) clearInterval(fallbackTimer);
    fallbackTimer = null;
  };

  const stopWatchdog = () => {
    if (watchdogTimer) clearInterval(watchdogTimer);
    watchdogTimer = null;
  };

  const startFallback = () => {
    if (fallbackTimer || disposed || document.visibilityState !== "visible") return;
    fallbackTimer = setInterval(() => void refreshActiveRuns(), 2500);
  };

  const startWatchdog = () => {
    if (watchdogTimer || disposed || document.visibilityState !== "visible") return;
    watchdogTimer = setInterval(() => void refreshActiveRuns(), 10_000);
  };

  const stopForTerminalLiveError = (error: { message: string }) => {
    streamReady = false;
    stopFallback();
    stopWatchdog();
    setPauseReason(error.message);
    setCameraError(error.message);
    stopCamera();
    const stopped = logs()
      .filter((item) => item.status === "queued" || item.status === "running")
      .map((item) => ({ ...item, status: "failed" as const, message: error.message }));
    setLogs((items) =>
      items.map((item) =>
        item.status === "queued" || item.status === "running" ? { ...item, status: "failed", message: error.message } : item,
      ),
    );
    setCompletedCounts((counts) => ({ ...counts, failed: counts.failed + stopped.length }));
    for (const item of stopped) scanStatuses.set(item.id, "failed");
    setActiveScanIds(new Set<string>());
    for (const item of stopped) announceLog(item);
  };

  const syncLiveVisibility = () => {
    if (document.visibilityState !== "visible") {
      streamReady = false;
      stopFallback();
      stopWatchdog();
      return;
    }
    if (props.transport?.live === false) {
      startFallback();
      void refreshActiveRuns();
      return;
    }
    startWatchdog();
    if (!streamReady) startFallback();
    void refreshActiveRuns();
  };

  const runEvents = createWorkflowRunEventsProvider({
    workflowId: props.state.workflowId,
    locale: locale(),
    onReady: () => {
      streamReady = true;
      stopFallback();
      void refreshActiveRuns();
    },
    onEvent: (event) => {
      const item = logs().find((candidate) => candidate.runId === event.run.id);
      if (item) {
        applyRun(item.id, event.run, event.steps);
        return;
      }
      pendingRunEvents.push(event);
    },
    onError: () => {
      streamReady = false;
      startFallback();
    },
    onRevoked: stopForTerminalLiveError,
    onFatal: (error) => {
      streamReady = false;
      if (isTerminalWorkflowRunLiveErrorCode(error.code)) stopForTerminalLiveError(error);
      else startFallback();
    },
  });

  const submitScan = async (item: Pick<ScanLogItem, "id" | "code" | "inputs">) => {
    try {
      const res = await invokeWorkflowScannerRequest(
        scannerTransport,
        {
          launcherId: props.state.launcherId,
        },
        { operationId: item.id, expectedRevision: props.state.expectedRevision, code: item.code, inputs: item.inputs },
      );
      const responseKind = workflowScannerResponseKind(res);
      if (responseKind === "revision-conflict") {
        const message = await errorMessage(res, t().workflowChangedScanner);
        const pausedMessage = `${message} ${t().restartForLatestRevision}`;
        setPauseReason(pausedMessage);
        stopCamera();
        updateLog(item.id, { status: "failed", message: pausedMessage });
        return;
      }
      if (responseKind === "failed") throw new Error(await errorMessage(res, t().scannerStartFailed));
      const receipt = PublicWorkflowInvocationReceiptSchema.parse(await res.json());
      const runId = receipt.runId;
      const pending = pendingRunEvents.take(runId);
      if (pending) applyRun(item.id, pending.run, pending.steps);
      else {
        const status = receipt.status === "queued" ? "queued" : "running";
        updateLog(item.id, { runId, status, message: status === "queued" ? t().queued : t().running });
      }
      setTimeout(() => {
        if (!disposed) void refreshRun(item.id, runId).catch(() => !streamReady && startFallback());
      }, 1500);
    } catch (error) {
      updateLog(item.id, {
        status: "failed",
        message: error instanceof Error ? error.message : t().scannerStartFailed,
      });
    }
  };

  const runScan = async (code: string, format: string | null) => {
    const trimmed = code.trim();
    if (!trimmed || pauseReason() || !setupReady() || collectingInput()) return;
    const now = Date.now();
    const last = recentCodes.get(trimmed) ?? 0;
    if (now - last < 2500) return;
    recentCodes.set(trimmed, now);

    const busy = activeScanIds().size >= MAX_ACTIVE_SCAN_RUNS;
    let afterScanInputs: Record<string, WorkflowJsonValue> = {};
    const afterScanContract = promptContract("afterScan");
    if (!busy && afterScanContract && afterScanContract.workflow.plan.inputs.length > 0) {
      setCollectingInput(true);
      try {
        const prompted = await requestWorkflowRunInput({
          ...afterScanContract,
          mode: "execute",
          title: t().completeScan,
          subtitle: t().provideScannedInputs,
          submitLabel: t().runWorkflow,
          icon: "ti ti-clipboard-check",
        });
        if (prompted === undefined) return;
        afterScanInputs = prompted;
      } finally {
        setCollectingInput(false);
      }
    }
    const item: ScanLogItem = {
      id: crypto.randomUUID(),
      code: trimmed,
      format,
      status: busy ? "failed" : "queued",
      message: busy ? t().scannerBusy : t().queued,
      runId: null,
      run: null,
      steps: [],
      inputs: { ...sessionInputs(), ...afterScanInputs },
      createdAt: now,
    };
    if (!busy) setActiveScanIds((ids) => new Set(ids).add(item.id));
    prependLog(item);
    if (item.status === "queued") await submitScan(item);
  };

  const retryScan = (item: ScanLogItem) => {
    if (pauseReason() || item.runId || activeScanIds().size >= MAX_ACTIVE_SCAN_RUNS) return;
    updateLog(item.id, { status: "queued", message: t().retrying });
    void submitScan(item);
  };

  const updateVideoBox = () => {
    if (!cameraFrame || !video || video.videoWidth <= 0 || video.videoHeight <= 0) {
      setVideoBox({ x: 0, y: 0, width: 1, height: 1 });
      return;
    }
    const frame = cameraFrame.getBoundingClientRect();
    if (frame.width <= 0 || frame.height <= 0) return;
    const videoRatio = video.videoWidth / video.videoHeight;
    const frameRatio = frame.width / frame.height;
    if (videoRatio > frameRatio) {
      const height = frameRatio / videoRatio;
      setVideoBox({ x: 0, y: (1 - height) / 2, width: 1, height });
    } else {
      const width = videoRatio / frameRatio;
      setVideoBox({ x: (1 - width) / 2, y: 0, width, height: 1 });
    }
  };

  const detectionStyle = (box: NonNullable<ScannerDetection["boundingBox"]>) => {
    const display = videoBox();
    return {
      left: `${(display.x + box.x * display.width) * 100}%`,
      top: `${(display.y + box.y * display.height) * 100}%`,
      width: `${box.width * display.width * 100}%`,
      height: `${box.height * display.height * 100}%`,
    };
  };

  const tick = async () => {
    if (disposed || !cameraRunning()) return;
    if (collectingInput() || !video || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || decoding || !engine) {
      window.setTimeout(() => void tick(), 220);
      return;
    }
    decoding = true;
    try {
      updateVideoBox();
      const found = await engine.decodeVideoFrame(video);
      setDetections(found);
      for (const detection of found) void runScan(detection.rawValue, detection.format);
    } catch (error) {
      setCameraError(error instanceof Error ? error.message : t().scannerFailed);
    } finally {
      decoding = false;
      window.setTimeout(() => void tick(), 220);
    }
  };

  const stopCamera = () => {
    if (stream) stopScannerStream(stream);
    stream = null;
    if (video) video.srcObject = null;
    setCameraRunning(false);
  };

  const startCamera = async () => {
    if (pauseReason()) return;
    setCameraError(null);
    try {
      engine ??= createScannerEngine(t().scannerCanvasFailed);
      const acquired = await acquireScannerStream(navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices), () => disposed);
      if (!acquired) return;
      if (!video) {
        stopScannerStream(acquired);
        return;
      }
      stream = acquired;
      video.srcObject = stream;
      await video.play();
      if (disposed) {
        stopCamera();
        return;
      }
      updateVideoBox();
      setCameraRunning(true);
      void tick();
    } catch (error) {
      setCameraError(error instanceof Error ? error.message : t().cameraStartFailed);
      stopCamera();
    }
  };

  const submitManual = (event: SubmitEvent) => {
    event.preventDefault();
    const code = manualCode().trim();
    setManualCode("");
    void runScan(code, "manual");
  };

  const submitInitialCode = () => {
    if (initialCodeSubmitted) return;
    const code = props.state.initialCode?.trim();
    if (!code) return;
    initialCodeSubmitted = true;
    void runScan(code, "link");
  };

  const initializeScanner = async () => {
    try {
      setSetupError(null);
      setInputContract(await loadInputContract());
      const configured = await requestSessionInputs();
      if (!configured) {
        setSetupError(t().setupCanceled);
        return;
      }
      submitInitialCode();
      if (!navigator.mediaDevices?.getUserMedia) {
        setCameraError(t().cameraUnsupported);
        return;
      }
      await startCamera();
    } catch (error) {
      setSetupError(error instanceof Error ? error.message : t().scannerInputsLoadFailed);
    }
  };

  const changeSessionInputs = async () => {
    if (collectingInput()) return;
    const wasRunning = cameraRunning();
    const changed = await requestSessionInputs(true);
    if (changed && wasRunning && !cameraRunning()) await startCamera();
  };

  onMount(() => {
    if (typeof window === "undefined") return;
    window.addEventListener("resize", updateVideoBox);
    document.addEventListener("visibilitychange", syncLiveVisibility);
    if (props.transport?.live === false) startFallback();
    else {
      runEvents.connect();
      startWatchdog();
    }
    void initializeScanner();
  });

  onCleanup(() => {
    disposed = true;
    if (typeof window === "undefined") return;
    window.removeEventListener("resize", updateVideoBox);
    document.removeEventListener("visibilitychange", syncLiveVisibility);
    stopFallback();
    stopWatchdog();
    pendingRunEvents.clear();
    runEvents.dispose();
    stopCamera();
  });

  const shellClass =
    props.mode === "page"
      ? "flex h-[100dvh] min-h-0 flex-col bg-[var(--ui-bg)] text-primary"
      : "flex h-full min-h-0 flex-1 flex-col bg-transparent text-primary";
  const mainClass =
    props.mode === "page"
      ? "grid min-h-0 flex-1 grid-rows-[minmax(12rem,40dvh)_minmax(0,1fr)] gap-3 p-3 md:p-4"
      : "grid min-h-0 flex-1 grid-rows-[minmax(12rem,42%)_minmax(0,1fr)] gap-3 p-2 md:p-3";

  return (
    <div class={shellClass}>
      <Show when={props.mode === "page"}>
        <header class="flex shrink-0 items-center gap-3 px-4 py-3">
          <Tooltip.Anchor content={t().backToWorkflow} placement="bottom">
            <IconButtonLink
              variant="ghost"
              size="sm"
              href={props.state.returnHref ?? `/app/grids/${props.state.baseId}/workflows/${props.state.workflowId}`}
              label={t().backToWorkflow}
            >
              <i class="ti ti-arrow-left" />
            </IconButtonLink>
          </Tooltip.Anchor>
          <div class="min-w-0 flex-1">
            <p class="truncate text-sm font-semibold">{props.state.workflowName}</p>
            <p class="truncate text-xs text-dimmed">{t().scanner}</p>
          </div>
        </header>
      </Show>

      <main class={mainClass}>
        <div class="sr-only" aria-live="polite" aria-relevant="additions text">
          <For each={announcements()}>{(announcement) => <p>{announcement.text}</p>}</For>
        </div>
        <section ref={cameraFrame} class="relative min-h-0 overflow-hidden rounded-xl bg-black shadow-sm">
          <video ref={video} class="h-full w-full object-contain" playsinline autoplay muted />
          <div class="pointer-events-none absolute inset-0">
            <For each={detections()}>
              {(detection) => (
                <Show when={detection.boundingBox}>
                  {(box) => (
                    <div
                      class="absolute rounded-lg border-2 border-emerald-400 shadow-[0_0_0_9999px_rgba(0,0,0,0.12)]"
                      style={detectionStyle(box())}
                    />
                  )}
                </Show>
              )}
            </For>
          </div>
          <div class="absolute left-3 top-3 flex flex-wrap items-center gap-2">
            <span class="rounded-full bg-black/70 px-2 py-1 text-xs font-medium text-white">
              {pauseReason() ? t().paused : cameraRunning() ? t().scanning : t().cameraOff}
            </span>
            <Show when={cameraError()}>
              <span class="rounded-full bg-red-600/90 px-2 py-1 text-xs font-medium text-white" role="alert">
                {cameraError()}
              </span>
            </Show>
            <Show when={pauseReason()}>
              {(reason) => (
                <span class="max-w-[min(36rem,75vw)] rounded bg-red-600/90 px-2 py-1 text-xs font-medium text-white" role="alert">
                  {reason()}
                </span>
              )}
            </Show>
          </div>
          <div class="absolute right-3 top-3 flex items-center gap-2">
            <Show
              when={pauseReason()}
              fallback={
                <Button
                  variant="secondary"
                  size="sm"
                  type="button"
                  class="bg-black/70 text-white hover:bg-black/90"
                  onClick={() => (cameraRunning() ? stopCamera() : void startCamera())}
                >
                  <i class={`ti ${cameraRunning() ? "ti-video-off" : "ti-video"}`} />
                  {cameraRunning() ? t().stop : t().start}
                </Button>
              }
            >
              <Button
                variant="secondary"
                size="sm"
                type="button"
                class="bg-black/70 text-white hover:bg-black/90"
                onClick={() => window.location.reload()}
              >
                <i class="ti ti-refresh" aria-hidden="true" /> {t().restart}
              </Button>
            </Show>
          </div>
          <Show when={!setupReady() || setupError()}>
            <div class="absolute inset-0 flex items-center justify-center bg-black/70 p-6 text-center text-white">
              <div class="max-w-md">
                <i class={`ti ${setupError() ? "ti-alert-circle" : "ti-adjustments"} mb-3 text-2xl`} aria-hidden="true" />
                <p class="text-sm font-semibold">{setupError() ?? t().preparingScanner}</p>
                <Show when={setupError()}>
                  <Button
                    variant="secondary"
                    size="sm"
                    type="button"
                    class="mt-4 bg-white text-zinc-900 hover:bg-zinc-100"
                    disabled={collectingInput()}
                    onClick={() => void initializeScanner()}
                  >
                    <i class="ti ti-refresh" aria-hidden="true" /> {t().setUp}
                  </Button>
                </Show>
              </div>
            </div>
          </Show>
        </section>

        <section class="flex min-h-0 flex-col overflow-hidden">
          <div class="flex shrink-0 flex-wrap items-center justify-between gap-2 px-1 pb-2">
            <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-dimmed">
              <span>{t().scanCount({ count: counts().total })}</span>
              <span>{t().okCount({ count: counts().ok })}</span>
              <span>{t().activeCount({ count: counts().active })}</span>
              <span>{t().errorCount({ count: counts().failed })}</span>
            </div>
            <Show when={(promptContract("session")?.workflow.plan.inputs.length ?? 0) > 0}>
              <Button variant="secondary" size="sm" type="button" disabled={collectingInput()} onClick={() => void changeSessionInputs()}>
                <i class="ti ti-adjustments" aria-hidden="true" /> {t().changeContext}
              </Button>
            </Show>
          </div>
          <form class="flex shrink-0 items-center gap-2 px-1 pb-2" onSubmit={submitManual}>
            <div class="min-w-0 flex-1">
              <TextInput
                value={manualCode}
                onValueChange={setManualCode}
                placeholder={t().enterScanCode}
                aria-label={t().scanCode}
                icon="ti ti-keyboard"
                name="manual-scan-code"
                autocomplete="off"
                disabled={Boolean(pauseReason()) || !setupReady() || collectingInput()}
              />
            </div>
            <Button
              variant="secondary"
              size="sm"
              type="submit"
              class="shrink-0"
              disabled={!manualCode().trim() || Boolean(pauseReason()) || !setupReady() || collectingInput()}
            >
              <i class="ti ti-scan" aria-hidden="true" /> {t().scan}
            </Button>
          </form>
          <div class="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-2">
            <Show when={counts().total > logs().length}>
              <p class="px-3 py-1 text-[11px] text-dimmed">{t().latestScans({ count: MAX_VISIBLE_SCAN_LOGS })}</p>
            </Show>
            <Show
              when={logs().length > 0}
              fallback={<div class="flex h-full items-center justify-center px-4 text-center text-sm text-dimmed">{t().noScans}</div>}
            >
              <For each={logs()}>
                {(item) => (
                  <button
                    type="button"
                    class="grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-[var(--ui-radius-control)] px-3 py-2 text-left transition-colors hover:bg-[var(--ui-surface-subtle)]"
                    onClick={() =>
                      void openScanDetails(
                        item,
                        item.status === "failed" && !item.runId && !pauseReason() ? () => retryScan(item) : undefined,
                      )
                    }
                  >
                    <i
                      class={`ti ${
                        item.status === "succeeded"
                          ? "ti-circle-check"
                          : item.status === "failed"
                            ? "ti-alert-circle"
                            : "ti-loader-2 animate-spin"
                      } ${statusClass(item.status)}`}
                    />
                    <span class="min-w-0">
                      <span class="block truncate text-sm font-medium text-primary">{item.message}</span>
                      <span class="block truncate font-mono text-[11px] text-dimmed">{item.code}</span>
                    </span>
                    <span class="text-xs text-dimmed">{displayTime(item.createdAt, locale())}</span>
                  </button>
                )}
              </For>
            </Show>
          </div>
        </section>
      </main>
    </div>
  );
}
