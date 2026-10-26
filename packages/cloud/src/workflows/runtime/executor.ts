import type {
  WorkflowCondition,
  WorkflowControlTraversal,
  WorkflowDependency,
  WorkflowExecutionError,
  WorkflowIrStep,
  WorkflowJsonValue,
  WorkflowPlanningIssue,
  WorkflowPlanningOutcome,
  WorkflowStepOutcome,
} from "../contracts";
import { workflowPathKey } from "../contracts";
import { readWorkflowValuePath } from "../language/references";
import type {
  WorkflowActionStep,
  WorkflowDryRunActionContext,
  WorkflowDryRunIssue,
  WorkflowDryRunOptions,
  WorkflowDryRunResult,
  WorkflowExecuteActionContext,
  WorkflowExecuteOptions,
  WorkflowExecutionResult,
  WorkflowHeartbeatOutcome,
  WorkflowRestoredStep,
  WorkflowRuntimeRunIdentity,
  WorkflowRuntimeStepIdentity,
  WorkflowRuntimeStepResult,
  WorkflowTraceEvent,
  WorkflowValueResolution,
  WorkflowVariableScope,
} from "./ports";

export const DEFAULT_MAX_LOOP_ITEMS = 100;

const EXACT_EXPRESSION = /^\$\{\{\s*([^{}]+?)\s*\}\}$/;

class RuntimeVariableScope implements WorkflowVariableScope {
  readonly #values = new Map<string, WorkflowJsonValue>();

  constructor(
    initial: Record<string, WorkflowJsonValue> = {},
    readonly parent?: RuntimeVariableScope,
  ) {
    for (const [name, value] of Object.entries(initial)) this.#values.set(name, value);
  }

  get(name: string): WorkflowJsonValue | undefined {
    return this.#values.has(name) ? this.#values.get(name) : this.parent?.get(name);
  }

  has(name: string): boolean {
    return this.#values.has(name) || this.parent?.has(name) === true;
  }

  set(name: string, value: WorkflowJsonValue): void {
    this.#values.set(name, value);
  }

  snapshot(): Record<string, WorkflowJsonValue> {
    return {
      ...(this.parent?.snapshot() ?? {}),
      ...Object.fromEntries(this.#values),
    };
  }

  child(initial: Record<string, WorkflowJsonValue> = {}): RuntimeVariableScope {
    return new RuntimeVariableScope(initial, this);
  }
}

class WorkflowCancellation extends Error {
  constructor(readonly cancellation: Extract<WorkflowHeartbeatOutcome, { state: "canceled" }>) {
    super(cancellation.message ?? "workflow canceled");
  }
}

export class WorkflowLeaseLostError extends Error {
  override readonly name = "WorkflowLeaseLostError";

  constructor() {
    super("workflow execution lease was lost");
  }
}

export class WorkflowRetryableStepError extends Error {
  override readonly name = "WorkflowRetryableStepError";

