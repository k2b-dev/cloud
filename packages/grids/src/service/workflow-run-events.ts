import { lazySync } from "@k2b/cloud";
import { latestTopicCursor, logger } from "@k2b/cloud/services";
import {
  type GridsWorkflowRunEvent,
  toWorkflowRunEventSummary,
  toWorkflowRunStepSummary,
  type WorkflowRunEventScope,
} from "../lib/workflow-run-events";
import type { GridsWorkflowRun, GridsWorkflowStepRun } from "../workflows/contracts";

const log = logger("grids:workflow-run-events");
const workflowRunTopic = lazySync((sync) =>
  sync.topic<GridsWorkflowRunEvent>({
    id: "grids:workflow-runs",
    retention: { maxAgeMs: 86400000, maxBytes: 268435456 },
    maxPayloadBytes: 68000,
  }),
);

const tenantId = (baseId: string, workflowId: string): string => `${baseId}:${workflowId}`;

type WorkflowRunEventPublisher = (event: Parameters<ReturnType<typeof workflowRunTopic>["publish"]>[0]) => Promise<unknown>;

export const createWorkflowRunEventNotifier =
  (publish: WorkflowRunEventPublisher) =>
  async (
    run: GridsWorkflowRun,
    steps: GridsWorkflowStepRun[] = [],
    scope: WorkflowRunEventScope = { kind: "workflow" },
    transitionId?: string,
  ): Promise<void> => {
    if (!run.workflowId) return;
    try {
      await publish({
        tenantId: tenantId(run.baseId, run.workflowId),
        orderingKey: run.workflowId,
        idempotencyKey: `${run.id}:${run.status}:${transitionId ?? run.finishedAt ?? run.startedAt ?? run.createdAt}`,
        data: {
          v: 1,
          baseId: run.baseId,
          workflowId: run.workflowId,
          run: toWorkflowRunEventSummary(run),
          scope,
          steps: steps.map(toWorkflowRunStepSummary),
        },
      });
    } catch (error) {
      log.warn("Workflow run update publish failed", {
        workflowId: run.workflowId,
        runId: run.id,
        status: run.status,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

export const notifyWorkflowRunEvent = createWorkflowRunEventNotifier((event) => workflowRunTopic().publish(event));

export const latestWorkflowRunEventCursor = async (baseId: string, workflowId: string): Promise<string> =>
  latestTopicCursor({ topic: workflowRunTopic(), resourceId: "grids:workflow-runs", tenantId: tenantId(baseId, workflowId) });

export const liveWorkflowRunEvents = (config: { baseId: string; workflowId: string; after?: string | null; signal?: AbortSignal }) =>
  workflowRunTopic()
    .hub({ tenantId: tenantId(config.baseId, config.workflowId) })
    .subscribe({
      after: config.after ?? undefined,
      signal: config.signal,
    });
