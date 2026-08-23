import { Button, IconButton, NoticeCard, Placeholder, StatusBadge, Tooltip } from "@k2b/ui";
import { For, Show } from "solid-js";
import type { PublicDocument } from "../documents/public-document-types";
import type { PublicWorkflowRun, PublicWorkflowStepRun, PublicWorkspaceWorkflowRunDetail } from "../workspace/workspace-public-state-model";
import {
  channelLabels,
  formatWorkflowRunDate as formatDate,
  formatWorkflowRunDuration as formatDuration,
  workflowStepErrorMessage,
  workflowStepIssueReason,
  workflowStepOutcomeSummary,
  workflowStepPlannedEffects,
  workflowStepStatusTone,
} from "./workflow-display";
import type { WorkflowRunDocumentsState } from "./workflow-run-documents";

type WorkflowRunInputRow = {
  name: string;
  label: string;
  display: string;
};

export function WorkflowRunExecutionSection(props: {
  run: PublicWorkflowRun;
  provenance: PublicWorkspaceWorkflowRunDetail["provenance"] | null;
  latestProgressAt: string | null;
  waitingFor: string | null;
  canInspectRevision: boolean;
  onInspectRevision: () => void;
}) {
  const startedBy =
    props.provenance?.actorLabel ??
    props.provenance?.serviceAccountLabel ??
    (props.run.actorUserId ? "User" : props.run.serviceAccountId ? "Service account" : "System");
  return (
    <section class="detail-section">
      <h3 class="detail-section-label">Execution</h3>
      <dl class="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-2 text-xs">
        <dt class="text-dimmed">Channel</dt>
        <dd class="text-primary">{channelLabels[props.run.channel] ?? props.run.channel}</dd>
        <dt class="text-dimmed">Started by</dt>
        <dd class="text-primary">{startedBy}</dd>
        <dt class="text-dimmed">Run option</dt>
        <dd class="text-primary">{props.provenance?.launcherName ?? "Direct run"}</dd>
        <dt class="text-dimmed">Mode</dt>
        <dd class="text-primary">{props.run.mode === "dryRun" ? "Dry run" : "Execute"}</dd>
        <dt class="text-dimmed">Revision</dt>
        <dd>
          <Show when={props.canInspectRevision} fallback={<span class="text-primary tabular-nums">{props.run.workflowRevision}</span>}>
            <Button variant="ghost" size="xs" type="button" class="tabular-nums" onClick={props.onInspectRevision}>
              Revision {props.run.workflowRevision}
            </Button>
          </Show>
        </dd>
        <dt class="text-dimmed">Started</dt>
        <dd class="text-primary">{formatDate(props.run.startedAt)}</dd>
        <dt class="text-dimmed">Finished</dt>
        <dd class="text-primary">{formatDate(props.run.finishedAt)}</dd>
        <dt class="text-dimmed">Duration</dt>
        <dd class="text-primary tabular-nums">{formatDuration(props.run)}</dd>
        <dt class="text-dimmed">Last progress</dt>
        <dd class="text-primary">{formatDate(props.latestProgressAt)}</dd>
        <Show when={props.waitingFor}>
          {(summary) => (
            <>
              <dt class="text-dimmed">Waiting for</dt>
              <dd class="text-primary">{summary().replace(/^Waiting for\s*/i, "")}</dd>
            </>
          )}
        </Show>
      </dl>
      <Show when={props.run.error}>
        {(error) => (
          <NoticeCard tone="danger" icon={false} class="mt-3">
            {error().message}
          </NoticeCard>
        )}
      </Show>
      <Show when={props.run.resultMessage}>
        {(message) => (
          <NoticeCard tone="success" icon={false} class="mt-3">
            {message()}
          </NoticeCard>
        )}
      </Show>
    </section>
  );
}

export function WorkflowRunInputsSection(props: { inputs: WorkflowRunInputRow[] }) {
  return (
    <section class="detail-section">
      <h3 class="detail-section-label">Input</h3>
      <dl class="grid grid-cols-[minmax(7rem,auto)_1fr] gap-x-3 gap-y-2 text-xs">
        <For each={props.inputs} fallback={<span class="text-dimmed">No inputs.</span>}>
          {(input) => (
            <>
              <dt class="text-dimmed">{input.label}</dt>
              <dd class="break-words text-primary" title={input.name}>
                {input.display}
              </dd>
            </>
          )}
        </For>
      </dl>
    </section>
  );
}

