import type {
  WorkflowActionDescriptor,
  WorkflowCondition,
  WorkflowDiagnostic,
  WorkflowInputDescriptor,
  WorkflowIr,
  WorkflowIrInput,
  WorkflowIrStep,
  WorkflowIrTrigger,
  WorkflowJsonValue,
  WorkflowLanguageManifest,
  WorkflowSourceLocation,
  WorkflowTriggerDescriptor,
} from "../contracts";
import type { DefinedWorkflowModule } from "../module";
import { hashWorkflowJson, hashWorkflowSource, normalizeWorkflowJson } from "./canonical";
import { parseWorkflowValueString } from "./expressions";
import { validateWorkflowField, workflowDiagnostic, workflowRecord } from "./schema";
import { parseWorkflowYaml } from "./strict-yaml";

export type CompileWorkflowResult = { ok: true; ir: WorkflowIr } | { ok: false; diagnostics: WorkflowDiagnostic[] };

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED_ACTIONS = new Set(["if", "switch", "forEach"]);
const hasOwn = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);

type CompileContext = {
  manifest: WorkflowLanguageManifest;
  locations: Record<string, WorkflowSourceLocation>;
  diagnostics: WorkflowDiagnostic[];
  actions: Map<string, WorkflowActionDescriptor>;
  stepCount: number;
  stepLimitReported: boolean;
  conditionCount: number;
  conditionLimitReported: boolean;
};

const addDiagnostic = (context: CompileContext, code: string, message: string, path: Array<string | number>): void => {
  context.diagnostics.push(workflowDiagnostic(code, message, path, context.locations));
};

const validateExactKeys = (
  value: Record<string, WorkflowJsonValue>,
  allowed: readonly string[],
  path: Array<string | number>,
  context: CompileContext,
): void => {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) addDiagnostic(context, "schema.unknown", `Unknown property "${key}"`, [...path, key]);
  }
};

const descriptorMap = <T extends { kind: string }>(
  descriptors: T[],
  section: string,
  diagnostics: WorkflowDiagnostic[],
): Map<string, T> => {
  const result = new Map<string, T>();
  for (const descriptor of descriptors) {
    if (result.has(descriptor.kind)) {
      diagnostics.push({
        code: "manifest.duplicate",
        message: `Duplicate ${section} descriptor "${descriptor.kind}"`,
        severity: "error",
        path: [],
      });
    } else {
      result.set(descriptor.kind, descriptor);
    }
  }
  return result;
};

const validateManifest = (manifest: WorkflowLanguageManifest, diagnostics: WorkflowDiagnostic[]): void => {
  if (manifest.id.trim().length === 0)
    diagnostics.push({ code: "manifest.id", message: "Manifest id must not be empty", severity: "error", path: [] });
  if (!Number.isInteger(manifest.version) || manifest.version < 1)
    diagnostics.push({ code: "manifest.version", message: "Manifest version must be a positive integer", severity: "error", path: [] });
  for (const [name, value] of Object.entries(manifest.limits ?? {})) {
    if (!Number.isInteger(value) || value! < 1) {
      diagnostics.push({
        code: "manifest.limit",
        message: `Manifest limit "${name}" must be a positive integer`,
        severity: "error",
        path: [],
      });
    }
  }
  for (const action of manifest.actions) {
    if (RESERVED_ACTIONS.has(action.kind)) {
      diagnostics.push({
        code: "manifest.reserved",
        message: `Action descriptor "${action.kind}" uses a reserved control-flow name`,
        severity: "error",
        path: [],
      });
    }
  }
};

const compileInputs = (
  value: WorkflowJsonValue | undefined,
  descriptors: Map<string, WorkflowInputDescriptor>,
  context: CompileContext,
): WorkflowIrInput[] => {
  if (value === undefined) return [];
  if (!workflowRecord(value)) {
    addDiagnostic(context, "schema.type", "Expected inputs to be an object", ["inputs"]);
    return [];
  }
  const names = Object.keys(value).sort();
  const maxInputs = context.manifest.limits?.maxInputs;
  if (maxInputs !== undefined && names.length > maxInputs)
    addDiagnostic(context, "limit.inputs", `Workflow defines more than ${maxInputs} inputs`, ["inputs"]);

  const inputs: WorkflowIrInput[] = [];
  for (const name of names) {
    const path = ["inputs", name] as Array<string | number>;
    if (!IDENTIFIER.test(name)) addDiagnostic(context, "input.name", `Input name "${name}" must be an identifier`, path);
    const definition = value[name];
    if (!workflowRecord(definition)) {
      addDiagnostic(context, "schema.type", "Expected input definition to be an object", path);
      continue;
    }
    const type = definition.type;
    if (typeof type !== "string") {
      addDiagnostic(context, "schema.required", "Input requires a string type", [...path, "type"]);
      continue;
    }
    const descriptor = descriptors.get(type);
    if (!descriptor) {
      addDiagnostic(context, "input.unknown", `Unknown input type "${type}"`, [...path, "type"]);
      continue;
    }
    const config = Object.fromEntries(Object.entries(definition).filter(([key]) => key !== "type")) as Record<string, WorkflowJsonValue>;
    validateWorkflowField(config, descriptor.config, path, context.locations, context.diagnostics);
    inputs.push({ name, type, config: normalizeWorkflowJson(config) });
  }
  return inputs;
};

