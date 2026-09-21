import { describe, expect, test } from "bun:test";
import { StructuredOutputError } from "@k2b/nessi";
import { sql } from "bun";
import type { z } from "zod";
import { migrate as migrateWorkflows } from "../../../../core/src/migrate/core/workflows";
import { createWorkflowIntegrationFixture } from "../../../test/workflows/integration-fixture";
import type { RunAiStructuredInput, RunAiStructuredResult } from "../../ai";
import type { WorkflowBoundPlan } from "../contracts";
import { hashWorkflowJson } from "../language/canonical";
import { defineWorkflowModule } from "../module";
import { createWorkflow, publishWorkflowVersion } from "../store/definitions";
import { emitWorkflowEvent } from "../store/events";
import { requestWorkflowRunCancel } from "../store/runs";
import { processWorkflowAiTask, settleWorkflowAiAttemptFailure } from "./runtime";
import {
  claimWorkflowAiTask,
  completeWorkflowAiTask,
  createWorkflowAiTask,
  failWorkflowAiTask,
  getWorkflowAiTask,
  migrateWorkflowAi,
} from "./store";

let readiness: Promise<boolean> | null = null;
const ready = (): Promise<boolean> => {
  readiness ??= (async () => {
    try {
      await migrateWorkflows();
      await migrateWorkflowAi();
      return true;
    } catch {
      return false;
    }
  })();
  return readiness;
};

const fixture = createWorkflowIntegrationFixture();
const module = defineWorkflowModule({ id: "workflow-ai-test", version: 1, inputs: [], triggers: [], actions: {} });
const manifestHash = await hashWorkflowJson(module.manifest);
const hash = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex");
const processContext = () => ({ signal: new AbortController().signal, heartbeat: async () => undefined });
const captureFailure = async (operation: () => Promise<void>) => {
  try {
    await operation();
  } catch (error) {
    return error as { code: string; message: string; retryable: boolean };
  }
  throw new Error("Expected workflow AI attempt to fail.");
};

const createRun = async () => {
  const appId = `workflow-ai-${crypto.randomUUID().slice(0, 8)}`;
  const scopeId = fixture.scope(appId);
  const workflow = await createWorkflow({ appId, scopeId, key: "ai", name: "AI", author: { kind: "system" } });
  const plan: WorkflowBoundPlan = {
    schemaVersion: 2,
    languageId: module.manifest.id,
    languageVersion: module.manifest.version,
    sourceHash: hash("source"),
    manifestHash,
    catalogHash: hash("catalog"),
    actionPolicies: {},
    inputs: [],
    triggers: [],
    steps: [],
    bindings: {},
  };
  await publishWorkflowVersion({
    workflowId: workflow.id,
    source: "steps: []",
    plan,
    author: { kind: "system" },
    activations: [{ key: "event", eventType: `${appId}.test` }],
  });
  const emitted = await emitWorkflowEvent({ appId, scopeId, type: `${appId}.test` }, { dispatch: "now" });
  return { appId, runId: emitted.runIds[0]! };
};

