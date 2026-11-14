import { startWorkflowAiRuntime, stopWorkflowAiRuntime } from "@k2b/cloud/ai/tasks";
import { createRuntimeLifecycle } from "@k2b/cloud/services";

/** Shared application inference outlives Mail rules; stop only after both consumers drain. */
export const applicationAiRuntime = createRuntimeLifecycle({
  start: () => startWorkflowAiRuntime(),
  stop: () => stopWorkflowAiRuntime(),
});
