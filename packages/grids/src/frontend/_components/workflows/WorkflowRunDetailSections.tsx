import {
  Button,
  DescriptionList,
  DetailPanel,
  FileGrid,
  FileTypeIcon,
  fileKindLabel,
  IconButton,
  NoticeCard,
  Placeholder,
  StatusBadge,
  Tooltip,
  useLocale,
} from "@k2b/ui";
import { For, Show } from "solid-js";
import type { PublicDocument } from "../documents/public-document-types";
import type { PublicWorkflowRun, PublicWorkflowStepRun, PublicWorkspaceWorkflowRunDetail } from "../workspace/workspace-public-state-model";
import { financialExportMessages } from "./financial-export-messages";
import { workflowMessages } from "./messages";
import {
  formatWorkflowRunDate as formatDate,
  formatWorkflowRunDuration as formatDuration,
  workflowChannelLabel,
  workflowStepErrorMessage,
  workflowStepIssueReason,
  workflowStepOutcomeSummary,
  workflowStepPlannedEffects,
  workflowStepStatusLabel,
  workflowStepStatusTone,
} from "./workflow-display";
import { type WorkflowRunDocumentsState, workflowRunDownloadFormat } from "./workflow-run-documents";

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
}) {
  const locale = useLocale();
  const t = () => workflowMessages.resolve([locale()]).t;
  const startedBy = () =>
    props.provenance?.actorLabel ??
    props.provenance?.serviceAccountLabel ??
    (props.run.actorUserId ? t().user : props.run.serviceAccountId ? t().serviceAccount : t().system);
  return (
    <>
      <Show when={props.run.error}>{(error) => <NoticeCard tone="danger">{error().message}</NoticeCard>}</Show>
      <Show when={props.run.resultMessage}>{(message) => <NoticeCard tone="success">{message()}</NoticeCard>}</Show>
      <DetailPanel.Section title={t().execution}>
        <DescriptionList
          layout="rows"
          size="sm"
          items={[
            { term: t().startedBy, description: startedBy() },
            { term: t().runOption, description: props.provenance?.launcherName ?? t().directRun },
            { term: t().started, description: formatDate(props.run.startedAt, locale()) },
            { term: t().finished, description: formatDate(props.run.finishedAt, locale()) },
            { term: t().duration, description: <span class="tabular-nums">{formatDuration(props.run, locale())}</span> },
            { term: t().lastProgress, description: formatDate(props.latestProgressAt, locale()) },
            ...(props.waitingFor
              ? [{ term: t().waitingFor, description: props.waitingFor.replace(/^(Waiting for|Wartet auf)\s*/i, "") }]
              : []),
          ]}
        />
      </DetailPanel.Section>
    </>
  );
}

/** ID, channel, mode, and revision: what support and audits ask for, collapsed under "More about this run". */
export function WorkflowRunTechnicalSection(props: { run: PublicWorkflowRun; canInspectRevision: boolean; onInspectRevision: () => void }) {
  const locale = useLocale();
  const t = () => workflowMessages.resolve([locale()]).t;
  return (
    <DetailPanel.Section title={t().technicalDetails} collapsible summary={t().runTechnicalSummary}>
      <DescriptionList
        layout="rows"
        size="sm"
        items={[
          { term: t().runId, description: <span class="block truncate">{props.run.id}</span> },
          { term: t().channel, description: workflowChannelLabel(props.run.channel, locale()) },
          { term: t().mode, description: props.run.mode === "dryRun" ? t().dryRun : t().execute },
          {
            term: t().revision,
            description: (
              <Show when={props.canInspectRevision} fallback={<span class="tabular-nums">{props.run.workflowRevision}</span>}>
                <Button variant="text" size="xs" type="button" class="tabular-nums" onClick={props.onInspectRevision}>
                  {t().revisionNumber({ revision: props.run.workflowRevision })}
                </Button>
              </Show>
            ),
          },
        ]}
      />
    </DetailPanel.Section>
  );
}

export function WorkflowRunInputsSection(props: { inputs: WorkflowRunInputRow[] }) {
  const locale = useLocale();
  const t = () => workflowMessages.resolve([locale()]).t;
  return (
    <DetailPanel.Section title={t().input}>
      <Show when={props.inputs.length > 0} fallback={<p class="grids-details-none">{t().noInputs}</p>}>
        <DescriptionList
          layout="rows"
          size="sm"
          items={props.inputs.map((input) => ({
            term: input.label,
            description: (
              <span class="break-words" title={input.name}>
                {input.display}
              </span>
            ),
          }))}
        />
      </Show>
    </DetailPanel.Section>
  );
}

