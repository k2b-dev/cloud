export type WorkflowJsonPrimitive = string | number | boolean | null;
export type WorkflowJsonValue = WorkflowJsonPrimitive | WorkflowJsonValue[] | { [key: string]: WorkflowJsonValue };
export type WorkflowRevision = string;

export type WorkflowSourceLocation = {
  offset: number;
  line: number;
  column: number;
};

export type WorkflowDiagnostic = {
  code: string;
  message: string;
  severity: "error" | "warning";
  path: Array<string | number>;
  location?: WorkflowSourceLocation;
};

type WorkflowSchemaBase = {
  optional?: boolean;
  description?: string;
};

export type WorkflowFieldSchema =
  | (WorkflowSchemaBase & {
      kind: "string";
      enum?: string[];
      minLength?: number;
      maxLength?: number;
      format?: "identifier" | "uri";
    })
  | (WorkflowSchemaBase & {
      kind: "number";
      integer?: boolean;
      minimum?: number;
      maximum?: number;
    })
  | (WorkflowSchemaBase & { kind: "boolean" })
  | (WorkflowSchemaBase & { kind: "value" })
  | (WorkflowSchemaBase & { kind: "array"; items: WorkflowFieldSchema; minItems?: number; maxItems?: number })
  | (WorkflowSchemaBase & {
      kind: "record";
      values: WorkflowFieldSchema;
      minProperties?: number;
      maxProperties?: number;
    })
  | (WorkflowSchemaBase & { kind: "object"; properties: Record<string, WorkflowFieldSchema> })
  | (WorkflowSchemaBase & { kind: "union"; variants: WorkflowFieldSchema[] });

export type WorkflowDescriptorDocs = {
  label: string;
  description: string;
  snippet?: string;
};

export type WorkflowInputDescriptor = WorkflowDescriptorDocs & {
  kind: string;
  config: WorkflowFieldSchema & { kind: "object" };
  valueType: string;
};

export type WorkflowTriggerDescriptor = WorkflowDescriptorDocs & {
  kind: string;
  config: WorkflowFieldSchema & { kind: "object" };
  eventValues: Record<string, string>;
};

export type WorkflowActionEffect = "pure" | "transactional" | "durable-intent" | "ambiguous-external";

export type WorkflowActionDescriptor = WorkflowDescriptorDocs & {
  kind: string;
  config: WorkflowFieldSchema & { kind: "object" };
  effect: WorkflowActionEffect;
  outputType?: string;
  dryRun: "full" | "validate" | "unsupported";
};

export type WorkflowActionPolicy = Pick<WorkflowActionDescriptor, "effect" | "dryRun">;

export type WorkflowLanguageManifest = {
  id: string;
  version: number;
  inputs: WorkflowInputDescriptor[];
  triggers: WorkflowTriggerDescriptor[];
  actions: WorkflowActionDescriptor[];
  limits?: {
    maxInputs?: number;
    maxSteps?: number;
    maxDepth?: number;
    maxConditions?: number;
    maxConditionDepth?: number;
    maxLoopItems?: number;
  };
};

export type WorkflowIrInput = {
  name: string;
  type: string;
  config: Record<string, WorkflowJsonValue>;
};

export type WorkflowIrTrigger = {
  kind: string;
  config: Record<string, WorkflowJsonValue>;
  with: Record<string, WorkflowJsonValue>;
};

export type WorkflowCondition =
  | { operator: "equals" | "notEquals"; operands: [WorkflowJsonValue, WorkflowJsonValue] }
  | { operator: "greaterThan" | "lessThan" | "atLeast" | "atMost"; operands: [WorkflowJsonValue, WorkflowJsonValue] }
  | { operator: "includes"; operands: [WorkflowJsonValue, WorkflowJsonValue] }
  | { operator: "textEquals" | "contains" | "startsWith" | "endsWith"; operands: [WorkflowJsonValue, WorkflowJsonValue] }
  | { operator: "exists"; reference: string }
  | { operator: "all"; conditions: WorkflowCondition[] }
  | { operator: "any"; conditions: WorkflowCondition[] }
  | { operator: "not"; condition: WorkflowCondition };

export type WorkflowIrStep =
  | { kind: "action"; action: string; config: Record<string, WorkflowJsonValue>; sourcePath: Array<string | number> }
  | {
      kind: "if";
      condition: WorkflowCondition;
      then: WorkflowIrStep[];
      else: WorkflowIrStep[];
      sourcePath: Array<string | number>;
    }
  | {
      kind: "switch";
      value: WorkflowJsonValue;
      cases: Array<{ when: WorkflowJsonValue; steps: WorkflowIrStep[] }>;
      default: WorkflowIrStep[];
      sourcePath: Array<string | number>;
    }
  | {
      kind: "forEach";
      reference: string;
      alias: string;
      steps: WorkflowIrStep[];
      sourcePath: Array<string | number>;
    };

