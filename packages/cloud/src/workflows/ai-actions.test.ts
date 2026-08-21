import { describe, expect, test } from "bun:test";
import type { AiResolvedModel } from "../ai/types";
import type { WorkflowAiTask } from "./ai/types";
import { AI_WORKFLOW_ACTIONS, planWorkflowAiAction, runWorkflowAiAction } from "./ai-actions";

const task = (overrides: Partial<WorkflowAiTask> = {}): WorkflowAiTask => ({
  id: "00000000-0000-0000-0000-000000000001",
  appId: "mail",
  runId: "00000000-0000-0000-0000-000000000002",
  stepKey: "step:ai",
  effectKey: "workflow:run:step:ai",
  kind: "classify",
  request: { kind: "classify", prompt: "Choose", input: "mail", choices: ["a", "b"] },
  inputHash: "a".repeat(64),
  modelProfileId: "workflow-model",
  status: "queued",
  output: null,
  usage: null,
  attempts: 0,
  errorCode: null,
  errorMessage: null,
  cancelRequestedAt: null,
  createdAt: "2026-08-05T00:00:00.000Z",
  startedAt: null,
  completedAt: null,
  updatedAt: "2026-08-05T00:00:00.000Z",
  ...overrides,
});

const context = { runId: task().runId, stepKey: "step:ai", effectKey: task().effectKey };
const resolved = { profile: { id: "workflow-model" } } as AiResolvedModel;

describe("shared workflow AI actions", () => {
  test("exposes the bounded opt-in data actions", () => {
    expect(Object.keys(AI_WORKFLOW_ACTIONS)).toEqual(["aiExtractData", "aiGenerateText", "aiClassify", "aiClassifyMany"]);
    expect(AI_WORKFLOW_ACTIONS.aiExtractData.outputType).toBe("core.value");
    expect(AI_WORKFLOW_ACTIONS.aiClassifyMany.outputType).toBe("core.textArray");
  });

  test("creates one pinned task, submits it, and waits on its durable ID", async () => {
    const submitted: string[] = [];
    const created = task();
    const result = await runWorkflowAiAction(
      context,
      { kind: "classify", prompt: "Choose", input: "mail", choices: ["a", "b"], modelProfileId: "override" },
      {
        getByEffectKey: async () => null,
        create: async (input) => {
          expect(input.modelProfileId).toBe("workflow-model");
          return { task: created, created: true };
        },
        exists: async () => false,
        resolveModel: async (requested) => {
          expect(requested).toBe("override");
          return resolved;
        },
        submit: async (id) => {
          submitted.push(id);
        },
      },
    );

    expect(result).toEqual({ state: "waiting", dependency: { kind: "ai.workflow-task", key: created.id } });
    expect(submitted).toEqual([created.id]);
  });

  test("returns stored terminal output without resolving or submitting again", async () => {
    const result = await runWorkflowAiAction(
      context,
      { kind: "generate_text", prompt: "Draft" },
      {
        getByEffectKey: async () => task({ status: "succeeded", output: "draft" }),
        create: async () => {
          throw new Error("must not create");
        },
        exists: async () => true,
        resolveModel: async () => {
          throw new Error("must not resolve");
        },
        submit: async () => {
          throw new Error("must not submit");
        },
      },
    );

    expect(result).toEqual({ state: "succeeded", output: "draft" });
  });

  test("charges one logical call only before the task exists", async () => {
    expect(await planWorkflowAiAction(context, "Generate", { exists: async () => false })).toMatchObject({ consumes: { maxAiCalls: 1 } });
    expect(await planWorkflowAiAction(context, "Generate", { exists: async () => true })).not.toHaveProperty("consumes");
  });
});
