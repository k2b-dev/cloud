import { expect, spyOn, test } from "bun:test";
import { sql } from "@k2b/cloud";
import { deleteApplicationAiTasks, runApplicationAiTask } from "@k2b/cloud/ai";
import { DEFAULT_WORKFLOW_AI_BUDGET } from "@k2b/cloud/config/workflow-ai";
import { suiteFor } from "../../../../../scripts/fixtures/test-infra";
import { openSync } from "../../../test/integration/sync-contracts/harness";
import { bindProcessSync, unbindProcessSync } from "../../_internal/process-sync";
import { aiModelFixture } from "../model-fixture";
import { createAiProvider } from "../provider";
import * as structured from "../structured";
import * as models from "../task-model";
import { startWorkflowAiRuntime, stopWorkflowAiRuntime } from "./index";

suiteFor("database", "nats")("application AI without a workflow runtime", () => {
  test("an app-owned worker processes and replays a task without a Mail workflow runtime", async () => {
    const fixture = await openSync("application-ai");
    const profile = aiModelFixture();
    const model = spyOn(models, "resolveApplicationAiTaskModel").mockResolvedValue({
      model: { id: profile.id },
      profile,
      provider: createAiProvider(profile, "unused"),
    });
    const infer = spyOn(structured, "runAiStructured").mockImplementation(async (input) => ({
      output: input.output.parse({ text: "Retained summary" }),
      model: { id: profile.id },
      structuredMeta: { mode: "native", repaired: false, attempts: 1, usedResponseFormat: true },
    }));
    const scopeId = crypto.randomUUID();
    bindProcessSync(fixture.sync);
    try {
      await startWorkflowAiRuntime();
      const input = {
        appId: "example",
        scopeId,
        task: "conversation-summary",
        effectKey: "one-request",
        request: { kind: "generate_text" as const, prompt: "Summarize the conversation", maxOutputChars: 100 },
        source: { sourceId: "conversation", sourceRevision: "1", budget: DEFAULT_WORKFLOW_AI_BUDGET },
        signal: AbortSignal.timeout(10_000),
      };
      expect(await runApplicationAiTask(input)).toMatchObject({ output: "Retained summary" });
      expect(await runApplicationAiTask(input)).toMatchObject({ output: "Retained summary" });
      expect(infer).toHaveBeenCalledTimes(1);
      const [task] = await sql`SELECT run_id, status FROM ai.workflow_task WHERE app_id = 'example' AND scope_id = ${scopeId}`;
      expect(task).toMatchObject({ run_id: null, status: "succeeded" });
    } finally {
      try {
        await stopWorkflowAiRuntime();
      } finally {
        try {
          await deleteApplicationAiTasks({ appId: "example", scopeId });
        } finally {
          unbindProcessSync();
          model.mockRestore();
          infer.mockRestore();
          await fixture.close();
        }
      }
    }
  });
});