  constructor(
    readonly step: WorkflowRuntimeStepIdentity,
    readonly executionError: WorkflowExecutionError,
  ) {
    super(executionError.message);
  }
}

export class WorkflowValueError extends Error {
  constructor(
    message: string,
    readonly code = "WORKFLOW_VALUE_UNAVAILABLE",
  ) {
    super(message);
  }
}

class WorkflowValueWaiting extends Error {
  constructor(
    reference: string,
    readonly dependency: WorkflowDependency,
  ) {
    super(`workflow reference "${reference}" is waiting`);
  }
}

type RuntimeOptions = (WorkflowExecuteOptions & { mode: "execute" }) | (WorkflowDryRunOptions & { mode: "dryRun" });

type RuntimeState = {
  options: RuntimeOptions;
  run: WorkflowRuntimeRunIdentity;
  effects: WorkflowJsonValue[];
  issues: WorkflowDryRunIssue[];
  cancellationTraced: boolean;
};

type Continue = { state: "continue"; output?: WorkflowJsonValue };
type Halt =
  | { state: "waiting"; dependency: Extract<WorkflowStepOutcome, { state: "waiting" }>["dependency"]; step: WorkflowRuntimeStepIdentity }
  | { state: "failed"; error: WorkflowExecutionError; step: WorkflowRuntimeStepIdentity }
  | { state: "needs_attention"; error: WorkflowExecutionError; step: WorkflowRuntimeStepIdentity }
  | { state: "canceled"; message?: string; step?: WorkflowRuntimeStepIdentity }
  | { state: "terminal_succeeded"; message?: string }
  | { state: "terminal_planned"; status: "succeeded" | "failed"; message?: string; step: WorkflowRuntimeStepIdentity }
  | { state: "unsupported"; reason: string; step: WorkflowRuntimeStepIdentity }
  | { state: "indeterminate"; reason: string; step: WorkflowRuntimeStepIdentity };
type Flow = Continue | Halt;

type StepEvaluation = {
  flow: Flow;
  result?: WorkflowRuntimeStepResult;
};

const executionError = (code: string, message: string, retryable = false): WorkflowExecutionError => ({
  code,
  message,
  retryable,
});

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const optionalOutput = (output: WorkflowJsonValue | undefined): { output?: WorkflowJsonValue } => (output === undefined ? {} : { output });

const optionalMessage = (message: string | undefined): { message?: string } => (message === undefined ? {} : { message });

const emit = async (state: RuntimeState, event: WorkflowTraceEvent): Promise<void> => {
  try {
    await state.options.trace?.emit(event);
  } catch {
    // Observability is never part of the run's correctness contract.
  }
};

const storedIssues = (issues: WorkflowDryRunIssue[]): WorkflowPlanningIssue[] =>
  issues.map((issue) => ({
    ...issue,
    step: {
      key: issue.step.key,
      sourcePath: [...issue.step.sourcePath],
      iterationPath: [...issue.step.iterationPath],
      path: [...issue.step.path],
      kind: issue.step.kind,
      ...(issue.step.action ? { action: issue.step.action } : {}),
    },
  }));

const restoredIssues = (state: RuntimeState, issues: WorkflowPlanningIssue[] | undefined): WorkflowDryRunIssue[] =>
  issues?.map((issue) => ({ ...issue, step: { ...state.run, ...issue.step } })) ?? [];

const stepIdentity = (state: RuntimeState, step: WorkflowIrStep, iterationPath: number[]): WorkflowRuntimeStepIdentity => {
  const iterationKey = iterationPath.length === 0 ? "" : `#${iterationPath.join(".")}`;
  const path = [...step.sourcePath];
  for (const iteration of iterationPath) path.push("$iteration", iteration);
  return {
    ...state.run,
    key: `${workflowPathKey(step.sourcePath)}${iterationKey}`,
    sourcePath: [...step.sourcePath],
    iterationPath: [...iterationPath],
    path,
    kind: step.kind,
    ...(step.kind === "action" ? { action: step.action } : {}),
  };
};

const resolveLocalReference = (state: RuntimeState, scope: RuntimeVariableScope, reference: string): WorkflowValueResolution => {
  const segments = reference.split(".");
  const rootName = segments.shift() ?? "";
  let root: WorkflowJsonValue | undefined;
  if (rootName === "inputs") root = state.options.invocation.inputs;
  else if (rootName === "bindings") root = state.options.plan.bindings;
  else if (rootName === "context") root = state.options.invocation.context ?? {};
  else root = scope.get(rootName);
  const value = root === undefined || segments.length === 0 ? root : readWorkflowValuePath(root, segments);
  return value === undefined ? { state: "missing" } : { state: "resolved", value };
};

const resolveReference = async (
  state: RuntimeState,
  scope: RuntimeVariableScope,
  reference: string,
  path: Array<string | number> = [],
): Promise<WorkflowValueResolution> => {
  const local = () => resolveLocalReference(state, scope, reference);
  if (!state.options.values) return local();
  const resolved = await state.options.values.resolve({
    reference,
    path,
    plan: state.options.plan,
    invocation: state.options.invocation,
    variables: scope,
    fallback: () => {
      const fallback = local();
      return fallback.state === "resolved" ? fallback.value : undefined;
    },
  });
  return resolved;
};

const evaluateValue = async (
  state: RuntimeState,
  scope: RuntimeVariableScope,
  value: WorkflowJsonValue,
  path: Array<string | number> = [],
): Promise<WorkflowJsonValue> => {
  if (typeof value === "string") {
    const match = EXACT_EXPRESSION.exec(value);
    if (!match) return value;
    const expression = match[1]?.trim() ?? "";
    if (expression === "now()") return state.options.clock.now();
    const resolved = await resolveReference(state, scope, expression, path);
    if (resolved.state === "waiting") throw new WorkflowValueWaiting(expression, resolved.dependency);
    if (resolved.state === "missing") throw new WorkflowValueError(`workflow reference "${expression}" is unavailable`);
    return resolved.value;
  }
  if (Array.isArray(value)) {
    const evaluated: WorkflowJsonValue[] = [];
    for (const [index, item] of value.entries()) evaluated.push(await evaluateValue(state, scope, item, [...path, index]));
    return evaluated;
  }
  if (value !== null && typeof value === "object") {
    const evaluated: Record<string, WorkflowJsonValue> = {};
    for (const [key, item] of Object.entries(value)) evaluated[key] = await evaluateValue(state, scope, item, [...path, key]);
    return evaluated;
  }
  return value;
};

const jsonEqual = (left: WorkflowJsonValue, right: WorkflowJsonValue): boolean => {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => jsonEqual(item, right[index]!))
    );
  }
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index] && jsonEqual(left[key]!, right[key]!))
  );
};

const normalizeWorkflowText = (value: string): string => value.normalize("NFKC").toLowerCase();

const evaluateCondition = async (
  state: RuntimeState,
  scope: RuntimeVariableScope,
  condition: WorkflowCondition,
  path: Array<string | number>,
): Promise<boolean> => {
  if (condition.operator === "all") {
    let waiting: WorkflowValueWaiting | undefined;
    for (const [index, child] of condition.conditions.entries()) {
      try {
        if (!(await evaluateCondition(state, scope, child, [...path, "all", index]))) return false;
      } catch (error) {
        if (!(error instanceof WorkflowValueWaiting)) throw error;
        waiting ??= error;
      }
    }
    if (waiting) throw waiting;
    return true;
  }
  if (condition.operator === "any") {
    let waiting: WorkflowValueWaiting | undefined;
    for (const [index, child] of condition.conditions.entries()) {
      try {
        if (await evaluateCondition(state, scope, child, [...path, "any", index])) return true;
      } catch (error) {
        if (!(error instanceof WorkflowValueWaiting)) throw error;
        waiting ??= error;
      }
    }
    if (waiting) throw waiting;
    return false;
  }
  if (condition.operator === "not") return !(await evaluateCondition(state, scope, condition.condition, [...path, "not"]));
  if (condition.operator === "exists") {
    const resolved = await resolveReference(state, scope, condition.reference, [...path, "exists"]);
    if (resolved.state === "waiting") throw new WorkflowValueWaiting(condition.reference, resolved.dependency);
    return resolved.state === "resolved" && resolved.value !== null && resolved.value !== "";
  }
  const left = await evaluateValue(state, scope, condition.operands[0], [...path, condition.operator, 0]);
  const right = await evaluateValue(state, scope, condition.operands[1], [...path, condition.operator, 1]);
  if (condition.operator === "equals") return jsonEqual(left, right);
  if (condition.operator === "notEquals") return !jsonEqual(left, right);
  if (condition.operator === "includes") {
    if (!Array.isArray(left)) throw new WorkflowValueError("includes requires an array as its first operand");
    return left.some((item) => jsonEqual(item, right));
  }
  if (typeof left !== "string" || typeof right !== "string") {
    throw new WorkflowValueError(`${condition.operator} requires two text operands`);
  }
  const normalizedLeft = normalizeWorkflowText(left);
  const normalizedRight = normalizeWorkflowText(right);
  if (condition.operator === "textEquals") return normalizedLeft === normalizedRight;
  if (condition.operator === "contains") return normalizedLeft.includes(normalizedRight);
  if (condition.operator === "startsWith") return normalizedLeft.startsWith(normalizedRight);
  return normalizedLeft.endsWith(normalizedRight);
};

