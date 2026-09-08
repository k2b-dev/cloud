import { mutation as mutations } from "@k2b/stdlib/solid";
import {
  Button,
  DetailPanel,
  dialogCore,
  IconButton,
  Placeholder,
  panelDialogWorkspaceOptions,
  prompts,
  StatusBadge,
  Tooltip,
  toast,
  useLocale,
} from "@k2b/ui";
import type { WorkflowJsonValue } from "@valentinkolb/cloud/workflows";
import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js";
import { apiClient } from "../../../api/client";
import type { PublicTable } from "../../../api/public-dto";
import { downloadPdfResponse } from "../documents/document-download";
import { requestDocumentDownload, requestWorkflowDocumentsDownload } from "../documents/document-transfer-client";
import type { PublicDocument } from "../documents/public-document-types";
import { errorMessage } from "../utils/api-helpers";
import type {
  PublicWorkflow,
  PublicWorkflowRun,
  PublicWorkflowStepRun,
  PublicWorkspaceWorkflowRunDetail,
} from "../workspace/workspace-public-state-model";
import { workflowMessages } from "./messages";
import { WorkflowRevisionHistory } from "./WorkflowRevisionHistory";
import {
  WorkflowRunDocumentsSection,
  WorkflowRunExecutionSection,
  WorkflowRunInputsSection,
  WorkflowRunStepsSection,
} from "./WorkflowRunDetailSections";
import { requestWorkflowRunInput } from "./WorkflowRunInputDialog";
import {
  formatWorkflowRunDate as formatDate,
  isTerminalWorkflowRunStatus,
  workflowRunStatusLabel,
  workflowRunStatusTone,
  workflowStepOutcomeSummary,
} from "./workflow-display";
import { mergeRefreshedWorkflowRunDocuments, type WorkflowRunDocumentsState } from "./workflow-run-documents";
import { createWorkflowRunEventsProvider, isTerminalWorkflowRunLiveErrorCode } from "./workflow-run-events-provider";

const workflowRunDetailApi = apiClient.workspace["workflow-run-detail"] as unknown as {
  $get: (input: { query: { runId: string } }, options?: { init?: RequestInit }) => Promise<Response>;
};

const workflowRunDocumentsApi = apiClient.workflows.runs as unknown as {
  [":runId"]: {
    documents: {
      $get: (
        input: { param: { runId: string }; query: { limit: string; offset: string } },
        options?: { init?: RequestInit },
      ) => Promise<Response>;
    };
  };
};

const workflowRunLifecycleApi = apiClient.workflows as unknown as {
  runs: {
    [":runId"]: {
      cancel: { $post: (input: { param: { runId: string } }, options?: { init?: RequestInit }) => Promise<Response> };
    };
  };
  [":workflowId"]: {
    invoke: {
      manual: {
        $post: (
          input: {
            param: { workflowId: string };
            json: {
              mode: "execute" | "dryRun";
              inputs: Record<string, WorkflowJsonValue>;
              idempotencyKey: string;
              expectedRevision: number;
            };
          },
          options?: { init?: RequestInit },
        ) => Promise<Response>;
      };
    };
  };
};

const RUN_DOCUMENT_PAGE_SIZE = 100;

