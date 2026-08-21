import type { AiResolvedModel } from "../ai/types";
import type { WorkflowAiRequestInput, WorkflowAiTask } from "./ai/types";
import type { WorkflowFieldSchema, WorkflowJsonValue } from "./contracts";
import type { WorkflowActionContext, WorkflowActionResult, WorkflowPlannedEffect } from "./definition";
import { workflowAction } from "./definition";

const text = (description: string, optional = false, maxLength = 20_000) =>
  ({ kind: "string", minLength: 1, maxLength, optional, description }) as const;
const identifier = (description: string) => ({ kind: "string", format: "identifier", minLength: 1, maxLength: 120, description }) as const;
const model = text("Optional enabled AI model profile ID.", true, 120);
const prompt = text("Instructions for the AI task.");
const choices = {
  kind: "array",
  items: text("One allowed classification value.", false, 200),
  minItems: 2,
  maxItems: 50,
  description: "Allowed classification values.",
} as const;
const structuredFieldTypes: Array<"text" | "number" | "boolean" | "date_time" | "enum"> = [
  "text",
  "number",
  "boolean",
  "date_time",
  "enum",
];
const structuredFields = {
  kind: "array",
  minItems: 1,
  maxItems: 40,
  description: "Declared fields in the returned object.",
  items: {
    kind: "object",
    properties: {
      name: identifier("Stable output field name."),
      type: { kind: "string", enum: structuredFieldTypes, description: "Field value type." },
      description: text("What the field means and how to extract it.", false, 500),
      required: { kind: "boolean", optional: true, description: "Whether the field must be present. Defaults to true." },
      choices: { kind: "array", optional: true, minItems: 1, maxItems: 50, items: text("One enum value.", false, 200) },
      maxLength: { kind: "number", integer: true, minimum: 1, maximum: 20_000, optional: true, description: "Maximum text length." },
    },
  },
} as const satisfies WorkflowFieldSchema;
const extractDataConfig = {
  kind: "object",
  properties: {
    input: { kind: "value", description: "Bounded JSON input from which fields are extracted." },
    prompt,
    fields: structuredFields,
    model,
    saveAs: identifier("Variable name for the extracted object."),
  },
} as const;

type WorkflowAiActionDependencies = {
  getByEffectKey(effectKey: string): Promise<WorkflowAiTask | null>;
  create(input: {
    runId: string;
    stepKey: string;
    effectKey: string;
    request: WorkflowAiRequestInput;
    modelProfileId: string;
  }): Promise<{ task: WorkflowAiTask; created: boolean }>;
  exists(effectKey: string): Promise<boolean>;
  resolveModel(requestedModelId?: string): Promise<AiResolvedModel>;
  submit(taskId: string): Promise<void>;
};

const dependencies = async (): Promise<WorkflowAiActionDependencies> => {
  const [{ resolveAiWorkflowModel }, store, runtime] = await Promise.all([
    import("../ai/structured"),
    import("./ai/store"),
    import("./ai/runtime"),
  ]);
  return {
    getByEffectKey: store.getWorkflowAiTaskByEffectKey,
    create: store.createWorkflowAiTask,
    exists: store.workflowAiTaskExists,
    resolveModel: resolveAiWorkflowModel,
    submit: runtime.submitWorkflowAiTask,
  };
};

