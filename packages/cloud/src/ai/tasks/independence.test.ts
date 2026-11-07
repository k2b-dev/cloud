import { expect, spyOn, test } from "bun:test";
import { resolve } from "node:path";
import * as signals from "../../_internal/workflow-signals";
import { wakeWorkflowAiTask } from "./store";

test("retained AI entrypoints bundle without the workflow engine", async () => {
  const result = await Bun.build({
    entrypoints: ["./index.ts", "../application-tasks.ts", "../chat-task-contracts.ts"].map((path) => resolve(import.meta.dir, path)),
    target: "bun",
    packages: "external",
    plugins: [
      {
        name: "no-workflow-engine",
        setup(build) {
          build.onResolve({ filter: /workflows\// }, ({ importer, path }) => {
            throw new Error(`Retained AI code depends on the workflow engine: ${importer} -> ${path}`);
          });
        },
      },
    ],
  });
  expect(result.logs.filter((log) => log.level === "error")).toEqual([]);
  expect(result.success).toBe(true);
  expect(result.outputs).toHaveLength(3);
});

test("application task settlement needs no workflow wake adapter", async () => {
  await expect(wakeWorkflowAiTask({ appId: "example", id: "application-task", runId: null })).resolves.toBeUndefined();
});

test("an application-only AI worker wakes run-owned tasks without loading the engine", async () => {
  const wakeRuns = spyOn(signals, "wakeWorkflowRunsWaitingOn").mockResolvedValue([]);
  const notify = spyOn(signals, "notifyWorkflowWorker").mockImplementation(() => {});
  try {
    await wakeWorkflowAiTask({ appId: "example", id: "ai-task", runId: "existing-workflow-run" });
    expect(wakeRuns).toHaveBeenCalledWith({ appId: "example", kind: "ai.workflow-task", key: "ai-task" });
    expect(notify).toHaveBeenCalledWith("example");
  } finally {
    wakeRuns.mockRestore();
    notify.mockRestore();
  }
});