const traceCancellation = async (
  state: RuntimeState,
  cancellation: Extract<WorkflowHeartbeatOutcome, { state: "canceled" }>,
): Promise<void> => {
  if (state.cancellationTraced) return;
  state.cancellationTraced = true;
  await emit(state, { type: "run.canceled", run: state.run, ...optionalMessage(cancellation.message) });
};

const heartbeat = async (state: RuntimeState): Promise<Extract<WorkflowHeartbeatOutcome, { state: "canceled" }> | null> => {
  const outcome = await state.options.repository.heartbeat(state.run);
  if (outcome.state === "active") return null;
  if (outcome.state === "stale") throw new WorkflowLeaseLostError();
  await traceCancellation(state, outcome);
  return outcome;
};

const actionContext = (
  state: RuntimeState,
  scope: RuntimeVariableScope,
  step: WorkflowRuntimeStepIdentity,
): WorkflowExecuteActionContext | WorkflowDryRunActionContext => {
  const common = {
    run: state.run,
    step,
    plan: state.options.plan,
    invocation: state.options.invocation,
    variables: scope,
    evaluate: (value: WorkflowJsonValue, path?: Array<string | number>) => evaluateValue(state, scope, value, path ?? step.sourcePath),
    resolveReference: async (reference: string, path?: Array<string | number>) => {
      const resolved = await resolveReference(state, scope, reference, path ?? step.sourcePath);
      if (resolved.state === "waiting") throw new WorkflowValueWaiting(reference, resolved.dependency);
      return resolved.state === "resolved" ? resolved.value : undefined;
    },
    heartbeat: async () => {
      const cancellation = await heartbeat(state);
      if (cancellation) throw new WorkflowCancellation(cancellation);
    },
  };
  return state.options.mode === "execute"
    ? ({ ...common, mode: "execute" } as WorkflowExecuteActionContext)
    : ({ ...common, mode: "dryRun" } as WorkflowDryRunActionContext);
};

const invalidRestoration = (state: RuntimeState, step: WorkflowRuntimeStepIdentity, message: string): Flow =>
  state.options.mode === "execute"
    ? { state: "needs_attention", error: executionError("WORKFLOW_RESTORE_INVALID", message), step }
    : { state: "indeterminate", reason: message, step };

const persistedTraversalRecord = (kind: WorkflowControlTraversal["kind"], value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new WorkflowValueError(`completed ${kind} step has an invalid persisted control traversal`);
  }
  const traversal = value as Record<string, unknown>;
  if (traversal.kind !== kind) {
    throw new WorkflowValueError(`completed ${kind} step has a ${String(traversal.kind)} traversal`);
  }
  return traversal;
};

const persistedIfTraversal = (value: unknown): Extract<WorkflowControlTraversal, { kind: "if" }> => {
  const traversal = persistedTraversalRecord("if", value);
  if (!Array.isArray(traversal.branches) || traversal.branches.length === 0) {
    throw new WorkflowValueError("completed if step has invalid persisted traversal branches");
  }
  if (
    traversal.branches.length > 2 ||
    traversal.branches.some((branch) => branch !== "then" && branch !== "else") ||
    new Set(traversal.branches).size !== traversal.branches.length
  ) {
    throw new WorkflowValueError("completed if step has invalid persisted traversal branches");
  }
  return { kind: "if", branches: traversal.branches as Array<"then" | "else"> };
};

const persistedSwitchTraversal = (
  irStep: Extract<WorkflowIrStep, { kind: "switch" }>,
  value: unknown,
): Extract<WorkflowControlTraversal, { kind: "switch" }> => {
  const traversal = persistedTraversalRecord("switch", value);
  if (!Array.isArray(traversal.branches) || traversal.branches.length === 0) {
    throw new WorkflowValueError("completed switch step has invalid persisted traversal branches");
  }
  const branches = traversal.branches as unknown[];
  if (
    branches.length > irStep.cases.length + 1 ||
    branches.some(
      (branch) => branch !== "default" && (!Number.isSafeInteger(branch) || Number(branch) < 0 || Number(branch) >= irStep.cases.length),
    ) ||
    new Set(branches).size !== branches.length
  ) {
    throw new WorkflowValueError("completed switch step has invalid persisted traversal branches");
  }
  return { kind: "switch", branches: branches as Array<number | "default"> };
};

