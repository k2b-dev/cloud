import { describe, expect, test } from "bun:test";
import type { WorkflowBoundPlan, WorkflowDependency, WorkflowInvocation, WorkflowJsonValue } from "../contracts";
import { dryRunWorkflowPlan, executeWorkflowPlan, WorkflowLeaseLostError } from "./executor";
import type {
  WorkflowDryRunActionHandler,
  WorkflowDryRunActionPort,
  WorkflowExecuteActionHandler,
  WorkflowExecuteActionPort,
  WorkflowHeartbeatOutcome,
  WorkflowRestoredStep,
  WorkflowRuntimeRepositoryPort,
  WorkflowRuntimeRunIdentity,
  WorkflowRuntimeStepIdentity,
  WorkflowRuntimeStepResult,
} from "./ports";

const actionPolicies = (steps: WorkflowBoundPlan["steps"]): WorkflowBoundPlan["actionPolicies"] => {
  const policies: WorkflowBoundPlan["actionPolicies"] = {};
  const visit = (items: WorkflowBoundPlan["steps"]): void => {
    for (const step of items) {
      if (step.kind === "action") policies[step.action] = { effect: "pure", dryRun: "full" };
      else if (step.kind === "if") {
        visit(step.then);
        visit(step.else);
      } else if (step.kind === "switch") {
        for (const candidate of step.cases) visit(candidate.steps);
        visit(step.default);
      } else visit(step.steps);
    }
  };
  visit(steps);
  return policies;
};

const plan = (steps: WorkflowBoundPlan["steps"], maxLoopItems?: number): WorkflowBoundPlan => ({
  schemaVersion: 2,
  languageId: "test",
  languageVersion: 1,
  sourceHash: "source-1",
  manifestHash: "manifest-1",
  catalogHash: "catalog-1",
  ...(maxLoopItems === undefined ? {} : { maxLoopItems }),
  actionPolicies: actionPolicies(steps),
  inputs: [],
  triggers: [],
  steps,
  bindings: {},
});

const invocation = <Mode extends "execute" | "dryRun">(
  mode: Mode,
  inputs: Record<string, WorkflowJsonValue> = {},
): WorkflowInvocation & { mode: Mode } => ({
  workflowId: "workflow-1",
  mode,
  channel: "test",
  actor: { userId: "user-1" },
  inputs,
  idempotencyKey: "invocation-1",
  occurredAt: "2026-07-14T12:00:00.000Z",
});

class FakeRepository implements WorkflowRuntimeRepositoryPort {
  readonly completed = new Map<string, WorkflowRestoredStep>();
  readonly started: WorkflowRuntimeStepIdentity[] = [];
  readonly finished: Array<{ step: WorkflowRuntimeStepIdentity; result: WorkflowRuntimeStepResult }> = [];
  readonly parked: Array<{ step: WorkflowRuntimeStepIdentity; dependency: WorkflowDependency }> = [];
  heartbeats: WorkflowHeartbeatOutcome[] = [];

  key(step: Pick<WorkflowRuntimeStepIdentity, "mode" | "key">): string {
    return `${step.mode}:${step.key}`;
  }

  async heartbeat(_run: WorkflowRuntimeRunIdentity): Promise<WorkflowHeartbeatOutcome> {
    return this.heartbeats.shift() ?? { state: "active" };
  }

  async restoreStepOutcome(step: WorkflowRuntimeStepIdentity): Promise<WorkflowRestoredStep | null> {
    return this.completed.get(this.key(step)) ?? null;
  }

  async startStep(step: WorkflowRuntimeStepIdentity): Promise<void> {
    this.started.push(step);
  }

  async finishStep(step: WorkflowRuntimeStepIdentity, result: WorkflowRuntimeStepResult): Promise<void> {
    this.finished.push({ step, result });
    if (result.mode === "execute" && result.outcome.state !== "waiting") {
      this.completed.set(this.key(step), { mode: "execute", outcome: result.outcome });
    }
    if (result.mode === "dryRun") {
      this.completed.set(this.key(step), { mode: "dryRun", outcome: result.outcome });
    }
  }

  async parkStep(step: WorkflowRuntimeStepIdentity, dependency: WorkflowDependency): Promise<void> {
    this.parked.push({ step, dependency });
  }
}

const executeActions = (handlers: Record<string, WorkflowExecuteActionHandler>): WorkflowExecuteActionPort => ({
  get: (action) => handlers[action],
});

const dryRunActions = (handlers: Record<string, WorkflowDryRunActionHandler>): WorkflowDryRunActionPort => ({
  get: (action) => handlers[action],
});

const runtime = {
  runId: "run-1",
  executionGeneration: 3,
  clock: { now: () => "2026-07-15T09:00:00.000Z" },
};

