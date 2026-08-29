import { DataPanel, DataTable, type DataTableColumn, NoticeCard, StatusBadge, StructuredDataPreview, useLocale } from "@k2b/ui";
import { formatDurationMs, formatNumber, formatRelative } from "@valentinkolb/cloud/shared";
import type { WorkflowRunState } from "@valentinkolb/cloud/workflows";
import type { WorkflowRunDetail, WorkflowStepSummary } from "@valentinkolb/cloud/workflows/store";
import type { JSX } from "solid-js";
import { type WorkflowsFilterState, workflowsFilter } from "../filters";
import { EFFECT_TONE, RUN_TONE, runErrorSummary, STEP_TONE, stepDetail } from "../presentation";
import WorkflowRunActions from "./WorkflowRunActions.island";
import { gatewayOpsMessages, type GatewayOpsMessages } from "../../../messages";

const attentionStepFor = (detail: WorkflowRunDetail) =>
  detail.steps.find((step) => step.state === "needs_attention" && (step.effectState === "executing" || step.effectState === "ambiguous"));

const stateLabel = (state: WorkflowRunState | string, t: GatewayOpsMessages): string => {
  if (state === "queued") return t.queued;
  if (state === "running") return t.running;
  if (state === "waiting") return t.waiting;
  if (state === "succeeded" || state === "completed" || state === "planned" || state === "terminal") return t.succeeded;
  if (state === "failed") return t.failed;
  if (state === "canceled") return t.canceled;
  if (state === "needs_attention") return t.needsAttentionLabel;
  if (state === "executing") return t.executing;
  if (state === "ambiguous") return t.ambiguous;
  return state;
};

const RunSteps = (props: { steps: WorkflowStepSummary[] }) => {
  const locale = useLocale();
  const { t } = gatewayOpsMessages.resolve([locale()]);
  const columns: DataTableColumn<WorkflowStepSummary>[] = [
    { id: "step", header: t.step, cellClass: "min-w-[160px]" },
    { id: "action", header: t.actionLabel },
    { id: "state", header: t.state },
    { id: "effect", header: t.effect },
    { id: "details", header: t.details, cellClass: "min-w-[220px]" },
    { id: "attempts", header: t.attempts, align: "right" },
    { id: "duration", header: t.duration, align: "right" },
  ];
  return (
  <DataTable
    rows={props.steps}
    columns={columns}
    getRowId={(step) => step.stepKey}
    density="compact"
    class="overflow-x-auto"
    empty={t.noRecordedStep}
    renderCell={({ row, col, value, render }) => {
      if (col.id === "step") return <span class="font-mono text-xs">{row.stepKey}</span>;
      if (col.id === "action") return <span class="text-secondary">{row.action ?? row.kind}</span>;
      if (col.id === "state") return <StatusBadge tone={STEP_TONE[row.state] ?? "neutral"} label={stateLabel(row.state, t)} variant="dot" />;
      if (col.id === "effect")
        return row.effectState ? (
          <StatusBadge tone={EFFECT_TONE[row.effectState] ?? "neutral"} label={stateLabel(row.effectState, t)} variant="dot" />
        ) : (
          <span class="text-dimmed">—</span>
        );
      if (col.id === "details")
        return (
          <span class="block max-w-[360px] truncate text-secondary" title={stepDetail(row, t.waitingOn)}>
            {stepDetail(row, t.waitingOn)}
          </span>
        );
      if (col.id === "attempts") return <span class="text-dimmed">{formatNumber(row.attempt + 1, { locale: locale() })}</span>;
      if (col.id === "duration") return <span class="text-secondary">{formatDurationMs(row.durationMs, { locale: locale() })}</span>;
      return render(value);
    }}
  />
  );
};

const RunFact = (props: { label: string; children: JSX.Element }) => (
  <div class="min-w-0">
    <dt class="text-[10px] uppercase tracking-wider text-dimmed">{props.label}</dt>
    <dd class="mt-0.5 truncate text-xs text-primary">{props.children}</dd>
  </div>
);