const persistedForEachTraversal = (value: unknown): Extract<WorkflowControlTraversal, { kind: "forEach" }> => {
  const traversal = persistedTraversalRecord("forEach", value);
  if (!Array.isArray(traversal.items)) {
    throw new WorkflowValueError("completed forEach step has invalid persisted traversal items");
  }
  return { kind: "forEach", items: traversal.items as WorkflowJsonValue[] };
};

const restoreCompletedSteps = async (
  state: RuntimeState,
  scope: RuntimeVariableScope,
  steps: WorkflowIrStep[],
  iterationPath: number[],
): Promise<Flow> => {
  for (const irStep of steps) {
    const step = stepIdentity(state, irStep, iterationPath);
    const restored = await state.options.repository.restoreStepOutcome(step);
    if (!restored) return invalidRestoration(state, step, `completed control step is missing descendant "${step.key}"`);
    const flow = await restoreStep(state, scope, irStep, step, restored, false);
    if (state.options.mode === "dryRun" && (flow.state === "unsupported" || flow.state === "indeterminate")) continue;
    if (flow.state !== "continue") return flow;
  }
  return { state: "continue" };
};

const restoreCompletedIfDescendants = async (
  state: RuntimeState,
  scope: RuntimeVariableScope,
  irStep: Extract<WorkflowIrStep, { kind: "if" }>,
  iterationPath: number[],
  persistedTraversal: unknown,
): Promise<Flow> => {
  const traversal = persistedIfTraversal(persistedTraversal);
  for (const branch of traversal.branches) {
    const flow = await restoreCompletedSteps(state, scope.child(), branch === "then" ? irStep.then : irStep.else, iterationPath);
    if (flow.state !== "continue") return flow;
  }
  return { state: "continue" };
};

const restoreCompletedSwitchDescendants = async (
  state: RuntimeState,
  scope: RuntimeVariableScope,
  irStep: Extract<WorkflowIrStep, { kind: "switch" }>,
  iterationPath: number[],
  persistedTraversal: unknown,
): Promise<Flow> => {
  const traversal = persistedSwitchTraversal(irStep, persistedTraversal);
  for (const branch of traversal.branches) {
    const steps = branch === "default" ? irStep.default : irStep.cases[branch]?.steps;
    if (!steps) throw new WorkflowValueError(`completed switch step references unavailable branch "${branch}"`);
    const flow = await restoreCompletedSteps(state, scope.child(), steps, iterationPath);
    if (flow.state !== "continue") return flow;
  }
  return { state: "continue" };
};

const restoreCompletedForEachDescendants = async (
  state: RuntimeState,
  scope: RuntimeVariableScope,
  irStep: Extract<WorkflowIrStep, { kind: "forEach" }>,
  iterationPath: number[],
  persistedTraversal: unknown,
): Promise<Flow> => {
  const traversal = persistedForEachTraversal(persistedTraversal);
  const limit = loopItemLimit(state);
  if (traversal.items.length > limit) {
    throw new WorkflowValueError(`completed forEach traversal has ${traversal.items.length} items; limit is ${limit}`);
  }
  for (let index = 0; index < traversal.items.length; index += 1) {
    const flow = await restoreCompletedSteps(state, scope.child({ [irStep.alias]: traversal.items[index]! }), irStep.steps, [
      ...iterationPath,
      index,
    ]);
    if (flow.state !== "continue") return flow;
  }
  return { state: "continue" };
};

const restoreCompletedControlDescendants = (
  state: RuntimeState,
  scope: RuntimeVariableScope,
  irStep: Exclude<WorkflowIrStep, { kind: "action" }>,
  iterationPath: number[],
  persistedTraversal: WorkflowControlTraversal | undefined,
): Promise<Flow> => {
  if (!persistedTraversal) {
    throw new WorkflowValueError(`completed ${irStep.kind} step is missing its persisted control traversal`);
  }
  if (irStep.kind === "if") return restoreCompletedIfDescendants(state, scope, irStep, iterationPath, persistedTraversal);
  if (irStep.kind === "switch") return restoreCompletedSwitchDescendants(state, scope, irStep, iterationPath, persistedTraversal);
  return restoreCompletedForEachDescendants(state, scope, irStep, iterationPath, persistedTraversal);
};

const restoreCompletedState = async (
  state: RuntimeState,
  scope: RuntimeVariableScope,
  irStep: WorkflowIrStep,
  step: WorkflowRuntimeStepIdentity,
  restored: WorkflowRestoredStep,
): Promise<Flow> => {
  if (irStep.kind !== "action") {
    if (restored.mode === "execute" && restored.outcome.state === "completed") {
      return restoreCompletedControlDescendants(state, scope, irStep, step.iterationPath, restored.outcome.control);
    }
    if (restored.mode === "dryRun" && restored.outcome.state === "planned") {
      return restoreCompletedControlDescendants(state, scope, irStep, step.iterationPath, restored.outcome.control);
    }
    return { state: "continue" };
  }
  if (restored.mode === "execute" && restored.outcome.state === "completed") {
    const handler = state.options.mode === "execute" ? state.options.actions.get(irStep.action) : undefined;
    if (!handler) return invalidRestoration(state, step, `action "${irStep.action}" is unavailable while restoring step "${step.key}"`);
    await handler.restoreCompleted?.(actionContext(state, scope, step) as WorkflowExecuteActionContext, irStep, restored.outcome);
  }
  if (restored.mode === "dryRun" && restored.outcome.state === "planned") {
    const handler = state.options.mode === "dryRun" ? state.options.actions.get(irStep.action) : undefined;
    if (!handler)
      return invalidRestoration(state, step, `planner for action "${irStep.action}" is unavailable while restoring step "${step.key}"`);
    await handler.restoreCompleted?.(actionContext(state, scope, step) as WorkflowDryRunActionContext, irStep, restored.outcome);
  }
  return { state: "continue" };
};