const compileTriggers = (
  value: WorkflowJsonValue | undefined,
  descriptors: Map<string, WorkflowTriggerDescriptor>,
  inputNames: Set<string>,
  context: CompileContext,
): WorkflowIrTrigger[] => {
  if (value === undefined) return [];
  if (!workflowRecord(value)) {
    addDiagnostic(context, "schema.type", "Expected triggers to be an object", ["triggers"]);
    return [];
  }
  const kinds = Object.keys(value).sort();
  if (kinds.length === 0) {
    addDiagnostic(context, "trigger.empty", "Omit triggers for a direct-only workflow; an empty triggers object is invalid", ["triggers"]);
    return [];
  }

  const triggers: WorkflowIrTrigger[] = [];
  for (const kind of kinds) {
    const path = ["triggers", kind] as Array<string | number>;
    const descriptor = descriptors.get(kind);
    if (!descriptor) {
      addDiagnostic(context, "trigger.unknown", `Unknown trigger "${kind}"`, path);
      continue;
    }
    const definition = value[kind];
    if (!workflowRecord(definition)) {
      addDiagnostic(context, "schema.type", "Expected trigger definition to be an object", path);
      continue;
    }
    const withValue = definition.with;
    const withBindings = withValue === undefined ? {} : withValue;
    if (!workflowRecord(withBindings)) {
      addDiagnostic(context, "schema.type", "Expected trigger with bindings to be an object", [...path, "with"]);
      continue;
    }
    for (const inputName of Object.keys(withBindings)) {
      if (!inputNames.has(inputName))
        addDiagnostic(context, "trigger.input", `Trigger binds unknown input "${inputName}"`, [...path, "with", inputName]);
    }
    const config = Object.fromEntries(Object.entries(definition).filter(([key]) => key !== "with")) as Record<string, WorkflowJsonValue>;
    validateWorkflowField(config, descriptor.config, path, context.locations, context.diagnostics);
    triggers.push({ kind, config: normalizeWorkflowJson(config), with: normalizeWorkflowJson(withBindings) });
  }
  return triggers;
};