const ChildLinks = (props: { detail: WorkflowRunDetail; state: WorkflowsFilterState }) => {
  const locale = useLocale();
  const { t } = gatewayOpsMessages.resolve([locale()]);
  if (!Object.values(props.detail.children).some((count) => count > 0)) return null;
  return (
    <div class="flex flex-wrap items-center gap-2">
      <span class="text-dimmed">{t.children}</span>
      {(Object.entries(props.detail.children) as [WorkflowRunState, number][])
        .filter(([, count]) => count > 0)
        .map(([childState, count]) => (
          <a
            href={workflowsFilter.build(props.state, {
              view: "runs",
              run: "",
              parent: props.detail.id,
              state: childState,
              page: 1,
            })}
          >
            <StatusBadge
              tone={RUN_TONE[childState]}
              label={`${formatNumber(count, { locale: locale() })} ${stateLabel(childState, t).toLocaleLowerCase(locale())}`}
              variant="dot"
            />
          </a>
        ))}
    </div>
  );
};

const RunOverview = (props: { detail: WorkflowRunDetail; state: WorkflowsFilterState }) => {
  const locale = useLocale();
  const { t } = gatewayOpsMessages.resolve([locale()]);
  return (
  <section>
    <h3 class="text-xs font-semibold text-primary">{t.runOverview}</h3>
    <dl class="mt-2 grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-4">
      <RunFact label={t.trigger}>{props.detail.eventType ?? t.directInvocation}</RunFact>
      <RunFact label={t.occurred}>{formatRelative(props.detail.occurredAt, { locale: locale() })}</RunFact>
      <RunFact label={t.startLag}>{formatDurationMs(props.detail.startLagMs, { locale: locale() })}</RunFact>
      <RunFact label={t.duration}>{formatDurationMs(props.detail.durationMs, { locale: locale() })}</RunFact>
      {props.detail.parentRunId ? (
        <RunFact label={t.parentRun}>
          <a
            class="font-mono text-[11px] hover:underline"
            href={workflowsFilter.build(props.state, { view: "runs", run: props.detail.parentRunId, parent: "" })}
          >
            {props.detail.parentRunId}
          </a>
        </RunFact>
      ) : null}
    </dl>
    <div class="mt-3">
      <ChildLinks detail={props.detail} state={props.state} />
    </div>
  </section>
  );
};

const Disclosure = (props: { title: string; description: string; children: JSX.Element }) => (
  <details class="group rounded-[var(--ui-radius-control)] bg-[var(--ui-surface-subtle)]">
    <summary class="focus-ui flex cursor-pointer list-none items-center justify-between gap-3 rounded-[var(--ui-radius-control)] px-3 py-2.5">
      <span class="min-w-0">
        <span class="block text-xs font-medium text-primary">{props.title}</span>
        <span class="block truncate text-[11px] text-dimmed">{props.description}</span>
      </span>
      <i class="ti ti-chevron-down shrink-0 text-xs text-dimmed transition-transform group-open:rotate-180" aria-hidden="true" />
    </summary>
    <div class="px-3 pb-3">{props.children}</div>
  </details>
);

const RunPayloads = (props: { detail: WorkflowRunDetail }) => {
  const locale = useLocale();
  const { t } = gatewayOpsMessages.resolve([locale()]);
  return <Disclosure title={t.inputsOutputs} description={t.invocationDataDescription}>
    <div class="grid gap-3 lg:grid-cols-2">
      <StructuredDataPreview title={t.inputs} data={props.detail.inputs} empty={t.noInputs} />
      <StructuredDataPreview title={t.result} data={props.detail.result} empty={props.detail.resultMessage ?? t.noResult} />
      {props.detail.eventData ? <StructuredDataPreview title={t.eventPayload} data={props.detail.eventData} class="lg:col-span-2" /> : null}
    </div>
  </Disclosure>;
};

