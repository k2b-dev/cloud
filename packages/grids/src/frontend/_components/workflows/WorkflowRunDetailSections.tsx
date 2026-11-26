import { useLocale } from "@k2b/ui";
import { Button, Chip, Facts, Loading, Row, Section } from "@k2b/ui/v2";
import { For, Show } from "solid-js";
import { documentFormatLabel } from "../documents/document-workspace-utils";
import type { PublicDocument } from "../documents/public-document-types";
import { kindMark } from "../frame/kind-marks";
import type { PublicWorkflowRun, PublicWorkflowStepRun, PublicWorkspaceWorkflowRunDetail } from "../workspace/workspace-public-state-model";
import { financialExportMessages } from "./financial-export-messages";
import { workflowMessages } from "./messages";
import {
  formatWorkflowRunDate as formatDate,
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

/** Who or what started the run, in words. */
export const runStartedBy = (
  run: PublicWorkflowRun,
  provenance: PublicWorkspaceWorkflowRunDetail["provenance"] | null,
  locale: string,
): string => {
  const { t } = workflowMessages.resolve([locale]);
  return (
    provenance?.actorLabel ??
    provenance?.serviceAccountLabel ??
    (run.actorUserId ? t.user : run.serviceAccountId ? t.serviceAccount : t.system)
  );
};

/** How the run went: its option, its times and what it waits for (who started it and how long it took stand in its head). */
export function WorkflowRunExecutionSection(props: {
  run: PublicWorkflowRun;
  provenance: PublicWorkspaceWorkflowRunDetail["provenance"] | null;
  latestProgressAt: string | null;
  waitingFor: string | null;
}) {
  const locale = useLocale();
  const t = () => workflowMessages.resolve([locale()]).t;
  return (
    <Section title={t().execution}>
      <Facts
        items={[
          ...(props.run.resultMessage ? [{ label: t().result, value: props.run.resultMessage }] : []),
          { label: t().runOption, value: props.provenance?.launcherName ?? t().directRun },
          { label: t().lastProgress, value: formatDate(props.latestProgressAt, locale()) },
          ...(props.waitingFor ? [{ label: t().waitingFor, value: props.waitingFor.replace(/^(Waiting for|Wartet auf)\s*/i, "") }] : []),
        ]}
      />
    </Section>
  );
}

/** ID, channel, mode and revision: what support and audits ask for, with the ID to copy. */
export function WorkflowRunTechnicalSection(props: { run: PublicWorkflowRun; canInspectRevision: boolean; onInspectRevision: () => void }) {
  const locale = useLocale();
  const t = () => workflowMessages.resolve([locale()]).t;
  return (
    <Section title={t().technicalDetails}>
      <Facts
        items={[
          { label: t().runId, value: props.run.id, mono: true, copy: props.run.id },
          { label: t().channel, value: workflowChannelLabel(props.run.channel, locale()) },
          { label: t().mode, value: props.run.mode === "dryRun" ? t().dryRun : t().execute },
          {
            label: t().revision,
            value: (
              <Show when={props.canInspectRevision} fallback={String(props.run.workflowRevision)}>
                <Button variant="text" onClick={props.onInspectRevision}>
                  {t().revisionNumber({ revision: props.run.workflowRevision })}
                </Button>
              </Show>
            ),
          },
        ]}
      />
    </Section>
  );
}

export function WorkflowRunInputsSection(props: { inputs: WorkflowRunInputRow[] }) {
  const locale = useLocale();
  const t = () => workflowMessages.resolve([locale()]).t;
  return (
    // an empty section says so in one quiet line under its title
    <Section title={t().input} summary={props.inputs.length === 0 ? t().noInputs : undefined}>
      <Show when={props.inputs.length > 0}>
        <Facts items={props.inputs.map((input) => ({ label: input.label, value: input.display }))} />
      </Show>
    </Section>
  );
}

/** A step's state as colour only where it went wrong; a step that ran stays a quiet word. */
const stepStatus = (tone: ReturnType<typeof workflowStepStatusTone>) =>
  tone === "error" ? ("bad" as const) : tone === "running" ? ("warn" as const) : undefined;

export function WorkflowRunStepsSection(props: {
  steps: PublicWorkflowStepRun[];
  truncated: boolean;
  loading: boolean;
  onInspectExport?: (receiptId: string) => void;
}) {
  const locale = useLocale();
  const t = () => workflowMessages.resolve([locale()]).t;
  return (
    <Section
      title={t().steps}
      count={props.steps.length || undefined}
      summary={props.truncated ? t().stepsTruncated : props.steps.length === 0 && !props.loading ? t().noStepDetails : undefined}
    >
      <For each={props.steps} fallback={<Show when={props.loading}>{<Loading rows={3} lines={2} />}</Show>}>
        {(step) => {
          const error = () => workflowStepErrorMessage(step.outcome, locale());
          const summary = () => workflowStepOutcomeSummary(step.outcome, locale());
          const effects = () =>
            (step.action ? workflowStepPlannedEffects(step.outcome, locale()) : [])
              .map((effect) => (effect.detail ? `${effect.title} · ${effect.detail}` : effect.title))
              .join(" · ");
          const status = () => stepStatus(workflowStepStatusTone(step.status));
          const unresolved = () => workflowStepIssueReason(step.outcome) !== null;
          const ms = () =>
            step.startedAt && step.finishedAt
              ? `${Math.max(0, new Date(step.finishedAt).getTime() - new Date(step.startedAt).getTime()).toLocaleString(locale())} ms`
              : "–";
          return (
            <Row
              lines={[
                `${step.sourcePath.length > 0 ? step.sourcePath.join(".") : step.key} · ${step.action ?? step.kind}`,
                error() ?? summary() ?? (effects() || workflowStepStatusLabel(step.status, locale())),
              ]}
              time={ms()}
              states={
                status() || unresolved() ? (
                  <Chip status={status() ?? "warn"}>{workflowStepStatusLabel(step.status, locale())}</Chip>
                ) : undefined
              }
              action={
                step.documentConfirmation && props.onInspectExport
                  ? {
                      label: financialExportMessages.resolve([locale()]).t.title,
                      icon: "file-check",
                      onClick: () => {
                        if (step.documentConfirmation) props.onInspectExport?.(step.documentConfirmation.receiptId);
                      },
                    }
                  : undefined
              }
            />
          );
        }}
      </For>
    </Section>
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
    return format === "pdf" ? t().downloadAllPdf : format === "zip" ? t().downloadAllZip : t().downloadAll;
  };
  const formatOf = (document: PublicDocument) =>
    documentFormatLabel(document.artifacts.find((artifact) => artifact.key === document.primaryArtifactKey)?.mimeType);
  const next = () => (props.documents.hasMore && props.documents.nextOffset !== null ? props.documents.nextOffset : null);
  return (
    <Section
      title={t().generatedDocuments}
      count={props.documents.total || undefined}
      actions={
        props.documents.total > 0
          ? [{ label: downloadAll(), icon: "download", disabled: props.downloadingAll, onClick: props.onDownloadAll }]
          : undefined
      }
      summary={props.loadMoreError ?? (props.documents.items.length === 0 ? t().noGeneratedDocuments : undefined)}
      more={
        next() !== null
          ? { label: t().loadMoreDocuments, disabled: props.loadingMore, onClick: () => props.onLoadMore(next()!) }
          : undefined
      }
    >
      <Show when={props.documents.items.length > 0}>
        <For each={props.documents.items}>
          {(document) => (
            <Row
              mark={{ ...kindMark("documentTemplate"), kind: formatOf(document) }}
              lines={[document.filename, `${formatOf(document)} · ${document.number}`]}
              onOpen={() => {
                if (props.downloadingDocumentId !== document.id) props.onDownload(document);
              }}
              end={
                <Button
                  icon="download"
                  variant="ghost"
                  label={t().downloadNamed({ name: document.filename })}
                  busy={props.downloadingDocumentId === document.id}
                  onClick={() => props.onDownload(document)}
                />
              }
            />
          )}
        </For>
      </Show>
    </Section>
  );
}