const compileCondition = (
  value: WorkflowJsonValue | undefined,
  path: Array<string | number>,
  depth: number,
  context: CompileContext,
): WorkflowCondition | undefined => {
  context.conditionCount += 1;
  const maxConditions = context.manifest.limits?.maxConditions;
  if (maxConditions !== undefined && context.conditionCount > maxConditions) {
    if (!context.conditionLimitReported) {
      addDiagnostic(context, "limit.conditions", `Workflow defines more than ${maxConditions} conditions`, path);
      context.conditionLimitReported = true;
    }
    return undefined;
  }
  const maxDepth = context.manifest.limits?.maxConditionDepth;
  if (maxDepth !== undefined && depth > maxDepth) {
    addDiagnostic(context, "limit.conditionDepth", `Workflow condition depth exceeds ${maxDepth}`, path);
    return undefined;
  }
  if (!workflowRecord(value)) {
    addDiagnostic(context, "condition.type", "Condition must be an object", path);
    return undefined;
  }
  const operators = Object.keys(value);
  if (
    operators.length !== 1 ||
    ![
      "equals",
      "notEquals",
      "includes",
      "textEquals",
      "contains",
      "startsWith",
      "endsWith",
      "greaterThan",
      "lessThan",
      "atLeast",
      "atMost",
      "exists",
      "all",
      "any",
      "not",
    ].includes(operators[0]!)
  ) {
    addDiagnostic(context, "condition.operator", "Condition must contain exactly one supported operator", path);
    return undefined;
  }
  const operator = operators[0]!;
  const operand = value[operator];
  if (operator === "all" || operator === "any") {
    if (!Array.isArray(operand) || operand.length === 0) {
      addDiagnostic(context, "condition.conditions", `${operator} requires at least one condition`, [...path, operator]);
      return undefined;
    }
    const conditions = operand
      .map((condition, index) => compileCondition(condition, [...path, operator, index], depth + 1, context))
      .filter((condition): condition is WorkflowCondition => condition !== undefined);
    if (conditions.length !== operand.length) return undefined;
    return operator === "all" ? { operator: "all", conditions } : { operator: "any", conditions };
  }
  if (operator === "not") {
    const condition = compileCondition(operand, [...path, operator], depth + 1, context);
    return condition ? { operator, condition } : undefined;
  }
  if (operator === "exists") {
    if (typeof operand !== "string" || operand.length === 0) {
      addDiagnostic(context, "condition.exists", "exists requires a non-empty reference", [...path, operator]);
      return undefined;
    }
    return { operator: "exists", reference: operand };
  }
  if (!Array.isArray(operand) || operand.length !== 2) {
    addDiagnostic(context, "condition.operands", `${operator} requires exactly two operands`, [...path, operator]);
    return undefined;
  }
  if (operator === "greaterThan" || operator === "lessThan" || operator === "atLeast" || operator === "atMost") {
    operand.forEach((value, index) => {
      const expression = typeof value === "string" ? parseWorkflowValueString(value) : undefined;
      if (
        (typeof value !== "number" || !Number.isFinite(value)) &&
        (expression?.kind !== "expression" || expression.expression.kind !== "reference")
      ) {
        addDiagnostic(context, "condition.type", `${operator} operand ${index + 1} must be a finite number or reference`, [
          ...path,
          operator,
          index,
        ]);
      }
    });
    return { operator, operands: [normalizeWorkflowJson(operand[0]!), normalizeWorkflowJson(operand[1]!)] };
  }
  return {
    operator: operator as "equals" | "notEquals" | "includes" | "textEquals" | "contains" | "startsWith" | "endsWith",
    operands: [normalizeWorkflowJson(operand[0]!), normalizeWorkflowJson(operand[1]!)],
  };
};

