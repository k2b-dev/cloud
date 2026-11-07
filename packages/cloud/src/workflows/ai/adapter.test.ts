import { expect, spyOn, test } from "bun:test";
import { wakeWorkflowAiTask } from "@k2b/cloud/ai/tasks";
import { AI_WORKFLOW_ACTIONS } from "@k2b/cloud/workflows";
import { createWorkflowWorker } from "@k2b/cloud/workflows/store";
import * as runs from "../store/runs";
import * as worker from "../store/worker-runtime";

test("workflow workers share AI completion signals with the shared task entrypoint", async () => {
  expect(createWorkflowWorker).toBeFunction();
  expect(AI_WORKFLOW_ACTIONS.aiExtractData).toBeDefined();
  const wakeRuns = spyOn(runs, "wakeWorkflowRunsWaitingOn").mockResolvedValue([]);
  const notify = spyOn(worker, "notifyWorkflowWorker").mockImplementation(() => {});
  try {
    await wakeWorkflowAiTask({ appId: "example", id: "ai-task", runId: "existing-workflow-run" });
    expect(wakeRuns).toHaveBeenCalledWith({ appId: "example", kind: "ai.workflow-task", key: "ai-task" });
    expect(notify).toHaveBeenCalledWith("example");
  } finally {
    wakeRuns.mockRestore();
    notify.mockRestore();
  }
});
