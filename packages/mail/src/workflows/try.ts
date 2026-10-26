import {
  AI_WORKFLOW_ACTIONS,
  createWorkflowBuiltinActionPorts,
  type WorkflowBoundPlan,
  type WorkflowCondition,
  type WorkflowIrStep,
  type WorkflowJsonValue,
  workflowPathKey,
} from "@k2b/cloud/workflows";
import { readWorkflowValuePath } from "@k2b/cloud/workflows/language";
import {
  DEFAULT_MAX_LOOP_ITEMS,
  dryRunWorkflowPlan,
  type WorkflowRuntimeStepResult,
  WorkflowValueWaiting,
} from "@k2b/cloud/workflows/runtime";
import { createWorkflowDryRunPort } from "@k2b/cloud/workflows/store";
import type { WorkflowTryItem } from "../contracts";
import { mailLiquidTemplateVariables, mailWorkflowTemplateData, renderMailLiquidTemplate } from "../service/template-rendering";
import type { FrozenMailWorkflowSource } from "../service/workflow-data";
import { mailWorkflows } from "./module";
import { MAIL_WORKFLOW_RENDERED_TEMPLATE_FIELDS, mailWorkflowTemplateOutput } from "./template-validation";

export const isWorkflowAiAction = (kind: string): boolean => Object.hasOwn(AI_WORKFLOW_ACTIONS, kind);
export const childWorkflowSteps = (step: WorkflowIrStep): WorkflowIrStep[][] =>
  step.kind === "if"
    ? [step.then, step.else]
    : step.kind === "switch"
      ? [...step.cases.map((branch) => branch.steps), step.default]
      : step.kind === "forEach"
        ? [step.steps]
        : [];
export const allWorkflowSteps = (steps: WorkflowIrStep[]): WorkflowIrStep[] =>
  steps.flatMap((step) => [step, ...childWorkflowSteps(step).flatMap(allWorkflowSteps)]);

const references = (value: unknown): string[] => {
  if (typeof value === "string") {
    return [...value.matchAll(/\$\{\{\s*([\w.]+)\s*\}\}/g)].map((match) => match[1]!);
  }
  if (Array.isArray(value)) return value.flatMap(references);
  if (value && typeof value === "object") return Object.values(value).flatMap(references);
  return [];
};
const conditionReferences = (condition: WorkflowCondition): string[] => {
  if (condition.operator === "all" || condition.operator === "any") return condition.conditions.flatMap(conditionReferences);
  if (condition.operator === "not") return conditionReferences(condition.condition);
  if (condition.operator === "exists") return [condition.reference];
  return references(condition.operands);
};
export const workflowFactReferences = (plan: WorkflowBoundPlan): string[] =>
  [
    ...new Set(
      allWorkflowSteps(plan.steps).flatMap((step) =>
        step.kind === "if" ? conditionReferences(step.condition) : step.kind === "switch" ? references(step.value) : [],
      ),
    ),
  ].filter((reference) => reference.startsWith("inputs."));

export const workflowReferencedTextFields = (plan: WorkflowBoundPlan): Set<string> => {
  const templateRefs = allWorkflowSteps(plan.steps).flatMap((step) =>
    step.kind !== "action"
      ? []
      : (MAIL_WORKFLOW_RENDERED_TEMPLATE_FIELDS[step.action] ?? []).flatMap((field) => {
          const value = step.config[field];
          if (typeof value !== "string") return [];
          const variables = mailLiquidTemplateVariables(value);
          return variables.ok ? variables.data : [];
        }),
  );
  const refs = [...references(plan.steps), ...workflowFactReferences(plan), ...templateRefs];
  // Whole message references in conditions/values may expose their text too.
  return new Set(
    refs.flatMap((ref) => {
      const input = plan.inputs.find(
        (input) => input.type === "mailMessage" && ref.split(".")[0] === "inputs" && ref.split(".")[1] === input.name,
      );
      if (!input) return [];
      const field = ref.split(".")[2];
      return field === undefined
        ? ["bodyText", "bodyHtml"]
        : field === "textLength" || field === "body"
          ? ["bodyText"]
          : field === "bodyText" || field === "bodyHtml"
            ? [field]
            : [];
    }),
  );
};