const restoreStep = async (
  state: RuntimeState,
  scope: RuntimeVariableScope,
  irStep: WorkflowIrStep,
  step: WorkflowRuntimeStepIdentity,
  restored: WorkflowRestoredStep,
  collectPlanningOutcome = true,
): Promise<Flow> => {
  if (restored.mode !== state.options.mode) {
    return invalidRestoration(state, step, `restored step "${step.key}" belongs to ${restored.mode}, not ${state.options.mode}`);
  }
  try {
    const descendants = await restoreCompletedState(state, scope, irStep, step, restored);
    if (descendants.state !== "continue") return descendants;
  } catch (error) {
    if (error instanceof WorkflowLeaseLostError) throw error;
    if (error instanceof WorkflowCancellation) {
      await traceCancellation(state, error.cancellation);
      return { state: "canceled", ...optionalMessage(error.cancellation.message), step };
    }
    return invalidRestoration(state, step, `restoring step "${step.key}" failed: ${errorMessage(error)}`);
  }
  if (
    collectPlanningOutcome &&
    restored.mode === "dryRun" &&
    (restored.outcome.state === "planned" || restored.outcome.state === "terminal")
  ) {
    state.effects.push(...restored.outcome.effects);
    state.issues.push(...restoredIssues(state, restored.outcome.issues));
  }
  await emit(state, { type: "step.restored", step, restored });
  const cancellation = await heartbeat(state);
  if (cancellation) return { state: "canceled", ...optionalMessage(cancellation.message), step };
  return restored.mode === "execute" ? flowFromExecutionOutcome(restored.outcome, step) : flowFromPlanningOutcome(restored.outcome, step);
};

const flowFromExecutionOutcome = (outcome: WorkflowStepOutcome, step: WorkflowRuntimeStepIdentity): Flow => {
  if (outcome.state === "completed") return { state: "continue", ...optionalOutput(outcome.output) };
  if (outcome.state === "waiting") return { state: "waiting", dependency: outcome.dependency, step };
  if (outcome.state === "failed") return { state: "failed", error: outcome.error, step };
  if (outcome.state === "needs_attention") return { state: "needs_attention", error: outcome.error, step };
  return outcome.status === "succeeded"
    ? { state: "terminal_succeeded", ...optionalMessage(outcome.message) }
    : { state: "canceled", ...optionalMessage(outcome.message), step };
};

const flowFromPlanningOutcome = (outcome: WorkflowPlanningOutcome, step: WorkflowRuntimeStepIdentity): Flow => {
  if (outcome.state === "planned") return { state: "continue", ...optionalOutput(outcome.output) };
  if (outcome.state === "terminal") {
    return { state: "terminal_planned", status: outcome.status, ...optionalMessage(outcome.message), step };
  }
  if (outcome.state === "canceled") return { state: "canceled", ...optionalMessage(outcome.message), step };
  return outcome.state === "unsupported"
    ? { state: "unsupported", reason: outcome.reason, step }
    : { state: "indeterminate", reason: outcome.reason, step };
};

const evaluateAction = async (
  state: RuntimeState,
  scope: RuntimeVariableScope,
  irStep: WorkflowActionStep,
  step: WorkflowRuntimeStepIdentity,
): Promise<StepEvaluation> => {
  const policy = state.options.plan.actionPolicies[irStep.action];
  if (!policy) {
    const message = `action "${irStep.action}" has no bound runtime policy`;
    if (state.options.mode === "execute") {
      const outcome: WorkflowStepOutcome = {
        state: "failed",
        error: executionError("WORKFLOW_ACTION_POLICY_MISSING", message),
      };
      return { flow: flowFromExecutionOutcome(outcome, step), result: { mode: "execute", outcome } };
    }
    const outcome: WorkflowPlanningOutcome = { state: "unsupported", reason: message };
    return { flow: flowFromPlanningOutcome(outcome, step), result: { mode: "dryRun", outcome } };
  }
  if (state.options.mode === "execute") {
    const handler = state.options.actions.get(irStep.action);
    const outcome: WorkflowStepOutcome = handler
      ? await handler.execute(actionContext(state, scope, step) as WorkflowExecuteActionContext, irStep)
      : {
          state: "failed",
          error: executionError("WORKFLOW_ACTION_UNSUPPORTED", `action "${irStep.action}" has no execute handler`),
        };
    return { flow: flowFromExecutionOutcome(outcome, step), result: { mode: "execute", outcome } };
  }
  if (policy.dryRun === "unsupported") {
    const outcome: WorkflowPlanningOutcome = {
      state: "unsupported",
      reason: `action "${irStep.action}" does not support dry-run`,
    };
    return { flow: flowFromPlanningOutcome(outcome, step), result: { mode: "dryRun", outcome } };
  }
  const handler = state.options.actions.get(irStep.action);
  const outcome: WorkflowPlanningOutcome = handler
    ? await handler.plan(actionContext(state, scope, step) as WorkflowDryRunActionContext, irStep)
    : { state: "unsupported", reason: `action "${irStep.action}" has no dry-run handler` };
  if (outcome.state === "planned" || outcome.state === "terminal") {
    state.effects.push(...outcome.effects);
    state.issues.push(...restoredIssues(state, outcome.issues));
  }
  return { flow: flowFromPlanningOutcome(outcome, step), result: { mode: "dryRun", outcome } };
};