describe("workflow runtime executor", () => {
  test("executes actions, if, switch, and bounded arrays with lexical source paths", async () => {
    const repository = new FakeRepository();
    const observations: string[] = [];
    const workflow = plan([
      {
        kind: "forEach",
        reference: "inputs.items",
        alias: "item",
        sourcePath: ["steps", 4],
        steps: [
          { kind: "action", action: "capture", config: {}, sourcePath: ["steps", 4, "do", 0] },
          { kind: "action", action: "inspect", config: {}, sourcePath: ["steps", 4, "do", 1] },
        ],
      },
      {
        kind: "if",
        condition: { operator: "equals", operands: ["${{ inputs.enabled }}", true] },
        then: [{ kind: "action", action: "then", config: {}, sourcePath: ["steps", 8, "then", 0] }],
        else: [{ kind: "action", action: "else", config: {}, sourcePath: ["steps", 8, "else", 0] }],
        sourcePath: ["steps", 8],
      },
      {
        kind: "switch",
        value: "${{ inputs.status }}",
        cases: [
          {
            when: "ready",
            steps: [{ kind: "action", action: "ready", config: {}, sourcePath: ["steps", 12, "cases", 0, "do", 0] }],
          },
        ],
        default: [{ kind: "action", action: "default", config: {}, sourcePath: ["steps", 12, "default", 0] }],
        sourcePath: ["steps", 12],
      },
      { kind: "action", action: "outer", config: {}, sourcePath: ["steps", 20] },
    ]);

    const actions = executeActions({
      capture: {
        execute: async (context) => {
          const name = await context.resolveReference("item.name");
          observations.push(`capture:${name}:${context.step.key}`);
          context.variables.set("iterationValue", name ?? null);
          return { state: "completed", output: name };
        },
      },
      inspect: {
        execute: async (context) => {
          observations.push(`inspect:${context.variables.get("iterationValue")}`);
          return { state: "completed" };
        },
      },
      then: { execute: async () => ({ state: "completed", output: "then" }) },
      else: { execute: async () => ({ state: "failed", error: { code: "WRONG_BRANCH", message: "wrong branch", retryable: false } }) },
      ready: { execute: async () => ({ state: "completed", output: "ready" }) },
      default: { execute: async () => ({ state: "failed", error: { code: "WRONG_CASE", message: "wrong case", retryable: false } }) },
      outer: {
        execute: async (context) => {
          expect(context.variables.has("iterationValue")).toBe(false);
          return { state: "completed", output: "done" };
        },
      },
    });

    const result = await executeWorkflowPlan({
      ...runtime,
      plan: workflow,
      invocation: invocation("execute", { items: [{ name: "a" }, { name: "b" }], enabled: true, status: "ready" }),
      repository,
      actions,
      maxLoopItems: 2,
    });

    expect(result).toEqual({ state: "succeeded", output: "done" });
    expect(observations).toEqual(["capture:a:steps.4.do.0#0", "inspect:a", "capture:b:steps.4.do.0#1", "inspect:b"]);
    expect(repository.started.some((step) => step.key === "steps.8.then.0")).toBe(true);
    expect(repository.started.some((step) => step.key === "steps.12.cases.0.do.0")).toBe(true);
    expect(repository.started.some((step) => step.action === "else" || step.action === "default")).toBe(false);
  });

  test("delegates app-owned references while preserving local fallback values", async () => {
    const repository = new FakeRepository();
    const resolved: string[] = [];
    const result = await executeWorkflowPlan({
      ...runtime,
      plan: plan([
        {
          kind: "if",
          condition: { operator: "equals", operands: ["${{ inputs.item.Status }}", "Ready"] },
          then: [{ kind: "action", action: "capture", config: { value: "${{ inputs.label }}" }, sourcePath: ["steps", 0, "then", 0] }],
          else: [],
          sourcePath: ["steps", 0],
        },
      ]),
      invocation: invocation("execute", { item: "record-1", label: "checked" }),
      repository,
      values: {
        resolve: async ({ reference, fallback }) => {
          resolved.push(reference);
          const value = reference === "inputs.item.Status" ? "Ready" : fallback();
          return value === undefined ? { state: "missing" } : { state: "resolved", value };
        },
      },
      actions: executeActions({
        capture: { execute: async (context, step) => ({ state: "completed", output: await context.evaluate(step.config.value!) }) },
      }),
    });

    expect(result).toEqual({ state: "succeeded", output: "checked" });
    expect(resolved).toEqual(["inputs.item.Status", "inputs.label"]);
  });

  test("evaluates recursive text conditions with normalized case-insensitive text and exact structural equality", async () => {
    const result = await executeWorkflowPlan({
      ...runtime,
      plan: plan([
        {
          kind: "if",
          condition: {
            operator: "all",
            conditions: [
              { operator: "contains", operands: ["\uFF26\uFF4F\uFF4F B\u00C4R", "foo"] },
              { operator: "textEquals", operands: ["\uFF30ERSON@EXAMPLE.COM", "person@example.com"] },
              { operator: "includes", operands: [["first", "second"], "second"] },
              {
                operator: "any",
                conditions: [
                  { operator: "startsWith", operands: ["No match", "yes"] },
                  { operator: "endsWith", operands: ["Inbox/ARCHIVE", "archive"] },
                ],
              },
              {
                operator: "not",
                condition: { operator: "equals", operands: ["\u0065\u0301", "\u00E9"] },
              },
              {
                operator: "equals",
                operands: [
                  { second: 2, first: 1 },
                  { first: 1, second: 2 },
                ],
              },
            ],
          },
          then: [{ kind: "action", action: "matched", config: {}, sourcePath: ["steps", 0, "then", 0] }],
          else: [{ kind: "action", action: "missed", config: {}, sourcePath: ["steps", 0, "else", 0] }],
          sourcePath: ["steps", 0],
        },
      ]),
      invocation: invocation("execute"),
      repository: new FakeRepository(),
      actions: executeActions({
        matched: { execute: async () => ({ state: "completed", output: "matched" }) },
        missed: { execute: async () => ({ state: "completed", output: "missed" }) },
      }),
    });

    expect(result).toEqual({ state: "succeeded", output: "matched" });
  });

  test("uses the execution clock for now() instead of the invocation event time", async () => {
    const result = await executeWorkflowPlan({
      ...runtime,
      plan: plan([
        {
          kind: "action",
          action: "capture",
          config: { eventTime: "${{ inputs.eventTime }}", executionTime: "${{ now() }}" },
          sourcePath: ["steps", 0],
        },
      ]),
      invocation: invocation("execute", { eventTime: "2026-07-14T12:00:00.000Z" }),
      clock: { now: () => "2026-07-15T09:30:00.000Z" },
      repository: new FakeRepository(),
      actions: executeActions({
        capture: { execute: async (context, step) => ({ state: "completed", output: await context.evaluate(step.config) }) },
      }),
    });

    expect(result).toEqual({
      state: "succeeded",
      output: { eventTime: "2026-07-14T12:00:00.000Z", executionTime: "2026-07-15T09:30:00.000Z" },
    });
  });

  test("parks execute steps when action configuration resolution is waiting and traces the transition", async () => {
    const repository = new FakeRepository();
    const dependency = { kind: "mail.body", key: "message-1" };
    const traceTypes: string[] = [];
    let resolutions = 0;
    const result = await executeWorkflowPlan({
      ...runtime,
      plan: plan([{ kind: "action", action: "capture", config: { value: "${{ inputs.body }}" }, sourcePath: ["steps", 2] }]),
      invocation: invocation("execute"),
      repository,
      values: {
        resolve: async () => {
          resolutions += 1;
          return { state: "waiting", dependency };
        },
      },
      trace: {
        emit: (event) => {
          traceTypes.push(event.type);
        },
      },
      actions: executeActions({
        capture: { execute: async (context, step) => ({ state: "completed", output: await context.evaluate(step.config.value!) }) },
      }),
    });

    expect(result).toMatchObject({ state: "waiting", dependency, step: { key: "steps.2" } });
    expect(resolutions).toBe(1);
    expect(repository.parked).toEqual([{ step: expect.objectContaining({ key: "steps.2" }), dependency }]);
    expect(traceTypes).toEqual(["step.started", "step.waiting", "step.finished"]);
  });

  test("makes dry-run action configuration indeterminate when a reference is waiting", async () => {
    const repository = new FakeRepository();
    const dependency = { kind: "mail.attachments", key: "message-1" };
    const result = await dryRunWorkflowPlan({
      ...runtime,
      plan: plan([{ kind: "action", action: "capture", config: { value: "${{ inputs.attachments }}" }, sourcePath: ["steps", 3] }]),
      invocation: invocation("dryRun"),
      repository,
      values: { resolve: async () => ({ state: "waiting", dependency }) },
      actions: dryRunActions({
        capture: { plan: async (context, step) => ({ state: "planned", effects: [], output: await context.evaluate(step.config.value!) }) },
      }),
    });

    expect(result).toMatchObject({
      state: "indeterminate",
      reason: 'workflow reference "inputs.attachments" is waiting',
      step: { key: "steps.3" },
    });
    expect(repository.parked).toEqual([]);
  });

  test("uses order-independent three-valued waiting semantics for recursive conditions", async () => {
    const dependency = { kind: "mail.body", key: "message-2" };
    let branchCalls = 0;
    let resolutions = 0;
    const waitingResult = await executeWorkflowPlan({
      ...runtime,
      plan: plan([
        {
          kind: "if",
          condition: { operator: "not", condition: { operator: "exists", reference: "inputs.body" } },
          then: [{ kind: "action", action: "branch", config: {}, sourcePath: ["steps", 4, "then", 0] }],
          else: [],
          sourcePath: ["steps", 4],
        },
      ]),
      invocation: invocation("execute"),
      repository: new FakeRepository(),
      values: {
        resolve: async () => {
          resolutions += 1;
          return { state: "waiting", dependency };
        },
      },
      actions: executeActions({
        branch: {
          execute: async () => {
            branchCalls += 1;
            return { state: "completed" };
          },
        },
      }),
    });

    const decisiveAll = await executeWorkflowPlan({
      ...runtime,
      plan: plan([
        {
          kind: "if",
          condition: {
            operator: "all",
            conditions: [
              { operator: "exists", reference: "inputs.body" },
              { operator: "equals", operands: [false, true] },
            ],
          },
          then: [],
          else: [{ kind: "action", action: "else", config: {}, sourcePath: ["steps", 5, "else", 0] }],
          sourcePath: ["steps", 5],
        },
      ]),
      invocation: invocation("execute"),
      repository: new FakeRepository(),
      values: {
        resolve: async () => {
          resolutions += 1;
          return { state: "waiting", dependency };
        },
      },
      actions: executeActions({ else: { execute: async () => ({ state: "completed", output: "else" }) } }),
    });

    const decisiveAny = await executeWorkflowPlan({
      ...runtime,
      plan: plan([
        {
          kind: "if",
          condition: {
            operator: "any",
            conditions: [
              { operator: "exists", reference: "inputs.body" },
              { operator: "equals", operands: [true, true] },
            ],
          },
          then: [{ kind: "action", action: "then", config: {}, sourcePath: ["steps", 6, "then", 0] }],
          else: [],
          sourcePath: ["steps", 6],
        },
      ]),
      invocation: invocation("execute"),
      repository: new FakeRepository(),
      values: {
        resolve: async () => {
          resolutions += 1;
          return { state: "waiting", dependency };
        },
      },
      actions: executeActions({ then: { execute: async () => ({ state: "completed", output: "then" }) } }),
    });

    expect(waitingResult).toMatchObject({ state: "waiting", dependency, step: { key: "steps.4" } });
    expect(branchCalls).toBe(0);
    expect(decisiveAll).toEqual({ state: "succeeded", output: "else" });
    expect(decisiveAny).toEqual({ state: "succeeded", output: "then" });
    expect(resolutions).toBe(3);
  });

  test("keeps dry-run structurally isolated from execute handlers", async () => {
    const repository = new FakeRepository();
    let executeCalls = 0;
    let planCalls = 0;
    const effect = { kind: "record.update", id: "record-1" };
    const executePort = executeActions({
      mutate: {
        execute: async () => {
          executeCalls += 1;
          return { state: "completed" };
        },
      },
    });
    const planningPort = dryRunActions({
      mutate: {
        plan: async () => {
          planCalls += 1;
          return { state: "planned", output: "predicted", effects: [effect] };
        },
      },
    });

    const result = await dryRunWorkflowPlan({
      ...runtime,
      plan: plan([{ kind: "action", action: "mutate", config: {}, sourcePath: ["steps", 0] }]),
      invocation: invocation("dryRun"),
      repository,
      actions: planningPort,
    });

    expect(executePort.get("mutate")).toBeDefined();
    expect(executeCalls).toBe(0);
    expect(planCalls).toBe(1);
    expect(result).toEqual({ state: "planned", output: "predicted", effects: [effect] });
  });

  test("restores a completed action and lets its hook rebuild variable state", async () => {
    const repository = new FakeRepository();
    repository.completed.set("execute:steps.0", {
      mode: "execute",
      outcome: { state: "completed", output: "persisted" },
    });
    let restored = 0;
    let executed = 0;
    const actions = executeActions({
      produce: {
        execute: async () => {
          executed += 1;
          return { state: "completed", output: "new" };
        },
        restoreCompleted: (context, _step, outcome) => {
          restored += 1;
          context.variables.set("saved", outcome.output ?? null);
        },
      },
      consume: {
        execute: async (context) => ({ state: "completed", output: await context.evaluate("${{ saved }}") }),
      },
    });

    const result = await executeWorkflowPlan({
      ...runtime,
      plan: plan([
        { kind: "action", action: "produce", config: {}, sourcePath: ["steps", 0] },
        { kind: "action", action: "consume", config: {}, sourcePath: ["steps", 1] },
      ]),
      invocation: invocation("execute"),
      repository,
      actions,
    });

    expect(result).toEqual({ state: "succeeded", output: "persisted" });
    expect({ restored, executed }).toEqual({ restored: 1, executed: 0 });
    expect(repository.started.map((step) => step.key)).toEqual(["steps.1"]);
  });

  test("restores completed descendant actions before returning a completed control step", async () => {
    const repository = new FakeRepository();
    repository.completed.set("execute:steps.0", {
      mode: "execute",
      outcome: { state: "completed", output: "persisted", control: { kind: "if", branches: ["then"] } },
    });
    repository.completed.set("execute:steps.0.then.0", {
      mode: "execute",
      outcome: { state: "completed", output: "restored-child" },
    });
    let executed = 0;
    let restoredValue: WorkflowJsonValue | undefined;
    const actions = executeActions({
      produce: {
        execute: async () => {
          executed += 1;
          return { state: "completed", output: "new" };
        },
        restoreCompleted: (_context, _step, outcome) => {
          restoredValue = outcome.output;
        },
      },
      consume: {
        execute: async () => ({ state: "completed", output: restoredValue }),
      },
    });

    const result = await executeWorkflowPlan({
      ...runtime,
      plan: plan([
        {
          kind: "if",
          condition: { operator: "equals", operands: ["${{ inputs.enabled }}", true] },
          then: [{ kind: "action", action: "produce", config: {}, sourcePath: ["steps", 0, "then", 0] }],
          else: [],
          sourcePath: ["steps", 0],
        },
        { kind: "action", action: "consume", config: {}, sourcePath: ["steps", 1] },
      ]),
      invocation: invocation("execute", { enabled: false }),
      repository,
      actions,
    });

    expect(result).toEqual({ state: "succeeded", output: "restored-child" });
    expect(executed).toBe(0);
    expect(repository.started.map((step) => step.key)).toEqual(["steps.1"]);
  });

  test("restores nested dry-run state from the persisted traversal", async () => {
    const repository = new FakeRepository();
    repository.completed.set("dryRun:steps.0", {
      mode: "dryRun",
      outcome: { state: "planned", effects: [], control: { kind: "if", branches: ["then"] } },
    });
    repository.completed.set("dryRun:steps.0.then.0", {
      mode: "dryRun",
      outcome: { state: "planned", output: "persisted", effects: [] },
    });
    repository.completed.set("dryRun:steps.0.then.1", {
      mode: "dryRun",
      outcome: { state: "planned", effects: [] },
    });
    let plannedSeed = 0;
    let restoredValue: WorkflowJsonValue | undefined;
    const result = await dryRunWorkflowPlan({
      ...runtime,
      plan: plan([
        {
          kind: "if",
          condition: { operator: "equals", operands: ["${{ inputs.enabled }}", true] },
          then: [
            { kind: "action", action: "seed", config: {}, sourcePath: ["steps", 0, "then", 0] },
            { kind: "action", action: "consume", config: {}, sourcePath: ["steps", 0, "then", 1] },
          ],
          else: [],
          sourcePath: ["steps", 0],
        },
      ]),
      invocation: invocation("dryRun", { enabled: false }),
      repository,
      actions: dryRunActions({
        seed: {
          plan: async () => {
            plannedSeed += 1;
            return { state: "planned", effects: [] };
          },
          restoreCompleted: (context, _step, outcome) => context.variables.set("saved", outcome.output ?? null),
        },
        consume: {
          plan: async () => ({ state: "planned", effects: [] }),
          restoreCompleted: (context) => {
            restoredValue = context.variables.get("saved");
          },
        },
      }),
    });

    expect(result).toEqual({ state: "planned", effects: [] });
    expect(restoredValue).toBe("persisted");
    expect(plannedSeed).toBe(0);
  });

  test("refuses malformed persisted control traversals instead of guessing a branch", async () => {
    const repository = new FakeRepository();
    repository.completed.set("execute:steps.0", {
      mode: "execute",
      outcome: { state: "completed", control: { kind: "if", branches: ["unknown"] } },
    } as unknown as WorkflowRestoredStep);

    const result = await executeWorkflowPlan({
      ...runtime,
      plan: plan([
        {
          kind: "if",
          condition: { operator: "equals", operands: [true, true] },
          then: [],
          else: [],
          sourcePath: ["steps", 0],
        },
      ]),
      invocation: invocation("execute"),
      repository,
      actions: executeActions({}),
    });

    expect(result).toMatchObject({
      state: "needs_attention",
      error: { code: "WORKFLOW_RESTORE_INVALID", message: expect.stringContaining("invalid persisted traversal branches") },
      step: { key: "steps.0" },
    });
  });

  test("returns and persists an opaque waiting dependency", async () => {
    const repository = new FakeRepository();
    const dependency = { kind: "approval", key: "approval-1", deadline: "2026-07-15T12:00:00.000Z" };
    const result = await executeWorkflowPlan({
      ...runtime,
      plan: plan([{ kind: "action", action: "wait", config: {}, sourcePath: ["steps", 2] }]),
      invocation: invocation("execute"),
      repository,
      actions: executeActions({ wait: { execute: async () => ({ state: "waiting", dependency }) } }),
    });

    expect(result).toMatchObject({ state: "waiting", dependency, step: { key: "steps.2" } });
    expect(repository.finished).toEqual([]);
    expect(repository.parked).toEqual([{ step: expect.objectContaining({ key: "steps.2" }), dependency }]);
  });

  test("leaves enclosing control steps resumable while atomically parking the waiting action", async () => {
    const repository = new FakeRepository();
    const dependency = { kind: "approval", key: "approval-nested" };
    const result = await executeWorkflowPlan({
      ...runtime,
      plan: plan([
        {
          kind: "if",
          condition: { operator: "equals", operands: [true, true] },
          then: [{ kind: "action", action: "wait", config: {}, sourcePath: ["steps", 0, "then", 0] }],
          else: [],
          sourcePath: ["steps", 0],
        },
      ]),
      invocation: invocation("execute"),
      repository,
      actions: executeActions({ wait: { execute: async () => ({ state: "waiting", dependency }) } }),
    });

    expect(result).toMatchObject({ state: "waiting", step: { key: "steps.0.then.0" } });
    expect(repository.finished).toEqual([]);
    expect(repository.parked).toEqual([{ step: expect.objectContaining({ key: "steps.0.then.0" }), dependency }]);
  });

  test("leaves enclosing control steps resumable when a nested effect needs attention", async () => {
    const repository = new FakeRepository();
    const error = { code: "UNKNOWN", message: "effect outcome unknown", retryable: false };
    const result = await executeWorkflowPlan({
      ...runtime,
      plan: plan([
        {
          kind: "if",
          condition: { operator: "equals", operands: [true, true] },
          then: [{ kind: "action", action: "ambiguous", config: {}, sourcePath: ["steps", 0, "then", 0] }],
          else: [],
          sourcePath: ["steps", 0],
        },
      ]),
      invocation: invocation("execute"),
      repository,
      actions: executeActions({ ambiguous: { execute: async () => ({ state: "needs_attention", error }) } }),
    });

    expect(result).toMatchObject({ state: "needs_attention", step: { key: "steps.0.then.0" } });
    expect(repository.finished.map(({ step, result }) => [step.key, result.outcome.state])).toEqual([
      ["steps.0.then.0", "needs_attention"],
    ]);
  });

  test("closes enclosing control steps when a nested action fails", async () => {
    const repository = new FakeRepository();
    const error = { code: "FAILED", message: "nested failure", retryable: false };
    const result = await executeWorkflowPlan({
      ...runtime,
      plan: plan([
        {
          kind: "if",
          condition: { operator: "equals", operands: [true, true] },
          then: [{ kind: "action", action: "fail", config: {}, sourcePath: ["steps", 0, "then", 0] }],
          else: [],
          sourcePath: ["steps", 0],
        },
      ]),
      invocation: invocation("execute"),
      repository,
      actions: executeActions({ fail: { execute: async () => ({ state: "failed", error }) } }),
    });

    expect(result).toMatchObject({ state: "failed", error });
    expect(repository.finished.map(({ step, result }) => [step.key, result.outcome.state])).toEqual([
      ["steps.0.then.0", "failed"],
      ["steps.0", "failed"],
    ]);
  });

  test("cancels cooperatively from a handler heartbeat", async () => {
    const repository = new FakeRepository();
    repository.heartbeats = [{ state: "active" }, { state: "canceled", message: "stopped by user" }];
    let reachedAfterHeartbeat = false;
    const result = await executeWorkflowPlan({
      ...runtime,
      plan: plan([{ kind: "action", action: "long", config: {}, sourcePath: ["steps", 3] }]),
      invocation: invocation("execute"),
      repository,
      actions: executeActions({
        long: {
          execute: async (context) => {
            await context.heartbeat();
            reachedAfterHeartbeat = true;
            return { state: "completed" };
          },
        },
      }),
    });

    expect(result).toMatchObject({ state: "canceled", message: "stopped by user", step: { key: "steps.3" } });
    expect(reachedAfterHeartbeat).toBe(false);
    expect(repository.finished[0]?.result).toEqual({
      mode: "execute",
      outcome: { state: "terminal", status: "canceled", message: "stopped by user" },
    });
  });

  test("reports cancellation explicitly during dry-run", async () => {
    const repository = new FakeRepository();
    repository.heartbeats = [{ state: "canceled", message: "preview stopped" }];
    const result = await dryRunWorkflowPlan({
      ...runtime,
      plan: plan([{ kind: "action", action: "plan", config: {}, sourcePath: ["steps", 6] }]),
      invocation: invocation("dryRun"),
      repository,
      actions: dryRunActions({ plan: { plan: async () => ({ state: "planned", effects: [] }) } }),
    });

    expect(result).toMatchObject({ state: "canceled", message: "preview stopped", step: { key: "steps.6" }, effects: [] });
  });

  test("propagates stale leases without cancellation traces or terminal writes", async () => {
    const repository = new FakeRepository();
    repository.heartbeats = [{ state: "stale" }];
    const traced: string[] = [];

    await expect(
      executeWorkflowPlan({
        ...runtime,
        plan: plan([{ kind: "action", action: "run", config: {}, sourcePath: ["steps", 0] }]),
        invocation: invocation("execute"),
        repository,
        actions: executeActions({ run: { execute: async () => ({ state: "completed" }) } }),
        trace: {
          emit: (event) => {
            traced.push(event.type);
          },
        },
      }),
    ).rejects.toBeInstanceOf(WorkflowLeaseLostError);

    expect(repository.started).toEqual([]);
    expect(repository.finished).toEqual([]);
    expect(traced).toEqual([]);
  });

  test("finishes nested dry-run steps when a planner heartbeat observes cancellation", async () => {
    const repository = new FakeRepository();
    repository.heartbeats = [{ state: "active" }, { state: "active" }, { state: "canceled", message: "preview stopped" }];
    const result = await dryRunWorkflowPlan({
      ...runtime,
      plan: plan([
        {
          kind: "if",
          condition: { operator: "equals", operands: [true, true] },
          then: [{ kind: "action", action: "plan", config: {}, sourcePath: ["steps", 0, "then", 0] }],
          else: [],
          sourcePath: ["steps", 0],
        },
      ]),
      invocation: invocation("dryRun"),
      repository,
      actions: dryRunActions({
        plan: {
          plan: async (context) => {
            await context.heartbeat();
            return { state: "planned", effects: [] };
          },
        },
      }),
    });

    expect(result).toMatchObject({ state: "canceled", message: "preview stopped" });
    expect(repository.finished.map(({ step, result }) => [step.key, result.outcome.state])).toEqual([
      ["steps.0.then.0", "canceled"],
      ["steps.0", "canceled"],
    ]);
  });

  test("preserves terminal success and needs-attention outcomes", async () => {
    const terminalRepository = new FakeRepository();
    let skippedCalls = 0;
    const terminal = await executeWorkflowPlan({
      ...runtime,
      plan: plan([
        { kind: "action", action: "stop", config: {}, sourcePath: ["steps", 0] },
        { kind: "action", action: "skipped", config: {}, sourcePath: ["steps", 1] },
      ]),
      invocation: invocation("execute"),
      repository: terminalRepository,
      actions: executeActions({
        stop: { execute: async () => ({ state: "terminal", status: "succeeded", message: "complete early" }) },
        skipped: {
          execute: async () => {
            skippedCalls += 1;
            return { state: "completed" };
          },
        },
      }),
    });
    expect(terminal).toEqual({ state: "succeeded", message: "complete early" });
    expect(skippedCalls).toBe(0);

    const attentionRepository = new FakeRepository();
    const error = { code: "UNKNOWN_EXTERNAL_RESULT", message: "provider outcome is ambiguous", retryable: false };
    const attention = await executeWorkflowPlan({
      ...runtime,
      plan: plan([{ kind: "action", action: "ambiguous", config: {}, sourcePath: ["steps", 7] }]),
      invocation: invocation("execute"),
      repository: attentionRepository,
      actions: executeActions({ ambiguous: { execute: async () => ({ state: "needs_attention", error }) } }),
    });
    expect(attention).toMatchObject({ state: "needs_attention", error, step: { key: "steps.7" } });
  });

  test("restores terminal and failed steps without executing them again", async () => {
    for (const outcome of [
      { state: "terminal", status: "succeeded", message: "done" } as const,
      { state: "failed", error: { code: "FAILED", message: "stopped", retryable: false } } as const,
    ]) {
      const repository = new FakeRepository();
      repository.completed.set("execute:steps.0", { mode: "execute", outcome });
      let executions = 0;
      const result = await executeWorkflowPlan({
        ...runtime,
        plan: plan([{ kind: "action", action: "stop", config: {}, sourcePath: ["steps", 0] }]),
        invocation: invocation("execute"),
        repository,
        actions: executeActions({
          stop: {
            execute: async () => {
              executions += 1;
              return { state: "completed" };
            },
          },
        }),
      });
      expect(executions).toBe(0);
      expect(result.state).toBe(outcome.state === "terminal" ? "succeeded" : "failed");
    }
  });

  test("halts dry-run traversal on explicit terminal planning outcomes", async () => {
    const repository = new FakeRepository();
    let skippedCalls = 0;
    const result = await dryRunWorkflowPlan({
      ...runtime,
      plan: plan([
        { kind: "action", action: "stop", config: {}, sourcePath: ["steps", 0] },
        { kind: "action", action: "skipped", config: {}, sourcePath: ["steps", 1] },
      ]),
      invocation: invocation("dryRun"),
      repository,
      actions: dryRunActions({
        stop: { plan: async () => ({ state: "terminal", status: "failed", message: "would fail", effects: [] }) },
        skipped: {
          plan: async () => {
            skippedCalls += 1;
            return { state: "planned", effects: [] };
          },
        },
      }),
    });
    expect(result).toEqual({ state: "terminal", status: "failed", message: "would fail", effects: [] });
    expect(skippedCalls).toBe(0);
  });

  test("reports unsupported and indeterminate dry-run plans without execution", async () => {
    const unsupported = await dryRunWorkflowPlan({
      ...runtime,
      plan: plan([{ kind: "action", action: "external", config: {}, sourcePath: ["steps", 0] }]),
      invocation: invocation("dryRun"),
      repository: new FakeRepository(),
      actions: dryRunActions({}),
    });
    expect(unsupported).toMatchObject({
      state: "unsupported",
      reason: 'action "external" has no dry-run handler',
      effects: [],
      step: { key: "steps.0" },
    });

    const indeterminate = await dryRunWorkflowPlan({
      ...runtime,
      plan: plan([{ kind: "forEach", reference: "inputs.unknown", alias: "item", steps: [], sourcePath: ["steps", 5] }]),
      invocation: invocation("dryRun"),
      repository: new FakeRepository(),
      actions: dryRunActions({}),
    });
    expect(indeterminate).toMatchObject({
      state: "indeterminate",
      reason: 'forEach reference "inputs.unknown" must resolve to a JSON array',
      effects: [],
      step: { key: "steps.5" },
    });
  });

  test("validates a forEach body once when the collection is unavailable", async () => {
    let plannerCalls = 0;
    const result = await dryRunWorkflowPlan({
      ...runtime,
      plan: plan([
        {
          kind: "forEach",
          reference: "inputs.unknown",
          alias: "item",
          steps: [{ kind: "action", action: "inspect", config: {}, sourcePath: ["steps", 0, "do", 0] }],
          sourcePath: ["steps", 0],
        },
      ]),
      invocation: invocation("dryRun"),
      repository: new FakeRepository(),
      actions: dryRunActions({
        inspect: {
          plan: async () => {
            plannerCalls += 1;
            return { state: "planned", effects: [] };
          },
        },
      }),
    });

    expect(plannerCalls).toBe(1);
    expect(result).toMatchObject({ state: "indeterminate", issues: [{ step: { key: "steps.0" } }] });
  });

  test("continues dry-run analysis after unsupported actions and reports every gap", async () => {
    const repository = new FakeRepository();
    let laterCalls = 0;
    const effect = { kind: "later.effect" };
    const result = await dryRunWorkflowPlan({
      ...runtime,
      plan: plan([
        { kind: "action", action: "unsupported", config: {}, sourcePath: ["steps", 0] },
        { kind: "action", action: "indeterminate", config: {}, sourcePath: ["steps", 1] },
        { kind: "action", action: "later", config: {}, sourcePath: ["steps", 2] },
      ]),
      invocation: invocation("dryRun"),
      repository,
      actions: dryRunActions({
        indeterminate: { plan: async () => ({ state: "indeterminate", reason: "unknown output" }) },
        later: {
          plan: async () => {
            laterCalls += 1;
            return { state: "planned", effects: [effect] };
          },
        },
      }),
    });

    expect(laterCalls).toBe(1);
    expect(result).toMatchObject({
      state: "indeterminate",
      effects: [effect],
      issues: [
        { state: "unsupported", step: { key: "steps.0" } },
        { state: "indeterminate", reason: "unknown output", step: { key: "steps.1" } },
      ],
    });
  });

  test("analyzes every branch when a dry-run condition is indeterminate", async () => {
    const calls: string[] = [];
    const result = await dryRunWorkflowPlan({
      ...runtime,
      plan: plan([
        {
          kind: "if",
          condition: { operator: "equals", operands: ["${{ steps.missing.output }}", true] },
          then: [{ kind: "action", action: "then", config: {}, sourcePath: ["steps", 0, "then", 0] }],
          else: [{ kind: "action", action: "else", config: {}, sourcePath: ["steps", 0, "else", 0] }],
          sourcePath: ["steps", 0],
        },
      ]),
      invocation: invocation("dryRun"),
      repository: new FakeRepository(),
      actions: dryRunActions({
        then: { plan: async () => (calls.push("then"), { state: "planned", effects: [] }) },
        else: { plan: async () => (calls.push("else"), { state: "planned", effects: [] }) },
      }),
    });

    expect(calls).toEqual(["then", "else"]);
    expect(result).toMatchObject({ state: "indeterminate", issues: [{ step: { key: "steps.0" } }] });
  });

  test("restores dry-run issues captured by completed control steps", async () => {
    const repository = new FakeRepository();
    let plannedCalls = 0;
    const workflow = plan([
      {
        kind: "if",
        condition: { operator: "equals", operands: [true, true] },
        then: [
          { kind: "action", action: "unsupported", config: {}, sourcePath: ["steps", 0, "then", 0] },
          { kind: "action", action: "later", config: {}, sourcePath: ["steps", 0, "then", 1] },
        ],
        else: [],
        sourcePath: ["steps", 0],
      },
    ]);
    const actions = dryRunActions({
      later: {
        plan: async () => {
          plannedCalls += 1;
          return { state: "planned", effects: [{ kind: "later.effect" }] };
        },
      },
    });
    const run = () =>
      dryRunWorkflowPlan({
        ...runtime,
        plan: workflow,
        invocation: invocation("dryRun"),
        repository,
        actions,
      });

    const first = await run();
    const restored = await run();

    expect(first).toMatchObject({ state: "unsupported", issues: [{ step: { key: "steps.0.then.0" } }] });
    expect(restored).toMatchObject({
      state: "unsupported",
      effects: [{ kind: "later.effect" }],
      issues: [{ step: { key: "steps.0.then.0" } }],
    });
    expect(plannedCalls).toBe(1);
  });

  test("does not expose inherited properties as workflow values", async () => {
    const result = await executeWorkflowPlan({
      ...runtime,
      plan: plan([{ kind: "action", action: "capture", config: { value: "${{ inputs.constructor }}" }, sourcePath: ["steps", 0] }]),
      invocation: invocation("execute"),
      repository: new FakeRepository(),
      actions: executeActions({
        capture: { execute: async (context, step) => ({ state: "completed", output: await context.evaluate(step.config.value!) }) },
      }),
    });

    expect(result).toMatchObject({
      state: "failed",
      error: { code: "WORKFLOW_VALUE_UNAVAILABLE", retryable: false },
    });
  });

  test("does not mark unexpected action errors as retryable", async () => {
    const result = await executeWorkflowPlan({
      ...runtime,
      plan: plan([{ kind: "action", action: "explode", config: {}, sourcePath: ["steps", 0] }]),
      invocation: invocation("execute"),
      repository: new FakeRepository(),
      actions: executeActions({ explode: { execute: async () => Promise.reject(new Error("boom")) } }),
    });

    expect(result).toMatchObject({ state: "failed", error: { code: "WORKFLOW_ACTION_ERROR", retryable: false } });
  });

  test("leaves retryable action failures unfinished for the durable adapter to retry", async () => {
    const repository = new FakeRepository();
    const error = { code: "UPSTREAM_UNAVAILABLE", message: "try again", retryable: true } as const;

    await expect(
      executeWorkflowPlan({
        ...runtime,
        plan: plan([{ kind: "action", action: "retry", config: {}, sourcePath: ["steps", 0] }]),
        invocation: invocation("execute"),
        repository,
        actions: executeActions({ retry: { execute: async () => ({ state: "failed", error }) } }),
      }),
    ).rejects.toMatchObject({ name: "WorkflowRetryableStepError", executionError: error, step: { key: "steps.0" } });
    expect(repository.finished).toEqual([]);
  });

  test("propagates retryable failures through every control step", async () => {
    const nestedSteps: WorkflowBoundPlan["steps"][] = [
      [
        {
          kind: "if",
          condition: { operator: "equals", operands: [true, true] },
          then: [{ kind: "action", action: "retry", config: {}, sourcePath: ["steps", 0, "then", 0] }],
          else: [],
          sourcePath: ["steps", 0],
        },
      ],
      [
        {
          kind: "switch",
          value: "match",
          cases: [
            {
              when: "match",
              steps: [{ kind: "action", action: "retry", config: {}, sourcePath: ["steps", 0, "cases", 0, "do", 0] }],
            },
          ],
          default: [],
          sourcePath: ["steps", 0],
        },
      ],
      [
        {
          kind: "forEach",
          reference: "inputs.items",
          alias: "item",
          steps: [{ kind: "action", action: "retry", config: {}, sourcePath: ["steps", 0, "do", 0] }],
          sourcePath: ["steps", 0],
        },
      ],
    ];
    const error = { code: "UPSTREAM_UNAVAILABLE", message: "try again", retryable: true } as const;

    for (const steps of nestedSteps) {
      const repository = new FakeRepository();
      await expect(
        executeWorkflowPlan({
          ...runtime,
          plan: plan(steps),
          invocation: invocation("execute", { items: [1] }),
          repository,
          actions: executeActions({ retry: { execute: async () => ({ state: "failed", error }) } }),
        }),
      ).rejects.toMatchObject({ name: "WorkflowRetryableStepError", executionError: error });
      expect(repository.finished).toEqual([]);
    }
  });

  test("enforces bound effect and dry-run policies", async () => {
    const ambiguousPlan = plan([{ kind: "action", action: "external", config: {}, sourcePath: ["steps", 0] }]);
    ambiguousPlan.actionPolicies.external = { effect: "ambiguous-external", dryRun: "unsupported" };
    await expect(
      executeWorkflowPlan({
        ...runtime,
        plan: ambiguousPlan,
        invocation: invocation("execute"),
        repository: new FakeRepository(),
        actions: executeActions({
          external: {
            execute: async () => ({
              state: "failed",
              error: { code: "NETWORK_TIMEOUT", message: "request failed before the effect", retryable: true },
            }),
          },
        }),
      }),
    ).rejects.toMatchObject({
      name: "WorkflowRetryableStepError",
      executionError: { code: "NETWORK_TIMEOUT", retryable: true },
    });

    let plannerCalls = 0;
    const planning = await dryRunWorkflowPlan({
      ...runtime,
      plan: ambiguousPlan,
      invocation: invocation("dryRun"),
      repository: new FakeRepository(),
      actions: dryRunActions({
        external: {
          plan: async () => {
            plannerCalls += 1;
            return { state: "planned", effects: [] };
          },
        },
      }),
    });
    expect(plannerCalls).toBe(0);
    expect(planning).toMatchObject({ state: "unsupported", reason: 'action "external" does not support dry-run' });
  });

  test("rejects arrays beyond the configured loop bound", async () => {
    const result = await executeWorkflowPlan({
      ...runtime,
      plan: plan([
        {
          kind: "forEach",
          reference: "inputs.items",
          alias: "item",
          steps: [{ kind: "action", action: "never", config: {}, sourcePath: ["steps", 0, "do", 0] }],
          sourcePath: ["steps", 0],
        },
      ]),
      invocation: invocation("execute", { items: [1, 2] }),
      repository: new FakeRepository(),
      actions: executeActions({ never: { execute: async () => ({ state: "completed" }) } }),
      maxLoopItems: 1,
    });

    expect(result).toMatchObject({
      state: "failed",
      error: { code: "WORKFLOW_VALUE_UNAVAILABLE", message: 'forEach reference "inputs.items" has 2 items; limit is 1' },
      step: { key: "steps.0" },
    });
  });

  test("uses the bound manifest loop limit and only allows tighter runtime limits", async () => {
    const steps: WorkflowBoundPlan["steps"] = [
      {
        kind: "forEach",
        reference: "inputs.items",
        alias: "item",
        steps: [{ kind: "action", action: "capture", config: {}, sourcePath: ["steps", 0, "do", 0] }],
        sourcePath: ["steps", 0],
      },
    ];
    const run = (maxLoopItems: number | undefined) =>
      executeWorkflowPlan({
        ...runtime,
        plan: plan(steps, 3),
        invocation: invocation("execute", { items: [1, 2, 3] }),
        repository: new FakeRepository(),
        actions: executeActions({ capture: { execute: async () => ({ state: "completed" }) } }),
        ...(maxLoopItems === undefined ? {} : { maxLoopItems }),
      });

    expect(await run(undefined)).toMatchObject({ state: "succeeded" });
    expect(await run(10)).toMatchObject({ state: "succeeded" });
    expect(await run(2)).toMatchObject({ state: "failed", error: { message: expect.stringContaining("limit is 2") } });
  });
});