export type WorkflowIr = {
  schemaVersion: 1;
  languageId: string;
  languageVersion: number;
  sourceHash: string;
  manifestHash: string;
  inputs: WorkflowIrInput[];
  triggers: WorkflowIrTrigger[];
  steps: WorkflowIrStep[];
  sourceLocations: Record<string, WorkflowSourceLocation>;
};

export type WorkflowBoundPlan = {
  schemaVersion: 2;
  languageId: string;
  languageVersion: number;
  sourceHash: string;
  manifestHash: string;
  catalogHash: string;
  maxLoopItems?: number;
  actionPolicies: Record<string, WorkflowActionPolicy>;
  inputs: WorkflowIrInput[];
  triggers: WorkflowIrTrigger[];
  steps: WorkflowIrStep[];
  bindings: Record<string, WorkflowJsonValue>;
};

export type WorkflowActor = {
  userId?: string | null;
  serviceAccountId?: string | null;
  groupIds?: string[];
};

export type WorkflowInvocationMode = "execute" | "dryRun";

export type WorkflowInvocation<Channel extends string = string> = {
  workflowId: string;
  expectedRevision?: WorkflowRevision;
  mode: WorkflowInvocationMode;
  channel: Channel;
  actor: WorkflowActor;
  inputs: Record<string, WorkflowJsonValue>;
  idempotencyKey: string;
  occurredAt: string;
  context?: Record<string, WorkflowJsonValue>;
};

export type WorkflowLauncher<Config extends WorkflowJsonValue = WorkflowJsonValue> = {
  id: string;
  workflowId: string;
  kind: string;
  name: string;
  enabled: boolean;
  config: Config;
  validatedRevision?: WorkflowRevision;
  diagnostics: WorkflowDiagnostic[];
};

export type WorkflowInvocationReceipt = {
  runId: string;
  workflowId: string;
  revision: WorkflowRevision;
  mode: WorkflowInvocationMode;
  channel: string;
  created: boolean;
  status: WorkflowRunState;
};

export type WorkflowStepState =
  | "running"
  | "completed"
  | "waiting"
  | "failed"
  | "needs_attention"
  | "terminal"
  | "planned"
  | "unsupported"
  | "indeterminate"
  | "canceled";
export type WorkflowRunState = "queued" | "running" | "waiting" | "succeeded" | "failed" | "canceled" | "needs_attention";

export type WorkflowExecutionError = {
  code: string;
  message: string;
  retryable: boolean;
  details?: Record<string, WorkflowJsonValue>;
};

export type WorkflowDependency = {
  kind: string;
  key: string;
  deadline?: string;
  data?: Record<string, WorkflowJsonValue>;
};

export type WorkflowControlTraversal =
  | { kind: "if"; branches: Array<"then" | "else"> }
  | { kind: "switch"; branches: Array<number | "default"> }
  | { kind: "forEach"; items: WorkflowJsonValue[] };

export type WorkflowStepOutcome =
  | { state: "completed"; output?: WorkflowJsonValue; control?: WorkflowControlTraversal }
  | { state: "waiting"; dependency: WorkflowDependency }
  | { state: "failed"; error: WorkflowExecutionError }
  | { state: "needs_attention"; error: WorkflowExecutionError }
  | { state: "terminal"; status: "succeeded" | "canceled"; message?: string };

export type WorkflowPlanningIssue = {
  state: "unsupported" | "indeterminate";
  reason: string;
  step: {
    key: string;
    sourcePath: Array<string | number>;
    iterationPath: number[];
    path: Array<string | number>;
    kind: WorkflowIrStep["kind"];
    action?: string;
  };
};

export type WorkflowPlanningOutcome =
  | {
      state: "planned";
      output?: WorkflowJsonValue;
      control?: WorkflowControlTraversal;
      effects: WorkflowJsonValue[];
      issues?: WorkflowPlanningIssue[];
    }
  | {
      state: "terminal";
      status: "succeeded" | "failed";
      message?: string;
      effects: WorkflowJsonValue[];
      issues?: WorkflowPlanningIssue[];
    }
  | { state: "unsupported"; reason: string }
  | { state: "indeterminate"; reason: string }
  | { state: "canceled"; message?: string };

export const workflowPathKey = (path: Array<string | number>): string => path.map(String).join(".");