const resultForCompletedControl = (
  state: RuntimeState,
  output: WorkflowJsonValue | undefined,
  control: WorkflowControlTraversal,
  effectsStart: number,
  issuesStart: number,
): WorkflowRuntimeStepResult =>
  state.options.mode === "execute"
    ? { mode: "execute", outcome: { state: "completed", ...optionalOutput(output), control } }
    : {
        mode: "dryRun",
        outcome: {
          state: "planned",
          ...optionalOutput(output),
          control,
          effects: state.effects.slice(effectsStart),
          issues: storedIssues(state.issues.slice(issuesStart)),
        },
      };

const resultForHaltedControl = (state: RuntimeState, flow: Halt, effectsStart: number, issuesStart: number): WorkflowRuntimeStepResult => {
  if (state.options.mode === "execute") {
    if (flow.state === "waiting") return { mode: "execute", outcome: { state: "waiting", dependency: flow.dependency } };
    if (flow.state === "failed") return { mode: "execute", outcome: { state: "failed", error: flow.error } };
    if (flow.state === "needs_attention") return { mode: "execute", outcome: { state: "needs_attention", error: flow.error } };
    if (flow.state === "canceled") {
      return { mode: "execute", outcome: { state: "terminal", status: "canceled", ...optionalMessage(flow.message) } };
    }
    if (flow.state === "terminal_succeeded") {
      return { mode: "execute", outcome: { state: "terminal", status: "succeeded", ...optionalMessage(flow.message) } };
    }
    return {
      mode: "execute",
      outcome: {
        state: "failed",
        error: executionError(
          "WORKFLOW_RUNTIME_INVALID",
          flow.state === "terminal_planned" ? "execute traversal produced a dry-run terminal outcome" : flow.reason,
        ),
      },
    };
  }

  if (flow.state === "terminal_planned") {
    return {
      mode: "dryRun",
      outcome: {
        state: "terminal",
        status: flow.status,
        ...optionalMessage(flow.message),
        effects: state.effects.slice(effectsStart),
        issues: storedIssues(state.issues.slice(issuesStart)),
      },
    };
  }
  if (flow.state === "unsupported" || flow.state === "indeterminate") {
    return { mode: "dryRun", outcome: { state: flow.state, reason: flow.reason } };
  }
  if (flow.state === "canceled") {
    return { mode: "dryRun", outcome: { state: "canceled", ...optionalMessage(flow.message) } };
  }
  return { mode: "dryRun", outcome: { state: "indeterminate", reason: `dry-run traversal produced ${flow.state}` } };
};

const loopItemLimit = (state: RuntimeState): number => {
  const limits = [state.options.plan.maxLoopItems, state.options.maxLoopItems].filter((value): value is number => value !== undefined);
  for (const limit of limits) {
    if (!Number.isSafeInteger(limit) || limit < 0) throw new WorkflowValueError("maxLoopItems must be a non-negative safe integer");
  }
  return limits.length > 0 ? Math.min(...limits) : DEFAULT_MAX_LOOP_ITEMS;
};

const analyzeUnknownBranches = async (
  state: RuntimeState,
  scope: RuntimeVariableScope,
  irStep: Extract<WorkflowIrStep, { kind: "if" | "switch" }>,
  iterationPath: number[],
  reason: string,
): Promise<Flow> => {
  state.issues.push({ state: "indeterminate", reason, step: stepIdentity(state, irStep, iterationPath) });
  const branches =
    irStep.kind === "if" ? [irStep.then, irStep.else] : [...irStep.cases.map((candidate) => candidate.steps), irStep.default];
  for (const branch of branches) {
    const flow = await runSteps(state, branch, scope.child(), iterationPath);
    if (flow.state === "canceled") return flow;
  }
  return { state: "continue" };
};

