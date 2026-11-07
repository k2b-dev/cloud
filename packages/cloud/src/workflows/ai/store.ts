import { setWorkflowAiTaskWake, WORKFLOW_AI_DEPENDENCY_KIND } from "../../ai/tasks/store";
import { wakeWorkflowRunsWaitingOn } from "../store/runs";
import { notifyWorkflowWorker } from "../store/worker-runtime";

setWorkflowAiTaskWake(async (task) => {
  await wakeWorkflowRunsWaitingOn({ appId: task.appId, kind: WORKFLOW_AI_DEPENDENCY_KIND, key: task.id });
  notifyWorkflowWorker(task.appId);
});

export * from "../../ai/tasks/store";