export type WorkflowTryStepProblem = WorkflowTryItem["problems"][number];
export type WorkflowTryTargetState = {
  problems: Map<string, WorkflowTryStepProblem[]>;
  labels: Map<string, string>;
};

const primitive = (value: WorkflowJsonValue | undefined): value is string | number | boolean | null =>
  value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";

/** In-memory repository only: the preview never enters the durable worker/store. */
export const planMailWorkflowTryItem = async (params: {
  plan: WorkflowBoundPlan;
  source: FrozenMailWorkflowSource;
  inputs: Record<string, WorkflowJsonValue>;
  targets: WorkflowTryTargetState;
  occurredAt: string;
  unavailableTextFields?: string[];
}): Promise<WorkflowTryItem> => {
  const { plan, source, inputs, targets } = params;
  const effects: WorkflowTryItem["effects"] = [];
  const problems: WorkflowTryItem["problems"] = [];
  let stoppedAtAi = false;
  const aiValues = new Set<string>();
  const aiReference = (reference: string) => aiValues.has(reference.split(".")[0]!);
  let aiMayHaveStopped = false;
  const exclusions: string[] = [];
  const declared = createWorkflowDryRunPort(mailWorkflows);
  const builtins = createWorkflowBuiltinActionPorts({ authorize: async () => undefined });
  const results = new Map<string, WorkflowRuntimeStepResult>();
  const unavailable = new Set(params.unavailableTextFields ?? []);
  if (!source.message.attachmentsAvailable) {
    unavailable.add("attachments");
    unavailable.add("attachmentCount");
  }
  const counts = new Map<string, { min: number; max: number }>();
  const key = (step: WorkflowIrStep, iterations: number[]) => `${workflowPathKey(step.sourcePath)}#${iterations.join(".")}`;

  const countSteps = (steps: WorkflowIrStep[], iterations: number[]): { min: number; max: number } => {
    let min = 0;
    let max = 0;
    for (const step of steps) {
      const result = results.get(key(step, iterations));
      const counted = counts.get(key(step, iterations));
      if (counted) {
        min += counted.min;
        max += counted.max;
        continue;
      }
      if (!result || result.mode !== "dryRun" || result.outcome.state !== "planned" || !result.outcome.control) continue;
      const control = result.outcome.control;
      if (step.kind === "forEach" && control.kind === "forEach") {
        const unknown = result.outcome.issues?.some((issue) => workflowPathKey(issue.step.sourcePath) === workflowPathKey(step.sourcePath));
        if (unknown) max += countSteps(step.steps, [...iterations, 0]).max * (plan.maxLoopItems ?? DEFAULT_MAX_LOOP_ITEMS);
        else
          for (let index = 0; index < control.items.length; index++) {
            const child = countSteps(step.steps, [...iterations, index]);
            min += child.min;
            max += child.max;
          }
      } else if ((step.kind === "if" && control.kind === "if") || (step.kind === "switch" && control.kind === "switch")) {
        const branches = childWorkflowSteps(step).map((branch) => countSteps(branch, iterations));
        max += Math.max(0, ...branches.map((branch) => branch.max));
        // A selected branch can contain certain AI steps; unknown branches report min=0 themselves.
        min += branches.reduce((sum, branch) => sum + branch.min, 0);
      }
    }
    return { min, max };
  };

  await dryRunWorkflowPlan({
    runId: crypto.randomUUID(),
    executionGeneration: 1,
    plan,
    invocation: {
      workflowId: "preview",
      mode: "dryRun",
      channel: "mail.try",
      actor: {},
      inputs,
      idempotencyKey: "preview",
      occurredAt: params.occurredAt,
    },
    clock: { now: () => params.occurredAt },
    repository: {
      heartbeat: async () => ({ state: "active" }),
      restoreStepOutcome: async () => null,
      startStep: async () => {},
      parkStep: async () => {},
      finishStep: async (step, result) => {
        results.set(`${workflowPathKey(step.sourcePath)}#${step.iterationPath.join(".")}`, result);
      },
    },
    trace: {
      emit: (event) => {
        if (event.type === "condition.evaluated" && !event.matched) {
          const control = allWorkflowSteps(plan.steps)
            .filter((step) => step.kind === "if" && event.path.slice(0, step.sourcePath.length).join(".") === step.sourcePath.join("."))
            .sort((a, b) => b.sourcePath.length - a.sourcePath.length)[0];
          if (control?.kind === "if") {
            let condition = control.condition;
            const tail = event.path.slice(control.sourcePath.length + 1);
            for (let index = 0; index < tail.length; index++) {
              if ((tail[index] === "all" || tail[index] === "any") && (condition.operator === "all" || condition.operator === "any")) {
                const child = condition.conditions[Number(tail[++index])];
                if (child) condition = child;
              } else if (tail[index] === "not" && condition.operator === "not") condition = condition.condition;
            }
            exclusions.push(...conditionReferences(condition));
          }
        }
      },
    },
    values: {
      resolve: async ({ reference, fallback }) => {
        const [root, name, field] = reference.split(".");
        if (
          root === "inputs" &&
          plan.inputs.some((input) => input.name === name && input.type === "mailMessage") &&
          (field ? unavailable.has(field === "body" || field === "textLength" ? "bodyText" : field) : unavailable.size > 0)
        ) {
          problems.push({ code: "effect_not_allowed", path: ["inputs", name!, ...(field ? [field] : [])] });
          return { state: "waiting", dependency: { kind: "mail.preview-text", key: reference } };
        }
        const value = fallback();
        return value === undefined ? { state: "missing" } : { state: "resolved", value };
      },
    },
    actions: {
      get: (kind) => {
        const handler = declared.get(kind) ?? builtins.dryRun.get(kind);
        if (!handler) return undefined;
        return {
          plan: async (ctx, step) => {
            const ai = isWorkflowAiAction(kind);
            const effectParams: WorkflowTryItem["effects"][number]["params"] = {};
            const parents = allWorkflowSteps(plan.steps).filter(
              (parent) =>
                parent.sourcePath.length < step.sourcePath.length &&
                parent.sourcePath.every((part, index) => step.sourcePath[index] === part),
            );
            for (const parent of parents) {
              if (parent.kind === "forEach" && aiReference(parent.reference)) aiValues.add(parent.alias);
            }
            let dependsOnAi =
              aiMayHaveStopped ||
              (ctx.dependsOnUnknown === true &&
                parents.some((parent) =>
                  (parent.kind === "if"
                    ? conditionReferences(parent.condition)
                    : parent.kind === "switch"
                      ? references(parent.value)
                      : parent.kind === "forEach"
                        ? [parent.reference]
                        : []
                  ).some(aiReference),
                ));
            const unavailableValue = (error: unknown, path: Array<string | number>) => {
              if (error instanceof WorkflowValueWaiting && aiReference(error.reference)) dependsOnAi = true;
              else problems.push({ code: "effect_not_allowed", path });
            };
            for (const [name, value] of Object.entries(step.config)) {
              if (["saveAs", "message", "conversation", "input", "prompt", "body"].includes(name)) continue;
              try {
                const evaluated = await ctx.evaluate(value);
                if (primitive(evaluated))
                  effectParams[name] = targets.labels.get(`${workflowPathKey([...step.sourcePath, kind, name])}`) ?? evaluated;
              } catch (error) {
                unavailableValue(error, [...step.sourcePath, kind, name]);
              }
            }
            let unavailableTemplate = false;
            for (const field of MAIL_WORKFLOW_RENDERED_TEMPLATE_FIELDS[kind] ?? []) {
              const template = step.config[field];
              if (typeof template !== "string") continue;
              const output = mailWorkflowTemplateOutput(kind, field, step.config.format);
              const variables = mailLiquidTemplateVariables(template, output);
              try {
                if (!variables.ok) throw new Error(variables.error.message);
                for (const reference of variables.data) await ctx.resolveReference(reference);
                if (field !== "body") {
                  const rendered = renderMailLiquidTemplate(
                    template,
                    mailWorkflowTemplateData({
                      invocation: ctx.invocation,
                      variableSnapshot: () => ctx.variables.snapshot?.() ?? {},
                    }),
                    output,
                  );
                  if (!rendered.ok) throw new Error(rendered.error.message);
                  effectParams[field] = rendered.data;
                }
              } catch (error) {
                unavailableTemplate = true;
                unavailableValue(error, [...step.sourcePath, kind, field]);
              }
            }
            const stepProblems = targets.problems.get(workflowPathKey(step.sourcePath)) ?? [];
            problems.push(...stepProblems);
            let outcome: Awaited<ReturnType<typeof handler.plan>>;
            try {
              outcome = unavailableTemplate
                ? { state: "indeterminate", reason: "Template output is unavailable" }
                : await handler.plan(ctx, step);
            } catch (error) {
              unavailableValue(error, step.sourcePath);
              outcome = { state: "indeterminate", reason: error instanceof Error ? error.message : "Value unavailable" };
            }
            if (ai) stoppedAtAi = true;
            const saved = kind === "setVariable" ? step.config.name : step.config.saveAs;
            if (typeof saved === "string" && (ai || dependsOnAi || references(step.config).some(aiReference))) aiValues.add(saved);
            if (dependsOnAi && ["succeed", "fail"].includes(kind)) aiMayHaveStopped = true;
            if (!["setVariable", "succeed", "fail"].includes(kind)) effects.push({ kind, ai, params: effectParams, dependsOnAi });
            if (ai)
              counts.set(key(step, ctx.step.iterationPath), {
                min: dependsOnAi || ctx.dependsOnUnknown || stepProblems.length > 0 || outcome.state !== "planned" ? 0 : 1,
                max: 1,
              });
            return outcome;
          },
        };
      },
    },
  });
  const facts: WorkflowTryItem["facts"] = [];
  for (const reference of workflowFactReferences(plan)) {
    const [, name, ...tail] = reference.split(".");
    const input = plan.inputs.find((input) => input.name === name);
    const path = `${input?.type === "mailConversation" ? "conversation" : "message"}.${tail.join(".")}`;
    const value = readWorkflowValuePath(inputs[name!] ?? null, tail);
    const missing =
      input?.type === "mailMessage" && unavailable.has(tail[0] === "textLength" || tail[0] === "body" ? "bodyText" : tail[0]!);
    if (!facts.some((fact) => fact.path === path)) facts.push({ path, value: !missing && primitive(value) ? value : null });
  }
  const reason: WorkflowTryItem["reason"] =
    effects.length === 0 && exclusions.length > 0
      ? {
          code: "excluded",
          field: exclusions[0]!.replace(/^inputs\.[^.]+\./, (prefix) => {
            const name = prefix.split(".")[1];
            return plan.inputs.find((input) => input.name === name)?.type === "mailConversation" ? "conversation." : "message.";
          }),
        }
      : null;
  return {
    messageId: source.message.id,
    conversationId: source.conversation?.id ?? "",
    from: { name: source.message.sender.find((address) => address.role === "from")?.name ?? null, email: source.message.fromAddress },
    subject: source.message.subject,
    receivedAt: source.message.receivedAt,
    outcome: effects.length > 0 ? "match" : reason ? "skipped" : "none",
    reason,
    facts,
    effects,
    stoppedAtAi,
    problems,
    aiCalls: countSteps(plan.steps, []),
  };
};