const failureCode = (error: unknown): string => {
  const code =
    (error as { aiError?: { code?: unknown }; code?: unknown } | null)?.aiError?.code ?? (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? `WORKFLOW_AI_${code.toUpperCase()}` : "WORKFLOW_AI_UNAVAILABLE";
};

const taskResult = (task: WorkflowAiTask): WorkflowActionResult<WorkflowJsonValue> | null => {
  if (task.status === "succeeded") return { state: "succeeded", output: task.output };
  if (task.status === "failed") {
    return {
      state: "failed",
      code: task.errorCode ?? "WORKFLOW_AI_FAILED",
      message: task.errorMessage ?? "Workflow AI task failed.",
    };
  }
  if (task.status === "canceled") {
    return { state: "failed", code: "WORKFLOW_AI_CANCELED", message: "Workflow AI task was canceled." };
  }
  return null;
};

export const runWorkflowAiAction = async (
  ctx: Pick<WorkflowActionContext, "runId" | "stepKey" | "effectKey">,
  request: WorkflowAiRequestInput,
  injected?: WorkflowAiActionDependencies,
): Promise<WorkflowActionResult<WorkflowJsonValue>> => {
  const deps = injected ?? (await dependencies());
  try {
    let task = await deps.getByEffectKey(ctx.effectKey);
    const terminal = task ? taskResult(task) : null;
    if (terminal) return terminal;

    if (!task) {
      const resolved = await deps.resolveModel(request.modelProfileId?.trim() || undefined);
      task = (
        await deps.create({
          runId: ctx.runId,
          stepKey: ctx.stepKey,
          effectKey: ctx.effectKey,
          request,
          modelProfileId: resolved.profile.id,
        })
      ).task;
      const racedTerminal = taskResult(task);
      if (racedTerminal) return racedTerminal;
    }

    await deps.submit(task.id);
    return { state: "waiting", dependency: { kind: "ai.workflow-task", key: task.id } };
  } catch (error) {
    return {
      state: "failed",
      code: failureCode(error),
      message: error instanceof Error ? error.message : "Workflow AI task is unavailable.",
      retryable: failureCode(error) === "WORKFLOW_AI_UNAVAILABLE",
    };
  }
};

export const planWorkflowAiAction = async (
  ctx: Pick<WorkflowActionContext, "effectKey">,
  summary: string,
  injected?: Pick<WorkflowAiActionDependencies, "exists">,
): Promise<WorkflowPlannedEffect> => {
  const deps = injected ?? (await dependencies());
  const exists = await deps.exists(ctx.effectKey);
  return {
    summary,
    ...(exists ? {} : { consumes: { maxAiCalls: 1 } }),
    issues: ["AI output is not available during a dry run."],
  };
};

export const AI_WORKFLOW_ACTIONS = {
  aiExtractData: workflowAction.idempotent<typeof extractDataConfig, WorkflowJsonValue>({
    label: "AI extract structured data",
    description: "Extracts one bounded, validated object from supplied input.",
    outputType: "core.value",
    config: extractDataConfig,
    plan: (ctx) => planWorkflowAiAction(ctx, "Extract structured data with AI."),
    run: (ctx, values) =>
      runWorkflowAiAction(ctx, {
        kind: "extract_data",
        input: values.input,
        prompt: values.prompt,
        fields: values.fields,
        ...(values.model ? { modelProfileId: values.model } : {}),
      }),
  }),
  aiGenerateText: workflowAction.idempotent({
    label: "AI generate text",
    description: "Generates one bounded text value without performing a domain action.",
    outputType: "core.text",
    config: {
      kind: "object",
      properties: {
        prompt,
        input: { kind: "value", optional: true, description: "Optional JSON input supplied separately from the prompt." },
        model,
        maxOutputChars: {
          kind: "number",
          integer: true,
          minimum: 1,
          maximum: 20_000,
          optional: true,
          description: "Maximum generated text length. Defaults to 4000 characters.",
        },
        saveAs: identifier("Variable name for the generated text."),
      },
    },
    plan: (ctx) => planWorkflowAiAction(ctx, "Generate text with AI."),
    run: (ctx, values) =>
      runWorkflowAiAction(ctx, {
        kind: "generate_text",
        prompt: values.prompt,
        ...(values.input === undefined ? {} : { input: values.input }),
        ...(values.model ? { modelProfileId: values.model } : {}),
        ...(values.maxOutputChars === undefined ? {} : { maxOutputChars: values.maxOutputChars }),
      }),
  }),
  aiClassify: workflowAction.idempotent({
    label: "AI classify",
    description: "Returns exactly one value from the declared choices.",
    outputType: "core.text",
    config: {
      kind: "object",
      properties: {
        input: { kind: "value", description: "Bounded JSON value to classify." },
        prompt,
        choices,
        model,
        saveAs: identifier("Variable name for the selected choice."),
      },
    },
    plan: (ctx) => planWorkflowAiAction(ctx, "Classify one value with AI."),
    run: (ctx, values) =>
      runWorkflowAiAction(ctx, {
        kind: "classify",
        input: values.input,
        prompt: values.prompt,
        choices: values.choices,
        ...(values.model ? { modelProfileId: values.model } : {}),
      }),
  }),
  aiClassifyMany: workflowAction.idempotent({
    label: "AI classify many",
    description: "Returns a unique subset of the declared choices in their declared order.",
    outputType: "core.textArray",
    config: {
      kind: "object",
      properties: {
        input: { kind: "value", description: "Bounded JSON value to classify." },
        prompt,
        choices,
        minChoices: {
          kind: "number",
          integer: true,
          minimum: 0,
          maximum: 50,
          optional: true,
          description: "Minimum number of choices. Defaults to zero.",
        },
        maxChoices: {
          kind: "number",
          integer: true,
          minimum: 0,
          maximum: 50,
          optional: true,
          description: "Maximum number of choices. Defaults to all declared choices.",
        },
        model,
        saveAs: identifier("Variable name for the selected choices."),
      },
    },
    plan: (ctx) => planWorkflowAiAction(ctx, "Classify multiple values with AI."),
    run: (ctx, values) =>
      runWorkflowAiAction(ctx, {
        kind: "classify_many",
        input: values.input,
        prompt: values.prompt,
        choices: values.choices,
        ...(values.minChoices === undefined ? {} : { minChoices: values.minChoices }),
        ...(values.maxChoices === undefined ? {} : { maxChoices: values.maxChoices }),
        ...(values.model ? { modelProfileId: values.model } : {}),
      }),
  }),
} as const;
