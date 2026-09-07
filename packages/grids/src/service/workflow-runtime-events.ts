import { lazySync } from "@valentinkolb/cloud";
import { latestTopicCursor, logger } from "@valentinkolb/cloud/services";

const log = logger("grids:workflow-runtime-events");
const TENANT_ID = "global";

type WorkflowRuntimeEvent = {
  workflowId: string;
};

const workflowRuntimeTopic = lazySync((sync) =>
  sync.topic<WorkflowRuntimeEvent>({
    id: "grids:workflow-runtime",
    retention: { maxAgeMs: 86400000, maxBytes: 16777216 },
    maxPayloadBytes: 2000,
  }),
);

export const emitWorkflowRuntimeEvent = async (workflowId: string): Promise<void> => {
  try {
    await workflowRuntimeTopic().publish({
      tenantId: TENANT_ID,
      orderingKey: workflowId,
      data: { workflowId },
    });
  } catch (error) {
    log.warn("Failed to publish workflow runtime event", {
      workflowId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

export const latestWorkflowRuntimeEventCursor = async (): Promise<string> =>
  latestTopicCursor({ topic: workflowRuntimeTopic(), resourceId: "grids:workflow-runtime", tenantId: TENANT_ID });

export const liveWorkflowRuntimeEvents = (config: { after?: string | null; signal?: AbortSignal }) =>
  workflowRuntimeTopic()
    .hub({ tenantId: TENANT_ID })
    .subscribe({
      after: config.after ?? undefined,
      signal: config.signal,
    });