const evaluateControl = async (
  state: RuntimeState,
  scope: RuntimeVariableScope,
  irStep: Exclude<WorkflowIrStep, { kind: "action" }>,
  iterationPath: number[],
): Promise<StepEvaluation> => {
  const effectsStart = state.effects.length;
  const issuesStart = state.issues.length;
  let control: WorkflowControlTraversal;
  let flow: Flow;
  if (irStep.kind === "if") {
    try {
      const matched = await evaluateCondition(state, scope, irStep.condition, [...irStep.sourcePath, "if"]);
      control = { kind: "if", branches: [matched ? "then" : "else"] };
      flow = await runSteps(state, matched ? irStep.then : irStep.else, scope.child(), iterationPath);
    } catch (error) {
      if (state.options.mode !== "dryRun") throw error;
      control = { kind: "if", branches: ["then", "else"] };
      flow = await analyzeUnknownBranches(state, scope, irStep, iterationPath, errorMessage(error));
    }
  } else if (irStep.kind === "switch") {
    try {
      const value = await evaluateValue(state, scope, irStep.value, [...irStep.sourcePath, "switch"]);
      let matched: (typeof irStep.cases)[number] | undefined;
      for (const [index, candidate] of irStep.cases.entries()) {
        if (jsonEqual(value, await evaluateValue(state, scope, candidate.when, [...irStep.sourcePath, "cases", index, "when"]))) {
          matched = candidate;
          break;
        }
      }
      control = { kind: "switch", branches: [matched ? irStep.cases.indexOf(matched) : "default"] };
      flow = await runSteps(state, matched?.steps ?? irStep.default, scope.child(), iterationPath);
    } catch (error) {
      if (state.options.mode !== "dryRun") throw error;
      control = { kind: "switch", branches: [...irStep.cases.map((_, index) => index), "default"] };
      flow = await analyzeUnknownBranches(state, scope, irStep, iterationPath, errorMessage(error));
    }
  } else {
    const resolved = await resolveReference(state, scope, irStep.reference, [...irStep.sourcePath, "forEach"]);
    if (resolved.state === "waiting" && state.options.mode !== "dryRun") {
      throw new WorkflowValueWaiting(irStep.reference, resolved.dependency);
    }
    const value = resolved.state === "resolved" ? resolved.value : undefined;
    if (!Array.isArray(value)) {
      const reason =
        resolved.state === "waiting"
          ? `forEach reference "${irStep.reference}" is waiting`
          : `forEach reference "${irStep.reference}" must resolve to a JSON array`;
      if (state.options.mode !== "dryRun") throw new WorkflowValueError(reason);
      state.issues.push({ state: "indeterminate", reason, step: stepIdentity(state, irStep, iterationPath) });
      control = { kind: "forEach", items: [null] };
      flow = await runSteps(state, irStep.steps, scope.child({ [irStep.alias]: null }), [...iterationPath, 0]);
      if (flow.state === "canceled") {
        return { flow, result: resultForHaltedControl(state, flow, effectsStart, issuesStart) };
      }
      flow = { state: "continue" };
      return { flow, result: resultForCompletedControl(state, undefined, control, effectsStart, issuesStart) };
    }
    const limit = loopItemLimit(state);
    if (value.length > limit)
      throw new WorkflowValueError(`forEach reference "${irStep.reference}" has ${value.length} items; limit is ${limit}`);
    control = { kind: "forEach", items: value };
    flow = { state: "continue" };
    for (let index = 0; index < value.length; index += 1) {
      const cancellation = await heartbeat(state);
      if (cancellation) {
        const flow = { state: "canceled", ...optionalMessage(cancellation.message) } as const;
        return { flow, result: resultForHaltedControl(state, flow, effectsStart, issuesStart) };
      }
      flow = await runSteps(state, irStep.steps, scope.child({ [irStep.alias]: value[index]! }), [...iterationPath, index]);
      if (flow.state !== "continue") break;
    }
  }
  return flow.state === "continue"
    ? { flow, result: resultForCompletedControl(state, flow.output, control, effectsStart, issuesStart) }
    : { flow, result: resultForHaltedControl(state, flow, effectsStart, issuesStart) };
};

const evaluateStep = async (
  state: RuntimeState,
  scope: RuntimeVariableScope,
  irStep: WorkflowIrStep,
  step: WorkflowRuntimeStepIdentity,
  iterationPath: number[],
): Promise<StepEvaluation> => {
  try {
    return irStep.kind === "action"
      ? await evaluateAction(state, scope, irStep, step)
      : await evaluateControl(state, scope, irStep, iterationPath);
  } catch (error) {
    if (error instanceof WorkflowRetryableStepError) throw error;
    if (error instanceof WorkflowLeaseLostError) throw error;
    if (error instanceof WorkflowCancellation) {
      await traceCancellation(state, error.cancellation);
      const flow = { state: "canceled", ...optionalMessage(error.cancellation.message), step } as const;
      return {
        flow,
        result:
          state.options.mode === "execute"
            ? {
                mode: "execute",
                outcome: { state: "terminal", status: "canceled", ...optionalMessage(error.cancellation.message) },
              }
            : { mode: "dryRun", outcome: { state: "canceled", ...optionalMessage(error.cancellation.message) } },
      };
    }
    if (error instanceof WorkflowValueWaiting) {
      if (state.options.mode === "execute") {
        const outcome: WorkflowStepOutcome = { state: "waiting", dependency: error.dependency };
        return { flow: { state: "waiting", dependency: error.dependency, step }, result: { mode: "execute", outcome } };
      }
      const outcome: WorkflowPlanningOutcome = { state: "indeterminate", reason: error.message };
      return { flow: { state: "indeterminate", reason: outcome.reason, step }, result: { mode: "dryRun", outcome } };
    }
    if (state.options.mode === "dryRun") {
      const outcome: WorkflowPlanningOutcome = { state: "indeterminate", reason: errorMessage(error) };
      return { flow: { state: "indeterminate", reason: outcome.reason, step }, result: { mode: "dryRun", outcome } };
    }
    const outcome: WorkflowStepOutcome = {
      state: "failed",
      error: executionError(error instanceof WorkflowValueError ? error.code : "WORKFLOW_ACTION_ERROR", errorMessage(error), false),
    };
    return { flow: { state: "failed", error: outcome.error, step }, result: { mode: "execute", outcome } };
  }
};