describe("durable workflow AI tasks", () => {
  test("deduplicates an effect, pins its model, and stores the terminal result", async () => {
    if (!(await ready())) return;
    const { appId, runId } = await createRun();
    const input = {
      runId,
      stepKey: "step:ai",
      effectKey: `workflow:${runId}:step:ai`,
      request: { kind: "classify" as const, prompt: "Choose", input: "hello", choices: ["a", "b"] },
      modelProfileId: "workflow-model",
    };

    const first = await createWorkflowAiTask(input);
    const duplicate = await createWorkflowAiTask(input);
    expect(first.created).toBe(true);
    expect(duplicate).toMatchObject({ created: false, task: { id: first.task.id } });
    expect(first.task).toMatchObject({ appId, modelProfileId: "workflow-model", attempts: 0, status: "queued" });

    const claimed = await claimWorkflowAiTask(first.task.id);
    expect(claimed).toMatchObject({ status: "running", attempts: 1 });
    await completeWorkflowAiTask(first.task.id, "a", { input: 10, output: 1 });
    expect(await getWorkflowAiTask(first.task.id)).toMatchObject({ status: "succeeded", output: "a", attempts: 1 });

    const [signal] = await sql<{ present: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM workflows.dependency_signal
        WHERE app_id = ${appId} AND kind = 'ai.workflow-task' AND key = ${first.task.id}
      ) AS present
    `;
    expect(signal?.present).toBe(true);
  });

  test("cancels queued work before it can be claimed", async () => {
    if (!(await ready())) return;
    const { runId } = await createRun();
    const created = await createWorkflowAiTask({
      runId,
      stepKey: "step:ai",
      effectKey: `workflow:${runId}:step:ai`,
      request: { kind: "generate_text", prompt: "Draft" },
      modelProfileId: "workflow-model",
    });

    expect(await requestWorkflowRunCancel(runId)).toBe(true);
    expect(await claimWorkflowAiTask(created.task.id)).toMatchObject({ status: "canceled", output: null });
  });

  test("keeps cancellation authoritative over a late provider failure", async () => {
    if (!(await ready())) return;
    const { runId } = await createRun();
    const created = await createWorkflowAiTask({
      runId,
      stepKey: "step:ai",
      effectKey: `workflow:${runId}:step:ai`,
      request: { kind: "generate_text", prompt: "Draft" },
      modelProfileId: "workflow-model",
    });

    await claimWorkflowAiTask(created.task.id);
    expect(await requestWorkflowRunCancel(runId)).toBe(true);
    await failWorkflowAiTask(created.task.id, { code: "WORKFLOW_AI_PROVIDER_ERROR", message: "late failure" });

    expect(await getWorkflowAiTask(created.task.id)).toMatchObject({
      status: "canceled",
      output: null,
      errorCode: "WORKFLOW_AI_CANCELED",
    });
  });

  test("redelivers an interrupted task with its pinned model", async () => {
    if (!(await ready())) return;
    const { runId } = await createRun();
    const created = await createWorkflowAiTask({
      runId,
      stepKey: "step:ai",
      effectKey: `workflow:${runId}:step:ai`,
      request: { kind: "generate_text", prompt: "Draft" },
      modelProfileId: "pinned-model",
    });
    const models: Array<string | undefined> = [];
    let calls = 0;
    const runStructured = (async <TOutput extends z.ZodType>(
      input: RunAiStructuredInput<TOutput>,
    ): Promise<RunAiStructuredResult<TOutput>> => {
      calls += 1;
      models.push(input.requestedModelId);
      if (calls === 1) throw new Error("provider interrupted");
      return {
        output: input.output.parse({ text: "draft" }),
        modelProfileId: "pinned-model",
        structuredMeta: { mode: "native", repaired: false, attempts: 1, usedResponseFormat: true },
      };
    }) as typeof import("../../ai")["runAiStructured"];

    const failure = await captureFailure(() =>
      processWorkflowAiTask(created.task.id, processContext(), { runStructured, maxAttempts: 3, cancelPollMs: 10 }),
    );
    expect(await settleWorkflowAiAttemptFailure(created.task.id, failure, 0, 3)).toBe("retry");
    await processWorkflowAiTask(created.task.id, processContext(), { runStructured, maxAttempts: 3, cancelPollMs: 10 });

    expect(models).toEqual(["pinned-model", "pinned-model"]);
    expect(await getWorkflowAiTask(created.task.id)).toMatchObject({ status: "succeeded", attempts: 2, output: "draft" });
  });

  test("bounds transient retries and fails invalid structured output immediately", async () => {
    if (!(await ready())) return;
    const transientRun = await createRun();
    const transient = await createWorkflowAiTask({
      runId: transientRun.runId,
      stepKey: "step:transient",
      effectKey: `workflow:${transientRun.runId}:step:transient`,
      request: { kind: "generate_text", prompt: "Draft" },
      modelProfileId: "workflow-model",
    });
    const unavailable = (async () => {
      throw new Error("provider unavailable");
    }) as typeof import("../../ai")["runAiStructured"];

    for (let failureCount = 0; failureCount < 3; failureCount += 1) {
      const failure = await captureFailure(() =>
        processWorkflowAiTask(transient.task.id, processContext(), { runStructured: unavailable, maxAttempts: 3, cancelPollMs: 10 }),
      );
      expect(await settleWorkflowAiAttemptFailure(transient.task.id, failure, failureCount, 3)).toBe(failureCount < 2 ? "retry" : "failed");
    }
    expect(await getWorkflowAiTask(transient.task.id)).toMatchObject({
      status: "failed",
      attempts: 3,
      errorCode: "WORKFLOW_AI_PROVIDER_ERROR",
    });

    const invalidRun = await createRun();
    const invalid = await createWorkflowAiTask({
      runId: invalidRun.runId,
      stepKey: "step:invalid",
      effectKey: `workflow:${invalidRun.runId}:step:invalid`,
      request: { kind: "generate_text", prompt: "Draft" },
      modelProfileId: "workflow-model",
    });
    const invalidOutput = (async () => {
      throw new StructuredOutputError("invalid output", "invalid_output");
    }) as typeof import("../../ai")["runAiStructured"];
    const failure = await captureFailure(() =>
      processWorkflowAiTask(invalid.task.id, processContext(), { runStructured: invalidOutput, maxAttempts: 3, cancelPollMs: 10 }),
    );
    expect(await settleWorkflowAiAttemptFailure(invalid.task.id, failure, 0, 3)).toBe("failed");
    expect(await getWorkflowAiTask(invalid.task.id)).toMatchObject({
      status: "failed",
      attempts: 1,
      errorCode: "WORKFLOW_AI_INVALID_OUTPUT",
    });
  });

  test("aborts running inference when its workflow is canceled", async () => {
    if (!(await ready())) return;
    const { runId } = await createRun();
    const created = await createWorkflowAiTask({
      runId,
      stepKey: "step:ai",
      effectKey: `workflow:${runId}:step:ai`,
      request: { kind: "generate_text", prompt: "Draft" },
      modelProfileId: "workflow-model",
    });
    let started!: () => void;
    const providerStarted = new Promise<void>((resolve) => (started = resolve));
    const runStructured = (async <TOutput extends z.ZodType>(
      input: RunAiStructuredInput<TOutput>,
    ): Promise<RunAiStructuredResult<TOutput>> => {
      started();
      await new Promise<void>((_resolve, reject) =>
        input.signal?.addEventListener("abort", () => reject(input.signal?.reason ?? new Error("aborted")), { once: true }),
      );
      throw new Error("unreachable");
    }) as typeof import("../../ai")["runAiStructured"];

    const processing = processWorkflowAiTask(
      created.task.id,
      { signal: new AbortController().signal, heartbeat: async () => undefined },
      { runStructured, maxAttempts: 3, cancelPollMs: 10 },
    );
    await providerStarted;
    await requestWorkflowRunCancel(runId);
    await processing;

    expect(await getWorkflowAiTask(created.task.id)).toMatchObject({ status: "canceled", output: null });
  });

  test("discards a late provider result after cancellation", async () => {
    if (!(await ready())) return;
    const { runId } = await createRun();
    const created = await createWorkflowAiTask({
      runId,
      stepKey: "step:ai",
      effectKey: `workflow:${runId}:step:ai`,
      request: { kind: "generate_text", prompt: "Draft" },
      modelProfileId: "workflow-model",
    });
    let started!: () => void;
    const providerStarted = new Promise<void>((resolve) => (started = resolve));
    const runStructured = (async <TOutput extends z.ZodType>(
      input: RunAiStructuredInput<TOutput>,
    ): Promise<RunAiStructuredResult<TOutput>> => {
      started();
      await Bun.sleep(50);
      return {
        output: input.output.parse({ text: "late" }),
        modelProfileId: "workflow-model",
        structuredMeta: { mode: "native", repaired: false, attempts: 1, usedResponseFormat: true },
      };
    }) as typeof import("../../ai")["runAiStructured"];

    const processing = processWorkflowAiTask(
      created.task.id,
      { signal: new AbortController().signal, heartbeat: async () => undefined },
      { runStructured, maxAttempts: 3, cancelPollMs: 10 },
    );
    await providerStarted;
    await requestWorkflowRunCancel(runId);
    await processing;

    expect(await getWorkflowAiTask(created.task.id)).toMatchObject({ status: "canceled", output: null });
  });
});