export function WorkflowRunStepsSection(props: { steps: PublicWorkflowStepRun[]; truncated: boolean; loading: boolean }) {
  return (
    <section class="detail-section">
      <h3 class="detail-section-label">Steps</h3>
      <div class="flex flex-col gap-2">
        <For
          each={props.steps}
          fallback={<Placeholder align="left" class="py-3" description={<>{props.loading ? "Loading steps..." : "No step details."}</>} />}
        >
          {(step) => {
            const stepError = () => workflowStepErrorMessage(step.outcome);
            const outcomeSummary = () => workflowStepOutcomeSummary(step.outcome);
            const unresolved = () => workflowStepIssueReason(step.outcome) !== null;
            return (
              <div class="grid grid-cols-[auto_1fr_auto] items-start gap-2 py-1 text-xs">
                <StatusBadge tone={workflowStepStatusTone(step.status)} label={step.status} />
                <span class="min-w-0 truncate text-primary">
                  {step.sourcePath.length > 0 ? step.sourcePath.join(".") : step.key} · {step.action ?? step.kind}
                </span>
                <span class="text-dimmed tabular-nums">
                  {step.startedAt && step.finishedAt
                    ? `${Math.max(0, new Date(step.finishedAt).getTime() - new Date(step.startedAt).getTime())}ms`
                    : "-"}
                </span>
                <Show when={stepError()}>{(message) => <p class="col-span-3 text-red-600 dark:text-red-400">{message()}</p>}</Show>
                <Show when={outcomeSummary()}>
                  {(message) => (
                    <p class={`col-span-3 ${unresolved() ? "text-amber-600 dark:text-amber-400" : "text-dimmed"}`}>{message()}</p>
                  )}
                </Show>
                <For each={step.action ? workflowStepPlannedEffects(step.outcome) : []}>
                  {(effect) => (
                    <p class="col-span-3 pl-2 text-primary">
                      <span class="font-medium capitalize">{effect.title}</span>
                      <Show when={effect.detail}>
                        {" "}
                        · <span class="text-dimmed">{effect.detail}</span>
                      </Show>
                    </p>
                  )}
                </For>
              </div>
            );
          }}
        </For>
        <Show when={props.truncated}>
          <p class="text-xs text-dimmed">Showing the first 500 steps. Additional steps are not shown in this panel.</p>
        </Show>
      </div>
    </section>
  );
}

export function WorkflowRunDocumentsSection(props: {
  documents: WorkflowRunDocumentsState;
  downloadingDocumentId: string | null;
  downloadingAll: boolean;
  loadingMore: boolean;
  loadMoreError?: string;
  onDownload: (document: PublicDocument) => void;
  onDownloadAll: () => void;
  onLoadMore: (offset: number) => void;
}) {
  return (
    <section class="detail-section">
      <div class="flex items-center justify-between gap-2">
        <h3 class="detail-section-label mb-0">Generated documents</h3>
        <Show when={props.documents.total > 0}>
          <Button variant="ghost" size="sm" type="button" onClick={props.onDownloadAll} disabled={props.downloadingAll}>
            <i class={props.downloadingAll ? "ti ti-loader-2 animate-spin" : "ti ti-download"} /> All
          </Button>
        </Show>
      </div>
      <div class="mt-3 flex flex-col gap-2">
        <For
          each={props.documents.items}
          fallback={<Placeholder align="left" class="py-3" description={<>No documents generated by this run.</>} />}
        >
          {(document) => (
            <div class="grid grid-cols-[auto_1fr_auto] items-center gap-2 py-1 text-xs">
              <i class="ti ti-file-type-pdf text-dimmed" />
              <span class="min-w-0">
                <span class="block truncate text-primary">{document.filename}</span>
                <span class="block truncate text-dimmed">{document.number}</span>
              </span>
              <Tooltip.Anchor content="Download document">
                <IconButton
                  variant="ghost"
                  size="sm"
                  type="button"
                  label={`Download ${document.filename}`}
                  onClick={() => props.onDownload(document)}
                  disabled={props.downloadingDocumentId === document.id}
                >
                  {props.downloadingDocumentId === document.id ? <i class="ti ti-loader-2 animate-spin" /> : <i class="ti ti-download" />}
                </IconButton>
              </Tooltip.Anchor>
            </div>
          )}
        </For>
        <Show when={props.documents.hasMore && props.documents.nextOffset !== null ? props.documents.nextOffset : null}>
          {(offset) => (
            <Button
              variant="secondary"
              size="sm"
              type="button"
              class="self-center"
              disabled={props.loadingMore}
              onClick={() => props.onLoadMore(offset())}
            >
              <i class={props.loadingMore ? "ti ti-loader-2 animate-spin" : "ti ti-chevron-down"} />
              Load more documents
            </Button>
          )}
        </Show>
        <Show when={props.loadMoreError}>{(error) => <p class="text-xs text-red-600 dark:text-red-400">{error()}</p>}</Show>
      </div>
    </section>
  );
}