const DurableExecutionData = (props: { detail: WorkflowRunDetail }) => {
  const locale = useLocale();
  const { t } = gatewayOpsMessages.resolve([locale()]);
  return <Disclosure title={t.technicalDetails} description={t.technicalDetailsDescription}>
    <div class="flex flex-col gap-3">
      <StructuredDataPreview
        title={t.identity}
        data={{
          runId: props.detail.id,
          scopeId: props.detail.scopeId,
          parentRunId: props.detail.parentRunId,
          revision: props.detail.revision,
        }}
      />
      {props.detail.error ? <StructuredDataPreview title={t.error} data={props.detail.error} /> : null}
      {Object.keys(props.detail.effectBudget).length > 0 ? (
        <StructuredDataPreview
          title={t.effectBudget}
          data={Object.fromEntries(
            Object.entries(props.detail.effectBudget).map(([dimension, limit]) => [
              dimension,
              { used: props.detail.effectsUsed[dimension] ?? 0, limit },
            ]),
          )}
        />
      ) : null}
      <StructuredDataPreview
        title={t.stepJournal}
        data={props.detail.steps.map((step) => ({
          stepKey: step.stepKey,
          sourcePath: step.sourcePath,
          iterationPath: step.iterationPath,
          outcome: step.outcome,
          dependency: step.dependency,
          effectKey: step.effectKey,
          effectState: step.effectState,
        }))}
      />
      <StructuredDataPreview title={t.pinnedDefinition} data={{ source: props.detail.source }} />
    </div>
  </Disclosure>;
};

const RunOutcome = (props: { detail: WorkflowRunDetail }) => {
  const locale = useLocale();
  const { t } = gatewayOpsMessages.resolve([locale()]);
  const attentionStep = attentionStepFor(props.detail);
  const error = runErrorSummary(props.detail.error);
  if (attentionStep)
    return (
      <NoticeCard
        tone="warning"
        title={t.needsOperatorDecision({ name: attentionStep.action ?? attentionStep.stepKey })}
        detail={t.operatorDecisionDetail}
      />
    );
  if (error)
    return (
      <NoticeCard
        tone="danger"
        title={error.message}
        detail={
          [error.code, error.retryable === null ? null : error.retryable ? t.runCanRetry : t.runWillNotRetry]
            .filter(Boolean)
            .join(" · ") || undefined
        }
      />
    );
  return null;
};

const RunBody = (props: { detail: WorkflowRunDetail; state: WorkflowsFilterState }) => {
  const locale = useLocale();
  const { t } = gatewayOpsMessages.resolve([locale()]);
  return (
    <>
      <div class="flex flex-col gap-4 px-3 py-3">
        <RunOutcome detail={props.detail} />
        <RunOverview detail={props.detail} state={props.state} />
      </div>
      <div class="px-3 pb-2">
        <h3 class="text-xs font-semibold text-primary">{t.executionSteps}</h3>
        <p class="text-[10px] text-dimmed">
          {t.recordedSteps({ count: props.detail.steps.length })}
        </p>
      </div>
      <RunSteps steps={props.detail.steps} />
      <div class="flex flex-col gap-2 px-3 py-3">
        <RunPayloads detail={props.detail} />
        <DurableExecutionData detail={props.detail} />
      </div>
    </>
  );
};

export default function WorkflowRunDetailView(props: { detail: WorkflowRunDetail; state: WorkflowsFilterState }) {
  const locale = useLocale();
  const { t } = gatewayOpsMessages.resolve([locale()]);
  const attentionStep = attentionStepFor(props.detail);
  return (
    <DataPanel
      title={`${props.detail.workflowName} · ${t.revision({ revision: props.detail.revision })}`}
      subtitle={
        <span class="mt-1 flex flex-wrap items-center gap-2">
          <StatusBadge tone={RUN_TONE[props.detail.state]} label={stateLabel(props.detail.state, t)} />
          <span class="text-dimmed">
            {props.detail.appId} · {props.detail.mode} · {t.attemptNumber({ count: props.detail.attempt })} · {formatRelative(props.detail.createdAt, { locale: locale() })}
          </span>
        </span>
      }
      actions={
        <div class="flex flex-wrap items-center justify-end gap-2">
          <a class="text-xs text-secondary hover:underline" href={workflowsFilter.build(props.state, { run: "" })}>
            {t.backToView({ view: props.state.view })}
          </a>
          <WorkflowRunActions
            runId={props.detail.id}
            state={props.detail.state}
            attentionStep={
              attentionStep
                ? {
                    stepKey: attentionStep.stepKey,
                    action: attentionStep.action,
                  }
                : undefined
            }
          />
        </div>
      }
    >
      <RunBody detail={props.detail} state={props.state} />
    </DataPanel>
  );
}