for (const operator of ["greaterThan", "lessThan", "atLeast", "atMost"] as const) {
  test(`evaluates ${operator} without coercion, including recursive groups and missing values`, async () => {
    const compare = (left: number, right: number) =>
      operator === "greaterThan"
        ? left > right
        : operator === "lessThan"
          ? left < right
          : operator === "atLeast"
            ? left >= right
            : left <= right;
    const pairs: Array<[WorkflowJsonValue | undefined, WorkflowJsonValue | undefined]> = [
      [2, 1],
      [1, 2],
      [1, 1],
      [-1.5, 0],
      [0, 0],
      ["2", 1],
      [2, "1"],
      [null, 0],
      [true, 0],
      [[], 0],
      [{}, 0],
      [NaN, 0],
      [0, Infinity],
      [-Infinity, 0],
      [undefined, 0],
      [0, undefined],
    ];
    for (const [left, right] of pairs) {
      const expected =
        typeof left === "number" && typeof right === "number" && Number.isFinite(left) && Number.isFinite(right) && compare(left, right);
      const result = await executeWorkflowPlan({
        ...runtime,
        plan: plan([
          {
            kind: "if",
            sourcePath: ["steps", 0],
            condition: {
              operator: "all",
              conditions: [
                {
                  operator: "any",
                  conditions: [
                    { operator: "not", condition: { operator: "equals", operands: [1, 1] } },
                    { operator, operands: ["${{ inputs.left }}", "${{ inputs.right }}"] },
                  ],
                },
              ],
            },
            then: [{ kind: "action", action: "matched", config: {}, sourcePath: ["steps", 0, "then", 0] }],
            else: [{ kind: "action", action: "missed", config: {}, sourcePath: ["steps", 0, "else", 0] }],
          },
        ]),
        invocation: invocation("execute", { ...(left === undefined ? {} : { left }), ...(right === undefined ? {} : { right }) }),
        repository: new FakeRepository(),
        actions: executeActions({
          matched: { execute: async () => ({ state: "completed", output: true }) },
          missed: { execute: async () => ({ state: "completed", output: false }) },
        }),
      });
      expect(result).toEqual({ state: "succeeded", output: expected });
    }
  });
}

test("number comparisons wait for unresolved application dependencies", async () => {
  const dependency = { kind: "mail.hydration", key: "message-1" };
  for (const operator of ["greaterThan", "lessThan", "atLeast", "atMost"] as const) {
    const result = await executeWorkflowPlan({
      ...runtime,
      plan: plan([
        {
          kind: "if",
          sourcePath: ["steps", 0],
          condition: { operator, operands: ["${{ inputs.message.textLength }}", 150] },
          then: [],
          else: [],
        },
      ]),
      invocation: invocation("execute"),
      repository: new FakeRepository(),
      actions: executeActions({}),
      values: { resolve: async () => ({ state: "waiting", dependency }) },
    });
    expect(result).toMatchObject({ state: "waiting", dependency, step: { key: "steps.0" } });
  }
});