export function WorkflowRunStepsSection(props: {
  steps: PublicWorkflowStepRun[];
  truncated: boolean;
  loading: boolean;
  onInspectExport?: (receiptId: string) => void;
}) {
  const locale = useLocale();
  const t = () => workflowMessages.resolve([locale()]).t;
  return (
    <DetailPanel.Section title={t().steps}>
      <div class="flex flex-col gap-2">
        <For
          each={props.steps}
          fallback={
            <Show when={props.loading} fallback={<p class="grids-details-none">{t().noStepDetails}</p>}>
              <Placeholder state="loading" variant="compact" align="left" title={t().loadingSteps} />
            </Show>
          }
        >
          {(step) => {
            const stepError = () => workflowStepErrorMessage(step.outcome, locale());
            const outcomeSummary = () => workflowStepOutcomeSummary(step.outcome, locale());
            const unresolved = () => workflowStepIssueReason(step.outcome) !== null;
            return (
              <div class="grid grid-cols-[auto_1fr_auto] items-start gap-2 py-1 text-xs">
                <StatusBadge tone={workflowStepStatusTone(step.status)} label={workflowStepStatusLabel(step.status, locale())} />
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
                <Show when={step.documentConfirmation && props.onInspectExport}>
                  <div class="col-span-3">
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        if (step.documentConfirmation) props.onInspectExport?.(step.documentConfirmation.receiptId);
                      }}
                    >
                      <i class="ti ti-file-check" aria-hidden="true" /> {financialExportMessages.resolve([locale()]).t.title}
                    </Button>
                  </div>
                </Show>
                <For each={step.action ? workflowStepPlannedEffects(step.outcome, locale()) : []}>
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
          <p class="text-xs text-dimmed">{t().stepsTruncated}</p>
        </Show>
      </div>
    </DetailPanel.Section>
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
  const locale = useLocale();
  const t = () => workflowMessages.resolve([locale()]).t;
  const downloadAll = () => {
    const format = workflowRunDownloadFormat(props.documents);
    if (format === "pdf") return { label: t().downloadAllPdf, hint: t().downloadAllPdfHint };
    if (format === "zip") return { label: t().downloadAllZip, hint: t().downloadAllZipHint };
    return { label: t().downloadAll, hint: t().downloadAllMixedHint };
  };
  return (
    <DetailPanel.Section
      title={t().generatedDocuments}
      count={props.documents.total || undefined}
      actions={
        <Show when={props.documents.total > 0}>
          <Tooltip.Anchor content={downloadAll().hint}>
            <Button variant="ghost" size="xs" type="button" onClick={props.onDownloadAll} disabled={props.downloadingAll}>
              <i class={props.downloadingAll ? "ti ti-loader-2 animate-spin" : "ti ti-download"} aria-hidden="true" /> {downloadAll().label}
            </Button>
          </Tooltip.Anchor>
        </Show>
      }
    >
      <div class="flex flex-col gap-2">
        <Show when={props.documents.items.length > 0} fallback={<p class="grids-details-none">{t().noGeneratedDocuments}</p>}>
          <FileGrid
            rows={props.documents.items}
            getRowId={(document) => document.id}
            label={t().generatedDocuments}
            layout="list"
            limit={5}
            actionVisibility="progressive"
            renderPreview={(document) => <FileTypeIcon name={document.filename} />}
            renderLabel={(document) => document.filename}
            renderMeta={(document) => `${fileKindLabel({ name: document.filename }, locale())} · ${document.number}`}
            renderActions={(document) => (
              <Tooltip.Anchor content={t().downloadDocument}>
                <IconButton
                  variant="ghost"
                  size="sm"
                  type="button"
                  label={t().downloadNamed({ name: document.filename })}
                  onClick={() => props.onDownload(document)}
                  disabled={props.downloadingDocumentId === document.id}
                >
                  <i
                    class={props.downloadingDocumentId === document.id ? "ti ti-loader-2 animate-spin" : "ti ti-download"}
                    aria-hidden="true"
                  />
                </IconButton>
              </Tooltip.Anchor>
            )}
            onOpen={props.onDownload}
          />
        </Show>
        <Show when={props.documents.hasMore && props.documents.nextOffset !== null ? props.documents.nextOffset : null}>
          {(offset) => (
            <Button
              variant="ghost"
              size="sm"
              type="button"
              class="w-fit"
              disabled={props.loadingMore}
              onClick={() => props.onLoadMore(offset())}
            >
              <i class={props.loadingMore ? "ti ti-loader-2 animate-spin" : "ti ti-chevron-down"} aria-hidden="true" />
              {t().loadMoreDocuments}
            </Button>
          )}
        </Show>
        <Show when={props.loadMoreError}>{(error) => <p class="text-xs text-red-600 dark:text-red-400">{error()}</p>}</Show>
      </div>
    </DetailPanel.Section>
  );
}