const runStep = async (
  state: RuntimeState,
  scope: RuntimeVariableScope,
  irStep: WorkflowIrStep,
  iterationPath: number[],
): Promise<Flow> => {
  const step = stepIdentity(state, irStep, iterationPath);
  const cancellation = await heartbeat(state);
  if (cancellation) return { state: "canceled", ...optionalMessage(cancellation.message), step };
  const restored = await state.options.repository.restoreStepOutcome(step);
  if (restored) return restoreStep(state, scope, irStep, step, restored);

  await state.options.repository.startStep(step);
  await emit(state, { type: "step.started", step });
  const evaluated = await evaluateStep(state, scope, irStep, step, iterationPath);
  if (
    evaluated.result?.mode === "execute" &&
    evaluated.result.outcome.state === "failed" &&
    evaluated.result.outcome.error.retryable &&
    evaluated.flow.state === "failed" &&
    evaluated.flow.step.key === step.key
  ) {
    throw new WorkflowRetryableStepError(step, evaluated.result.outcome.error);
  }
  const waitingForDependency =
    evaluated.result?.mode === "execute" && evaluated.result.outcome.state === "waiting" && evaluated.flow.state === "waiting";
  // A control step only propagates the leaf's attention result. Journaling the
  // control as settled would make resolution restore the wrapper and stop at
  // the same attention state forever.
  const propagatedAttention =
    irStep.kind !== "action" &&
    evaluated.result?.mode === "execute" &&
    evaluated.result.outcome.state === "needs_attention" &&
    evaluated.flow.state === "needs_attention";
  if (evaluated.result && !waitingForDependency && !propagatedAttention) {
    await state.options.repository.finishStep(step, evaluated.result);
    await emit(state, { type: "step.finished", step, result: evaluated.result });
  }
  if (evaluated.flow.state !== "continue") return evaluated.flow;
  const after = await heartbeat(state);
  return after ? { state: "canceled", ...optionalMessage(after.message), step } : evaluated.flow;
};

const runSteps = async (
  state: RuntimeState,
  steps: WorkflowIrStep[],
  scope: RuntimeVariableScope,
  iterationPath: number[],
): Promise<Flow> => {
  let last: WorkflowJsonValue | undefined;
  for (const step of steps) {
    const flow = await runStep(state, scope, step, iterationPath);
    if (state.options.mode === "dryRun" && (flow.state === "unsupported" || flow.state === "indeterminate")) {
      state.issues.push({ state: flow.state, reason: flow.reason, step: flow.step });
      last = undefined;
      continue;
    }
    if (flow.state !== "continue") return flow;
    last = flow.output;
  }
  return { state: "continue", ...optionalOutput(last) };
};

const createState = (options: RuntimeOptions): RuntimeState => ({
  options,
  run: {
    runId: options.runId,
    executionGeneration: options.executionGeneration,
    mode: options.mode,
    workflowId: options.invocation.workflowId,
    sourceHash: options.plan.sourceHash,
    idempotencyKey: options.invocation.idempotencyKey,
  },
  effects: [],
  issues: [],
  cancellationTraced: false,
});

export const executeWorkflowPlan = async (options: WorkflowExecuteOptions): Promise<WorkflowExecutionResult> => {
  const state = createState({ ...options, mode: "execute" });
  const flow = await runSteps(state, state.options.plan.steps, new RuntimeVariableScope(options.initialVariables), []);
  if (flow.state === "waiting") {
    const result = { mode: "execute", outcome: { state: "waiting", dependency: flow.dependency } } as const;
    await state.options.repository.parkStep(flow.step, flow.dependency);
    await emit(state, { type: "step.waiting", step: flow.step, dependency: flow.dependency });
    await emit(state, { type: "step.finished", step: flow.step, result });
    return flow;
  }
  if (flow.state === "continue") return { state: "succeeded", ...optionalOutput(flow.output) };
  if (flow.state === "terminal_succeeded") return { state: "succeeded", ...optionalMessage(flow.message) };
  if (flow.state === "unsupported" || flow.state === "indeterminate" || flow.state === "terminal_planned") {
    return {
      state: "failed",
      error: executionError(
        "WORKFLOW_RUNTIME_INVALID",
        flow.state === "terminal_planned" ? "execute traversal produced a dry-run terminal outcome" : flow.reason,
      ),
      step: flow.step,
    };
  }
  return flow;
};

export const dryRunWorkflowPlan = async (options: WorkflowDryRunOptions): Promise<WorkflowDryRunResult> => {
  const state = createState({ ...options, mode: "dryRun" });
  const flow = await runSteps(state, state.options.plan.steps, new RuntimeVariableScope(options.initialVariables), []);
  const issues = state.issues;
  const optionalIssues = issues.length > 0 ? { issues } : {};
  if (flow.state === "continue") {
    if (issues.length === 0) return { state: "planned", ...optionalOutput(flow.output), effects: state.effects };
    const stateName = issues.some((issue) => issue.state === "indeterminate") ? "indeterminate" : "unsupported";
    const primary = issues.find((issue) => issue.state === stateName) ?? issues[0]!;
    return { state: stateName, reason: primary.reason, effects: state.effects, step: primary.step, issues };
  }
  if (flow.state === "terminal_planned") {
    return { state: "terminal", status: flow.status, ...optionalMessage(flow.message), effects: state.effects, ...optionalIssues };
  }
  if (flow.state === "unsupported" || flow.state === "indeterminate") {
    const issue = { state: flow.state, reason: flow.reason, step: flow.step };
    return { state: flow.state, reason: flow.reason, effects: state.effects, step: flow.step, issues: [...issues, issue] };
  }
  if (flow.state === "canceled") {
    return {
      state: "canceled",
      ...optionalMessage(flow.message),
      effects: state.effects,
      ...(flow.step ? { step: flow.step } : {}),
      ...optionalIssues,
    };
  }
  const step = "step" in flow && flow.step ? flow.step : stepIdentity(state, state.options.plan.steps[0] ?? emptyActionStep, []);
  const issue = { state: "indeterminate", reason: `dry-run traversal produced ${flow.state}`, step } as const;
  return { state: "indeterminate", reason: issue.reason, effects: state.effects, step, issues: [...issues, issue] };
};

const emptyActionStep: WorkflowActionStep = { kind: "action", action: "<workflow>", config: {}, sourcePath: ["steps"] };
