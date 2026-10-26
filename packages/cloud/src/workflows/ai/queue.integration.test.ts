import { expect, spyOn, test } from "bun:test";
import { StoreFullError } from "@k2b/sync";
import { natsSuite } from "../../../../../scripts/fixtures/test-infra";
import { openSync, until } from "../../../test/integration/sync-contracts/harness";
import { bindProcessSync, unbindProcessSync } from "../../_internal/process-sync";
import { env } from "../../config/env";
import { startWorkflowAiRuntime, stopWorkflowAiRuntime, submitWorkflowAiTask } from "./runtime";
import * as store from "./store";

natsSuite()("workflow AI delivery admission", () => {
  test("rejects excess coalesced work and preserves accepted work", async () => {
    const fixture = await openSync("workflow-ai-full");
    const job = fixture.sync.job<string>({
      id: "ai-reject",
      whenFull: "reject",
      retention: { maxMessages: 1, maxAgeMs: 60_000, maxBytes: 1024 * 1024 },
    });
    try {
      await job.submit({ key: "first", input: "first", coalesce: true });
      await expect(job.submit({ key: "second", input: "second", coalesce: true })).rejects.toBeInstanceOf(StoreFullError);
      const received: string[] = [];
      const worker = await job.process({}, async ({ input }) => {
        received.push(input);
      });
      try {
        await until(() => received.length === 1);
        expect(received).toEqual(["first"]);
      } finally {
        worker.stop();
        await worker.drain();
      }
    } finally {
      await fixture.close();
    }
  });
  test("startup continues after one rejected resubmit and starts enough local workers for global admission", async () => {
    const fixture = await openSync("workflow-ai-recovery");
    const declare = fixture.sync.job.bind(fixture.sync);
    let observedConcurrency: number | undefined;
    const submitted: string[] = [];
    const jobSpy = spyOn(fixture.sync, "job").mockImplementation(<Input>(options: Parameters<typeof fixture.sync.job>[0]) => {
      const job = declare<Input>(options);
      const process = job.process.bind(job);
      spyOn(job, "process").mockImplementation((options, handler) => {
        observedConcurrency = options.concurrency;
        return process(options, handler);
      });
      spyOn(job, "submit").mockImplementation(async (input) => {
        submitted.push(input.key);
        if (submitted.length === 1) throw new Error("Synthetic transient submission failure");
        return { messageId: input.key, streamSequence: submitted.length, duplicate: false, jobId: input.key };
      });
      return job;
    });
    const expire = spyOn(store, "expireWorkflowAiTasks").mockResolvedValue(undefined);
    const pending = spyOn(store, "listRecoverableWorkflowAiTaskIds").mockResolvedValue(["first", "second"]);
    const fail = spyOn(store, "failWorkflowAiTask").mockResolvedValue(null);
    const log = spyOn(console, "error").mockImplementation(() => {});
    bindProcessSync(fixture.sync);
    try {
      await startWorkflowAiRuntime();
      await submitWorkflowAiTask("third");
      expect(observedConcurrency).toBe(env.WORKFLOW_AI_BUDGET.globalConcurrent);
      expect(submitted).toEqual(["task:first", "task:second", "task:third"]);
      expect(fail).toHaveBeenCalledWith("first", expect.objectContaining({ code: "WORKFLOW_AI_SUBMISSION_FAILED" }));
    } finally {
      stopWorkflowAiRuntime();
      unbindProcessSync();
      expire.mockRestore();
      pending.mockRestore();
      fail.mockRestore();
      log.mockRestore();
      jobSpy.mockRestore();
      await fixture.close();
    }
  });
});