const compileSteps = (
  value: WorkflowJsonValue | undefined,
  path: Array<string | number>,
  depth: number,
  context: CompileContext,
): WorkflowIrStep[] => {
  if (!Array.isArray(value) || value.length === 0) {
    addDiagnostic(context, "steps.type", "Expected at least one workflow step", path);
    return [];
  }

  const result: WorkflowIrStep[] = [];
  value.forEach((step, index) => {
    const stepPath = [...path, index];
    context.stepCount += 1;
    const maxSteps = context.manifest.limits?.maxSteps;
    if (maxSteps !== undefined && context.stepCount > maxSteps && !context.stepLimitReported) {
      addDiagnostic(context, "limit.steps", `Workflow defines more than ${maxSteps} steps`, stepPath);
      context.stepLimitReported = true;
    }
    const maxDepth = context.manifest.limits?.maxDepth;
    if (maxDepth !== undefined && depth > maxDepth)
      addDiagnostic(context, "limit.depth", `Workflow control-flow depth exceeds ${maxDepth}`, stepPath);

    if (!workflowRecord(step)) {
      addDiagnostic(context, "step.type", "Workflow step must be an object", stepPath);
      return;
    }
    if (hasOwn(step, "if")) {
      validateExactKeys(step, ["if", "then", "else"], stepPath, context);
      const condition = compileCondition(step.if, [...stepPath, "if"], 1, context);
      const thenSteps = compileSteps(step.then, [...stepPath, "then"], depth + 1, context);
      const elseSteps = step.else === undefined ? [] : compileSteps(step.else, [...stepPath, "else"], depth + 1, context);
      if (condition) result.push({ kind: "if", condition, then: thenSteps, else: elseSteps, sourcePath: stepPath });
      return;
    }
    if (hasOwn(step, "switch")) {
      validateExactKeys(step, ["switch", "cases", "default"], stepPath, context);
      if (!Array.isArray(step.cases) || step.cases.length === 0) {
        addDiagnostic(context, "switch.cases", "switch cases must be a non-empty list of { when, do } entries", [...stepPath, "cases"]);
        return;
      }
      const cases: Array<{ when: WorkflowJsonValue; steps: WorkflowIrStep[] }> = [];
      step.cases.forEach((caseValue, caseIndex) => {
        const casePath = [...stepPath, "cases", caseIndex];
        if (!workflowRecord(caseValue)) {
          addDiagnostic(context, "switch.case", "Switch case must be an object", casePath);
          return;
        }
        validateExactKeys(caseValue, ["when", "do"], casePath, context);
        if (!hasOwn(caseValue, "when")) {
          addDiagnostic(context, "schema.required", "Switch case requires when", [...casePath, "when"]);
          return;
        }
        cases.push({
          when: normalizeWorkflowJson(caseValue.when!),
          steps: compileSteps(caseValue.do, [...casePath, "do"], depth + 1, context),
        });
      });
      const defaultSteps = step.default === undefined ? [] : compileSteps(step.default, [...stepPath, "default"], depth + 1, context);
      result.push({ kind: "switch", value: normalizeWorkflowJson(step.switch!), cases, default: defaultSteps, sourcePath: stepPath });
      return;
    }
    if (hasOwn(step, "forEach")) {
      validateExactKeys(step, ["forEach", "as", "do"], stepPath, context);
      if (typeof step.forEach !== "string" || step.forEach.length === 0)
        addDiagnostic(context, "forEach.reference", "forEach requires a non-empty reference", [...stepPath, "forEach"]);
      if (typeof step.as !== "string" || !IDENTIFIER.test(step.as))
        addDiagnostic(context, "forEach.alias", "forEach alias must be an identifier", [...stepPath, "as"]);
      const steps = compileSteps(step.do, [...stepPath, "do"], depth + 1, context);
      if (typeof step.forEach === "string" && step.forEach.length > 0 && typeof step.as === "string" && IDENTIFIER.test(step.as))
        result.push({ kind: "forEach", reference: step.forEach, alias: step.as, steps, sourcePath: stepPath });
      return;
    }

    const keys = Object.keys(step);
    if (keys.length !== 1) {
      addDiagnostic(context, "step.shape", "Action step must contain exactly one action", stepPath);
      return;
    }
    const action = keys[0]!;
    const descriptor = context.actions.get(action);
    if (!descriptor) {
      addDiagnostic(context, "action.unknown", `Unknown action "${action}"`, [...stepPath, action]);
      return;
    }
    const config = step[action];
    if (!workflowRecord(config)) {
      addDiagnostic(context, "schema.type", "Action configuration must be an object", [...stepPath, action]);
      return;
    }
    validateWorkflowField(config, descriptor.config, [...stepPath, action], context.locations, context.diagnostics);
    result.push({ kind: "action", action, config: normalizeWorkflowJson(config), sourcePath: stepPath });
  });
  return result;
};

export const compileWorkflow = async (source: string, workflows: DefinedWorkflowModule): Promise<CompileWorkflowResult> => {
  const manifest = workflows.manifest;
  const parsed = parseWorkflowYaml(source);
  if (!parsed.ok) return { ok: false, diagnostics: parsed.diagnostics };

  const diagnostics: WorkflowDiagnostic[] = [];
  validateManifest(manifest, diagnostics);
  const inputs = descriptorMap(manifest.inputs, "input", diagnostics);
  const triggers = descriptorMap(manifest.triggers, "trigger", diagnostics);
  const actions = descriptorMap(manifest.actions, "action", diagnostics);
  const context: CompileContext = {
    manifest,
    locations: parsed.parsed.sourceLocations,
    diagnostics,
    actions,
    stepCount: 0,
    stepLimitReported: false,
    conditionCount: 0,
    conditionLimitReported: false,
  };
  const root = parsed.parsed.value as Record<string, WorkflowJsonValue>;
  validateExactKeys(root, ["inputs", "triggers", "steps"], [], context);
  const compiledInputs = compileInputs(root.inputs, inputs, context);
  const compiledTriggers = compileTriggers(root.triggers, triggers, new Set(compiledInputs.map((input) => input.name)), context);
  const compiledSteps = compileSteps(root.steps, ["steps"], 1, context);
  if (diagnostics.length > 0) return { ok: false, diagnostics };

  const [sourceHash, manifestHash] = await Promise.all([hashWorkflowSource(source), hashWorkflowJson(manifest)]);

  return {
    ok: true,
    ir: {
      schemaVersion: 1,
      languageId: manifest.id,
      languageVersion: manifest.version,
      sourceHash,
      manifestHash,
      inputs: compiledInputs,
      triggers: compiledTriggers,
      steps: compiledSteps,
      sourceLocations: parsed.parsed.sourceLocations,
    },
  };
};