export function WorkflowRunDetailPanel(props: {
  runId: string;
  initialDetail: PublicWorkspaceWorkflowRunDetail | null;
  workflows: PublicWorkflow[];
  workflowLevels: Record<string, "none" | "read" | "write" | "admin">;
  tables: PublicTable[];
  onRunUpdated: (run: PublicWorkflowRun) => void;
  onSelectRun: (runId: string) => void;
  onClose: () => void;
}) {
  const locale = useLocale();
  const t = () => workflowMessages.resolve([locale()]).t;
  const [run, setRun] = createSignal<PublicWorkflowRun | null>(props.initialDetail?.run ?? null);
  const [inputLabels, setInputLabels] = createSignal(props.initialDetail?.inputLabels ?? {});
  const [steps, setSteps] = createSignal<PublicWorkflowStepRun[]>(props.initialDetail?.steps ?? []);
  const [stepsTruncated, setStepsTruncated] = createSignal(props.initialDetail?.stepsTruncated ?? false);
  const [documents, setDocuments] = createSignal<WorkflowRunDocumentsState>({
    items: props.initialDetail?.documents.items ?? [],
    total: props.initialDetail?.documents.total ?? 0,
    hasMore: props.initialDetail?.documents.hasMore ?? false,
    nextOffset: props.initialDetail?.documents.nextOffset ?? null,
  });
  const [downloadingDocumentId, setDownloadingDocumentId] = createSignal<string | null>(null);
  const [downloadingAll, setDownloadingAll] = createSignal(false);
  const [pendingLiveRefreshRunId, setPendingLiveRefreshRunId] = createSignal<string | null>(null);
  const [provenance, setProvenance] = createSignal(props.initialDetail?.provenance ?? null);
  const activeWorkflow = createMemo(() => props.workflows.find((workflow) => workflow.id === run()?.workflowId) ?? null);
  const revisionWorkflow = createMemo(() => {
    const active = activeWorkflow();
    if (active) return active;
    const current = run();
    if (!current?.workflowId) return null;
    return {
      id: current.workflowId,
      name: provenance()?.workflowName ?? t().deletedWorkflow,
      revision: current.workflowRevision,
    };
  });
  const latestProgressAt = createMemo(() => {
    const values = [
      run()?.createdAt,
      run()?.startedAt,
      run()?.finishedAt,
      ...steps().flatMap((step) => [step.startedAt, step.finishedAt]),
    ].filter((value): value is string => Boolean(value));
    return values.sort((left, right) => new Date(right).getTime() - new Date(left).getTime())[0] ?? null;
  });
  const waitingFor = createMemo(() => {
    if (run()?.status !== "waiting") return null;
    return (
      steps()
        .map((step) => workflowStepOutcomeSummary(step.outcome, locale()))
        .find((summary) => summary?.startsWith(t().waiting)) ?? t().waiting
    );
  });
  const inputRows = createMemo(() => {
    const workflow = activeWorkflow();
    return Object.entries(run()?.inputs ?? {}).map(([name, value]) => {
      const definition = workflow?.plan.inputs.find((input) => input.name === name);
      const label = typeof definition?.config.label === "string" ? definition.config.label : name;
      const tableId = workflow?.plan.bindings[`inputs.${name}.table`];
      const table = typeof tableId === "string" ? props.tables.find((candidate) => candidate.id === tableId) : null;
      const formatValue = (value: unknown) => JSON.stringify(value) ?? String(value);
      const formatRecordId = (recordId: unknown) =>
        typeof recordId === "string" ? `${table?.name ?? t().record} ${recordId.slice(0, 8)}` : formatValue(recordId);
      const display =
        definition?.type === "record"
          ? typeof value === "string"
            ? (inputLabels()[value] ?? formatRecordId(value))
            : formatRecordId(value)
          : definition?.type === "recordList" && Array.isArray(value)
            ? value
                .map((recordId) =>
                  typeof recordId === "string" ? (inputLabels()[recordId] ?? formatRecordId(recordId)) : formatRecordId(recordId),
                )
                .join(", ")
            : typeof value === "string"
              ? value
              : formatValue(value);
      return { name, label, display };
    });
  });
  const canWrite = createMemo(() => {
    const workflowId = run()?.workflowId;
    return workflowId ? ["write", "admin"].includes(props.workflowLevels[workflowId] ?? "none") : false;
  });

  const loadMoreDocumentsMut = mutations.create<
    PublicWorkspaceWorkflowRunDetail["documents"],
    { runId: string; offset: number },
    { runId: string; offset: number }
  >({
    onBefore: (request) => request,
    mutation: async ({ runId, offset }, { abortSignal }) => {
      const response = await workflowRunDocumentsApi[":runId"].documents.$get(
        {
          param: { runId },
          query: { limit: String(RUN_DOCUMENT_PAGE_SIZE), offset: String(offset) },
        },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await errorMessage(response, t().loadMoreGeneratedDocumentsFailed));
      return response.json();
    },
    onSuccess: (page, request) => {
      if (!request || request.runId !== props.runId) return;
      setDocuments((current) => {
        if (current.nextOffset !== request.offset) return current;
        const seen = new Set(current.items.map((document) => document.id));
        return {
          items: [...current.items, ...page.items.filter((document) => !seen.has(document.id))],
          total: page.total ?? current.total,
          hasMore: page.hasMore ?? false,
          nextOffset: page.nextOffset ?? null,
        };
      });
    },
  });

  const loadMut = mutations.create<PublicWorkspaceWorkflowRunDetail, string, { runId: string }>({
    onBefore: (runId) => ({ runId }),
    mutation: async (runId, { abortSignal }) => {
      const response = await workflowRunDetailApi.$get({ query: { runId } }, { init: { signal: abortSignal } });
      if (!response.ok) throw new Error(await errorMessage(response, t().loadRunFailed));
      return response.json() as Promise<PublicWorkspaceWorkflowRunDetail>;
    },
    onSuccess: (detail, context) => {
      if (context?.runId !== props.runId || detail.run.id !== context.runId) return;
      setRun(detail.run);
      setInputLabels(detail.inputLabels);
      setProvenance(detail.provenance);
      setSteps(detail.steps);
      setStepsTruncated(detail.stepsTruncated);
      setDocuments((current) => mergeRefreshedWorkflowRunDocuments(current, detail.documents));
    },
  });

  onCleanup(() => {
    loadMut.abort();
    loadMoreDocumentsMut.abort();
  });

  const refresh = (runId = props.runId) => {
    if (!loadMut.loading()) loadMut.mutate(runId);
  };

  createEffect(() => {
    const runId = pendingLiveRefreshRunId();
    if (!runId || loadMut.loading()) return;
    setPendingLiveRefreshRunId(null);
    if (runId === props.runId) refresh(runId);
  });

  createEffect(() => {
    const current = run();
    if (current) props.onRunUpdated(current);
  });

  let loadedRunId = props.initialDetail?.run.id ?? null;
  createEffect(() => {
    const runId = props.runId;
    if (loadedRunId === runId) return;
    loadedRunId = runId;
    setPendingLiveRefreshRunId(null);
    setRun(null);
    setInputLabels({});
    setProvenance(null);
    setSteps([]);
    setDocuments({ items: [], total: 0, hasMore: false, nextOffset: null });
    loadMut.mutate(runId);
  });

  const liveRunId = createMemo(() => {
    const current = run();
    return current && !isTerminalWorkflowRunStatus(current.status) ? current.id : null;
  });
  const liveWorkflowId = createMemo(() => {
    const current = run();
    return current && !isTerminalWorkflowRunStatus(current.status) ? current.workflowId : null;
  });

  createEffect(() => {
    const runId = liveRunId();
    if (!runId) return;
    const workflowId = liveWorkflowId();
    let streamReady = false;
    let fallbackTimer: ReturnType<typeof setInterval> | null = null;
    const refreshSelectedRun = () => {
      if (loadMut.loading()) {
        setPendingLiveRefreshRunId(runId);
        return;
      }
      refresh(runId);
    };
    const stopFallback = () => {
      if (fallbackTimer) clearInterval(fallbackTimer);
      fallbackTimer = null;
    };
    const startFallback = () => {
      if (fallbackTimer || document.visibilityState !== "visible") return;
      fallbackTimer = setInterval(() => {
        if (run() && isTerminalWorkflowRunStatus(run()!.status)) {
          stopFallback();
          return;
        }
        refreshSelectedRun();
      }, 10_000);
    };
    const syncVisibility = () => {
      if (document.visibilityState !== "visible") {
        streamReady = false;
        stopFallback();
      } else if (!streamReady) {
        startFallback();
      }
    };
    document.addEventListener("visibilitychange", syncVisibility);
    startFallback();
    const events = workflowId
      ? createWorkflowRunEventsProvider({
          workflowId,
          locale: locale(),
          onReady: () => {
            streamReady = true;
            refreshSelectedRun();
          },
          onEvent: (event) => {
            if (event.run.id !== runId) return;
            setRun((current) => (current?.id === runId ? { ...current, ...event.run } : current));
            if (event.steps.length > 0) {
              setSteps((current) => {
                const next = new Map(current.map((step) => [step.key, step]));
                for (const step of event.steps) next.set(step.key, step);
                return [...next.values()].sort(
                  (left, right) =>
                    Date.parse(left.startedAt ?? "") - Date.parse(right.startedAt ?? "") || left.key.localeCompare(right.key),
                );
              });
            }
            if (isTerminalWorkflowRunStatus(event.run.status)) {
              stopFallback();
              refreshSelectedRun();
            }
          },
          onError: () => {
            streamReady = false;
            startFallback();
          },
          onRevoked: () => {
            streamReady = false;
            stopFallback();
          },
          onFatal: (error) => {
            streamReady = false;
            if (isTerminalWorkflowRunLiveErrorCode(error.code)) stopFallback();
            else startFallback();
          },
        })
      : null;
    events?.connect();
    onCleanup(() => {
      document.removeEventListener("visibilitychange", syncVisibility);
      stopFallback();
      events?.dispose();
    });
  });

  const downloadDocument = async (document: PublicDocument) => {
    setDownloadingDocumentId(document.id);
    try {
      const res = await requestDocumentDownload(document.id);
      await downloadPdfResponse(res, document.filename);
    } catch (error) {
      prompts.error(error instanceof Error ? error.message : t().downloadDocumentFailed);
    } finally {
      setDownloadingDocumentId(null);
    }
  };

  const cancelMut = mutations.create<PublicWorkflowRun, void>({
    mutation: async (_, { abortSignal }) => {
      const response = await workflowRunLifecycleApi.runs[":runId"].cancel.$post(
        { param: { runId: props.runId } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await errorMessage(response, t().cancelRunFailed));
      return response.json();
    },
    onSuccess: (canceled) => {
      setRun(canceled);
      toast.success(t().runCanceled);
      refresh(canceled.id);
    },
    onError: (error) => prompts.error(error.message),
  });

  const rerunMut = mutations.create<{ runId: string }, { inputs: Record<string, WorkflowJsonValue>; mode: "execute" | "dryRun" }>({
    mutation: async ({ inputs, mode }, { abortSignal }) => {
      const workflow = activeWorkflow();
      if (!workflow) throw new Error(t().workflowDefinitionUnavailable);
      const response = await workflowRunLifecycleApi[":workflowId"].invoke.manual.$post(
        {
          param: { workflowId: workflow.id },
          json: {
            mode,
            inputs,
            idempotencyKey: crypto.randomUUID(),
            expectedRevision: workflow.revision,
          },
        },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await errorMessage(response, t().rerunFailed));
      return response.json();
    },
    onSuccess: (receipt) => {
      toast.success(t().newRunStarted);
      props.onSelectRun(receipt.runId);
    },
    onError: (error) => prompts.error(error.message),
  });

  const cancelRun = async () => {
    const confirmed = await prompts.confirm(t().cancelRunConfirm, {
      title: t().cancelWorkflowRun,
      icon: "ti ti-player-stop",
      confirmText: t().cancelRun,
      variant: "danger",
    });
    if (confirmed) cancelMut.mutate();
  };

  const runAgain = async () => {
    const workflow = activeWorkflow();
    const current = run();
    if (!workflow || !current) return;
    const inputs = await requestWorkflowRunInput({
      workflow,
      tables: props.tables,
      mode: current.mode,
      initialValues: current.inputs,
    });
    if (inputs !== undefined) rerunMut.mutate({ inputs, mode: current.mode });
  };

  const inspectRevision = async () => {
    const workflow = revisionWorkflow();
    const current = run();
    if (!workflow || !current) return;
    await dialogCore.open<void>(
      (close) => (
        <WorkflowRevisionHistory
          workflow={workflow}
          initialRevision={current.workflowRevision}
          canRestore={false}
          onChanged={() => undefined}
          onClose={close}
        />
      ),
      panelDialogWorkspaceOptions,
    );
  };

  const downloadAllDocuments = async () => {
    setDownloadingAll(true);
    try {
      const res = await requestWorkflowDocumentsDownload(props.runId);
      await downloadPdfResponse(res, `workflow-run-${props.runId.slice(0, 8)}.pdf`);
    } catch (error) {
      prompts.error(error instanceof Error ? error.message : t().downloadGeneratedDocumentsFailed);
    } finally {
      setDownloadingAll(false);
    }
  };

  return (
    <DetailPanel>
      <DetailPanel.Header
        icon="ti ti-activity"
        title={t().workflowRun}
        subtitle={run() ? formatDate(run()!.createdAt, locale()) : t().loading}
        meta={
          <span aria-live="polite" aria-atomic="true">
            <Show when={run()}>
              {(current) => (
                <StatusBadge tone={workflowRunStatusTone(current().status)} label={workflowRunStatusLabel(current().status, locale())} />
              )}
            </Show>
          </span>
        }
        actions={
          <>
            <Tooltip.Anchor content={t().refreshRunDetails}>
              <IconButton
                variant="ghost"
                size="sm"
                type="button"
                onClick={() => refresh()}
                disabled={loadMut.loading()}
                label={t().refreshRunDetails}
              >
                <i class={loadMut.loading() ? "ti ti-loader-2 animate-spin" : "ti ti-refresh"} />
              </IconButton>
            </Tooltip.Anchor>
            <Show when={run() && canWrite()}>
              <Tooltip.Anchor content={t().rerunWithInputs}>
                <IconButton
                  variant="ghost"
                  size="sm"
                  type="button"
                  onClick={() => void runAgain()}
                  disabled={rerunMut.loading()}
                  label={t().runAgain}
                >
                  <i class={rerunMut.loading() ? "ti ti-loader-2 animate-spin" : "ti ti-repeat"} />
                </IconButton>
              </Tooltip.Anchor>
            </Show>
            <Show when={run() && !isTerminalWorkflowRunStatus(run()!.status) && canWrite()}>
              <Tooltip.Anchor content={t().cancelWorkflowRun}>
                <IconButton
                  variant="ghost"
                  size="sm"
                  type="button"
                  class="text-red-600 dark:text-red-400"
                  onClick={() => void cancelRun()}
                  disabled={cancelMut.loading()}
                  label={t().cancelWorkflowRun}
                >
                  <i class={cancelMut.loading() ? "ti ti-loader-2 animate-spin" : "ti ti-player-stop"} />
                </IconButton>
              </Tooltip.Anchor>
            </Show>
            <Tooltip.Anchor content={t().closeRunDetails}>
              <IconButton variant="ghost" size="sm" type="button" onClick={props.onClose} label={t().closeRunDetails}>
                <i class="ti ti-x" />
              </IconButton>
            </Tooltip.Anchor>
          </>
        }
      />

      <DetailPanel.Body scrollPreserveKey={`grids-workflow-run-detail-${props.runId}`}>
        <Show when={!run()}>
          <Show when={loadMut.error()} fallback={<Placeholder state="loading" surface="paper" title={t().loadingRun} />}>
            {(error) => (
              <Placeholder
                state="error"
                surface="paper"
                title={t().couldNotLoadRun}
                description={error().message}
                action={
                  <Button variant="secondary" size="sm" type="button" onClick={() => refresh()}>
                    <i class="ti ti-refresh" aria-hidden="true" /> {t().retry}
                  </Button>
                }
              />
            )}
          </Show>
        </Show>
        <Show when={run() && loadMut.error()}>
          {(error) => (
            <Placeholder
              state="error"
              surface="paper"
              align="left"
              title={t().couldNotRefreshRun}
              description={error().message}
              class="shrink-0 py-2"
              action={
                <Button variant="secondary" size="sm" type="button" onClick={() => refresh()}>
                  <i class="ti ti-refresh" aria-hidden="true" /> {t().retry}
                </Button>
              }
            />
          )}
        </Show>

        <Show when={run()}>
          {(current) => (
            <>
              <WorkflowRunExecutionSection
                run={current()}
                provenance={provenance()}
                latestProgressAt={latestProgressAt()}
                waitingFor={waitingFor()}
                canInspectRevision={revisionWorkflow() !== null}
                onInspectRevision={() => void inspectRevision()}
              />
              <WorkflowRunInputsSection inputs={inputRows()} />
              <WorkflowRunStepsSection steps={steps()} truncated={stepsTruncated()} loading={loadMut.loading()} />
              <WorkflowRunDocumentsSection
                documents={documents()}
                downloadingDocumentId={downloadingDocumentId()}
                downloadingAll={downloadingAll()}
                loadingMore={loadMoreDocumentsMut.loading()}
                loadMoreError={loadMoreDocumentsMut.error()?.message}
                onDownload={(document) => void downloadDocument(document)}
                onDownloadAll={() => void downloadAllDocuments()}
                onLoadMore={(offset) => loadMoreDocumentsMut.mutate({ runId: props.runId, offset })}
              />
            </>
          )}
        </Show>
      </DetailPanel.Body>
    </DetailPanel>
  );
}
