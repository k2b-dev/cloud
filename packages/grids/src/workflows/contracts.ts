import type {
  WorkflowBoundPlan,
  WorkflowDiagnostic,
  WorkflowInvocationMode,
  WorkflowJsonValue,
  WorkflowRevision,
  WorkflowRunState,
} from "@valentinkolb/cloud/workflows";
import { z } from "zod";

export const GRIDS_WORKFLOW_CHANNELS = ["api", "customApp", "scanner", "bulk", "record", "schedule", "recordEvent"] as const;

export type GridsWorkflowChannel = (typeof GRIDS_WORKFLOW_CHANNELS)[number];

export const GridsWorkflowCredentialBindingSchema = z
  .object({
    appId: z.string().min(1),
    resourceType: z.string().min(1),
    resourceId: z.string().min(1),
  })
  .strict();

export type GridsWorkflowCredentialBinding = z.infer<typeof GridsWorkflowCredentialBindingSchema>;

export const GridsWorkflowCredentialSchema = z
  .object({
    kind: z.enum(["api_token", "oauth"]),
    id: z.string().uuid().nullable(),
    scopes: z.array(z.string()).max(500),
    permissionCap: z.enum(["none", "read", "write", "admin"]),
    expiresAt: z.string().datetime().nullable(),
    resourceBinding: GridsWorkflowCredentialBindingSchema.nullable(),
  })
  .strict();

export type GridsWorkflowCredential = z.infer<typeof GridsWorkflowCredentialSchema>;

export type GridsWorkflowPrincipal = {
  userId: string | null;
  /** Legacy projection only. Authorization resolves current recursive memberships from userId. */
  groupIds: string[];
  serviceAccountId: string | null;
  /** The authenticating service account, including delegated-user credentials. */
  actorServiceAccountId?: string | null;
  credential?: GridsWorkflowCredential | null;
};

export const GridsWorkflowPrincipalSchema = z
  .object({
    userId: z.string().uuid().nullable(),
    groupIds: z.array(z.string().uuid()).max(10_000),
    serviceAccountId: z.string().uuid().nullable(),
    actorServiceAccountId: z.string().uuid().nullable().default(null),
    credential: GridsWorkflowCredentialSchema.nullable().default(null),
  })
  .strict();

export const WORKFLOW_REVISION_HEADER = "X-Workflow-Revision";

export const toWorkflowRevision = (revision: number): WorkflowRevision => String(revision);

export const GRIDS_WORKFLOW_LAUNCHER_KINDS = ["scanner", "bulk", "record", "customApp"] as const;

export type GridsWorkflowLauncherKind = (typeof GRIDS_WORKFLOW_LAUNCHER_KINDS)[number];

export type GridsWorkflow = {
  id: string;
  shortId: string;
  baseId: string;
  name: string;
  description: string | null;
  source: string;
  plan: WorkflowBoundPlan;
  diagnostics: WorkflowDiagnostic[];
  enabled: boolean;
  position: number;
  revision: number;
  ownerUserId: string | null;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CreateGridsWorkflowInput = {
  name: string;
  description?: string | null;
  source: string;
  enabled?: boolean;
  position?: number;
};

export type UpdateGridsWorkflowInput = Partial<CreateGridsWorkflowInput>;

export type GridsWorkflowRevision = {
  workflowId: string;
  revision: number;
  name: string;
  description: string | null;
  source: string;
  plan: WorkflowBoundPlan;
  diagnostics: WorkflowDiagnostic[];
  position: number;
  actorUserId: string | null;
  createdAt: string;
};

export type GridsWorkflowRevisionSummary = Pick<GridsWorkflowRevision, "workflowId" | "revision" | "name" | "actorUserId" | "createdAt">;

export type WorkflowTriggerRuntimeState = {
  schedule: {
    cron: string;
    timezone: string;
    state: "paused" | "pending" | "reconciled" | "degraded";
    nextRunAt: string | null;
    problem: string | null;
  } | null;
  recordEvents: Array<{
    tableId: string | null;
    event: string;
    hasFilter: boolean;
    state: "paused" | "active";
  }>;
};

export type GridsScannerResolve = { by: "scanCode" | "field"; field?: string };

export type GridsScannerInputSource =
  | { kind: "scan"; value: "text" }
  | { kind: "scan"; value: "record"; resolve: GridsScannerResolve }
  | { kind: "session" }
  | { kind: "afterScan" }
  | { kind: "fixed"; value: WorkflowJsonValue };

export type GridsScannerPromptInputSource = Extract<GridsScannerInputSource, { kind: "session" | "afterScan" }>;

export type GridsScannerLauncherConfig =
  | {
      /** Legacy single-record scanner config. Kept readable for stored launchers. */
      kind: "scanner";
      input: string;
      resolve: GridsScannerResolve;
    }
  | {
      kind: "scanner";
      inputSources: Record<string, GridsScannerInputSource>;
    };

export const scannerLauncherInputSources = (config: GridsScannerLauncherConfig): Record<string, GridsScannerInputSource> =>
  "inputSources" in config ? config.inputSources : { [config.input]: { kind: "scan", value: "record", resolve: config.resolve } };

export const scannerLauncherPromptInputSources = (config: GridsScannerLauncherConfig): Record<string, GridsScannerPromptInputSource> =>
  Object.fromEntries(
    Object.entries(scannerLauncherInputSources(config)).filter(
      (entry): entry is [string, GridsScannerPromptInputSource] => entry[1].kind === "session" || entry[1].kind === "afterScan",
    ),
  );

export const CLOSE_SELECTION_MODE_INPUT = "closeMode";
export const CLOSE_SELECTION_POLICY_REVISION_INPUT = "closePolicyRevision";

export const isCanonicalCloseSelectionPlan = (plan: WorkflowBoundPlan, recordListInput: string): boolean => {
  const inputByName = (name: string) => plan.inputs.find((input) => input.name === name);
  const requiredInput = (name: string, type: string) => {
    const input = inputByName(name);
    return Boolean(input && input.type === type && input.config.required === true);
  };
  if (plan.inputs.length !== 3 || plan.triggers.length !== 0 || plan.steps.length !== 1) return false;
  if (!requiredInput(recordListInput, "recordList")) return false;
  if (!requiredInput(CLOSE_SELECTION_MODE_INPUT, "text")) return false;
  if (!requiredInput(CLOSE_SELECTION_POLICY_REVISION_INPUT, "number")) return false;
  if (typeof plan.bindings[`inputs.${recordListInput}.table`] !== "string") return false;
  const loop = plan.steps[0];
  if (loop?.kind !== "forEach" || loop.reference !== `inputs.${recordListInput}` || loop.steps.length !== 1) return false;
  const action = loop.steps[0];
  if (action?.kind !== "action" || action.action !== "closeRecord") return false;
  return (
    Object.keys(action.config).sort().join(",") === "expectedMode,expectedPolicyRevision,record" &&
    action.config.record === loop.alias &&
    action.config.expectedMode === `inputs.${CLOSE_SELECTION_MODE_INPUT}` &&
    action.config.expectedPolicyRevision === `inputs.${CLOSE_SELECTION_POLICY_REVISION_INPUT}`
  );
};

export const isCanonicalCorrectionDraftPlan = (plan: WorkflowBoundPlan, recordInput: string): boolean => {
  const input = plan.inputs.find((candidate) => candidate.name === recordInput);
  if (
    plan.inputs.length !== 1 ||
    !input ||
    input.type !== "record" ||
    input.config.required !== true ||
    plan.triggers.length !== 0 ||
    plan.steps.length !== 1 ||
    typeof plan.bindings[`inputs.${recordInput}.table`] !== "string"
  ) {
    return false;
  }
  const action = plan.steps[0];
  if (action?.kind !== "action" || action.action !== "createCorrectionDraft") return false;
  return (
    Object.keys(action.config).sort().join(",") === "original,originalField,typeField,typeValue" &&
    action.config.original === `inputs.${recordInput}` &&
    typeof action.config.typeField === "string" &&
    typeof action.config.typeValue === "string" &&
    typeof action.config.originalField === "string" &&
    typeof plan.bindings["steps.0.createCorrectionDraft.typeField"] === "string" &&
    typeof plan.bindings["steps.0.createCorrectionDraft.originalField"] === "string"
  );
};

export type GridsBulkLauncherConfig = { kind: "bulk"; input: string } | { kind: "bulk"; input: string; profile: "closeSelection" };

export type GridsRecordLauncherConfig = { kind: "record"; input: string; profile: "correctionDraft" };

export type GridsWorkflowLauncherConfig =
  | GridsScannerLauncherConfig
  | GridsBulkLauncherConfig
  | GridsRecordLauncherConfig
  | {
      kind: "customApp";
      label?: string;
      inputMode: "fixed" | "prompt";
      inputBindings?: Record<string, WorkflowJsonValue>;
    };

export type GridsWorkflowLauncher = {
  id: string;
  shortId: string;
  baseId: string;
  workflowId: string;
  name: string;
  config: GridsWorkflowLauncherConfig;
  enabled: boolean;
  validatedRevision: number;
  diagnostics: WorkflowDiagnostic[];
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CreateGridsWorkflowLauncherInput = {
  name: string;
  config: GridsWorkflowLauncherConfig;
  enabled?: boolean;
};

export type UpdateGridsWorkflowLauncherInput = Partial<CreateGridsWorkflowLauncherInput>;

export type GridsWorkflowInvocationRequest = {
  mode: WorkflowInvocationMode;
  inputs: Record<string, WorkflowJsonValue>;
  idempotencyKey: string;
  expectedRevision?: number;
};

export type GridsWorkflowRun = {
  id: string;
  workflowId: string | null;
  launcherId: string | null;
  baseId: string;
  workflowRevision: number;
  mode: WorkflowInvocationMode;
  channel: GridsWorkflowChannel;
  actorUserId: string | null;
  serviceAccountId: string | null;
  inputs: Record<string, WorkflowJsonValue>;
  status: WorkflowRunState;
  result: WorkflowJsonValue | null;
  error: { code: string; message: string; retryable: boolean; details?: Record<string, WorkflowJsonValue> } | null;
  resultMessage: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

export type GridsWorkflowStepStatus = z.infer<typeof GridsWorkflowStepStatusSchema>;

export type GridsWorkflowStepRun = {
  runId: string;
  key: string;
  sourcePath: Array<string | number>;
  iterationPath: number[];
  kind: string;
  action: string | null;
  status: GridsWorkflowStepStatus;
  outcome: WorkflowJsonValue | null;
  executionGeneration: number;
  startedAt: string | null;
  finishedAt: string | null;
};

export const WorkflowDiagnosticSchema = z.object({
  code: z.string(),
  message: z.string(),
  severity: z.enum(["error", "warning"]),
  path: z.array(z.union([z.string(), z.number()])),
  location: z
    .object({ offset: z.number().int().nonnegative(), line: z.number().int().positive(), column: z.number().int().positive() })
    .optional(),
});

export const WorkflowPlanSchema = z
  .object({
    schemaVersion: z.literal(2),
    languageId: z.string(),
    languageVersion: z.number().int().positive(),
    sourceHash: z.string(),
    manifestHash: z.string(),
    catalogHash: z.string(),
    maxLoopItems: z.number().int().positive().optional(),
    actionPolicies: z.record(
      z.string(),
      z.object({
        effect: z.enum(["pure", "transactional", "durable-intent", "ambiguous-external"]),
        dryRun: z.enum(["full", "validate", "unsupported"]),
      }),
    ),
    inputs: z.array(z.unknown()),
    triggers: z.array(z.unknown()),
    steps: z.array(z.unknown()),
    bindings: z.record(z.string(), z.unknown()),
  })
  .strict()
  .transform((value) => value as WorkflowBoundPlan);

export const GridsWorkflowSchema = z.object({
  id: z.string().uuid(),
  shortId: z.string().length(6),
  baseId: z.string().uuid(),
  name: z.string(),
  description: z.string().nullable(),
  source: z.string(),
  plan: WorkflowPlanSchema,
  diagnostics: z.array(WorkflowDiagnosticSchema),
  enabled: z.boolean(),
  position: z.number().int().nonnegative(),
  revision: z.number().int().positive(),
  ownerUserId: z.string().uuid().nullable(),
  deletedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const CreateGridsWorkflowSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().max(1000).nullable().optional(),
  source: z.string().min(1).max(200_000),
  enabled: z.boolean().optional(),
  position: z.number().int().nonnegative().optional(),
});

export const UpdateGridsWorkflowSchema = CreateGridsWorkflowSchema.partial();

export const GridsWorkflowRevisionSchema = z.object({
  workflowId: z.string().uuid(),
  revision: z.number().int().positive(),
  name: z.string(),
  description: z.string().nullable(),
  source: z.string(),
  plan: WorkflowPlanSchema,
  diagnostics: z.array(WorkflowDiagnosticSchema),
  position: z.number().int().nonnegative(),
  actorUserId: z.string().uuid().nullable(),
  createdAt: z.string().datetime(),
});

export const GridsWorkflowRevisionSummarySchema = GridsWorkflowRevisionSchema.pick({
  workflowId: true,
  revision: true,
  name: true,
  actorUserId: true,
  createdAt: true,
});

export const GridsWorkflowRevisionListSchema = z.object({
  items: z.array(GridsWorkflowRevisionSummarySchema),
  nextRevision: z.number().int().positive().nullable(),
});

export const RestoreGridsWorkflowRevisionSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
  })
  .strict();

export const WorkflowTriggerRuntimeStateSchema = z.object({
  schedule: z
    .object({
      cron: z.string(),
      timezone: z.string(),
      state: z.enum(["paused", "pending", "reconciled", "degraded"]),
      nextRunAt: z.string().datetime().nullable(),
      problem: z.string().nullable(),
    })
    .nullable(),
  recordEvents: z.array(
    z.object({
      tableId: z.string().uuid().nullable(),
      event: z.string(),
      hasFilter: z.boolean(),
      state: z.enum(["paused", "active"]),
    }),
  ),
});

const ScannerResolveSchema = z
  .object({
    by: z.enum(["scanCode", "field"]),
    field: z.string().trim().min(1).max(200).optional(),
  })
  .strict()
  .superRefine((resolve, ctx) => {
    if (resolve.by === "field" && !resolve.field) {
      ctx.addIssue({ code: "custom", path: ["field"], message: "field resolution requires a field" });
    }
    if (resolve.by === "scanCode" && resolve.field !== undefined) {
      ctx.addIssue({ code: "custom", path: ["field"], message: "scan-code resolution does not accept a field" });
    }
  });

const LegacyScannerLauncherConfigSchema = z
  .object({
    kind: z.literal("scanner"),
    input: z.string().trim().min(1).max(120),
    resolve: ScannerResolveSchema,
  })
  .strict();

const ScannerInputSourceSchema = z.union([
  z.object({ kind: z.literal("scan"), value: z.literal("text") }).strict(),
  z.object({ kind: z.literal("scan"), value: z.literal("record"), resolve: ScannerResolveSchema }).strict(),
  z.object({ kind: z.literal("session") }).strict(),
  z.object({ kind: z.literal("afterScan") }).strict(),
  z.object({ kind: z.literal("fixed"), value: z.json() }).strict(),
]);

const StagedScannerLauncherConfigSchema = z
  .object({
    kind: z.literal("scanner"),
    inputSources: z.record(z.string().trim().min(1).max(120), ScannerInputSourceSchema),
  })
  .strict()
  .superRefine((config, ctx) => {
    const entries = Object.entries(config.inputSources);
    if (entries.length === 0) {
      ctx.addIssue({ code: "custom", path: ["inputSources"], message: "scanner requires input sources" });
    }
    if (entries.length > 100) {
      ctx.addIssue({ code: "custom", path: ["inputSources"], message: "scanner supports at most 100 input sources" });
    }
    if (entries.filter(([, source]) => source.kind === "scan").length !== 1) {
      ctx.addIssue({ code: "custom", path: ["inputSources"], message: "scanner requires exactly one scan input source" });
    }
  });

const ScannerLauncherConfigSchema = z.union([LegacyScannerLauncherConfigSchema, StagedScannerLauncherConfigSchema]);

const StandardBulkLauncherConfigSchema = z
  .object({
    kind: z.literal("bulk"),
    input: z.string().trim().min(1).max(120),
  })
  .strict();

const CloseSelectionBulkLauncherConfigSchema = z
  .object({
    kind: z.literal("bulk"),
    input: z.string().trim().min(1).max(120),
    profile: z.literal("closeSelection"),
  })
  .strict();

const BulkLauncherConfigSchema = z.union([StandardBulkLauncherConfigSchema, CloseSelectionBulkLauncherConfigSchema]);

const CorrectionDraftRecordLauncherConfigSchema = z
  .object({
    kind: z.literal("record"),
    input: z.string().trim().min(1).max(120),
    profile: z.literal("correctionDraft"),
  })
  .strict();

const CustomAppLauncherConfigSchema = z
  .object({
    kind: z.literal("customApp"),
    label: z.string().trim().min(1).max(80).optional(),
    inputMode: z.enum(["fixed", "prompt"]).default("fixed"),
    inputBindings: z.record(z.string(), z.json()).optional(),
  })
  .strict()
  .superRefine((config, ctx) => {
    if (config.inputMode === "prompt" && Object.keys(config.inputBindings ?? {}).length > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["inputBindings"],
        message: "prompt Grids App launchers do not accept fixed input bindings",
      });
    }
  });

export const GridsWorkflowLauncherConfigSchema = z.union([
  ScannerLauncherConfigSchema,
  BulkLauncherConfigSchema,
  CorrectionDraftRecordLauncherConfigSchema,
  CustomAppLauncherConfigSchema,
]);

export const CreateGridsWorkflowLauncherSchema = z.object({
  name: z.string().trim().min(1).max(200),
  config: GridsWorkflowLauncherConfigSchema,
  enabled: z.boolean().optional(),
});

export const UpdateGridsWorkflowLauncherSchema = CreateGridsWorkflowLauncherSchema.partial();

export const GridsWorkflowInvocationRequestSchema = z
  .object({
    mode: z.enum(["execute", "dryRun"]).default("execute"),
    inputs: z.record(z.string(), z.json()).default({}),
    idempotencyKey: z.string().trim().min(1).max(200),
    expectedRevision: z.number().int().positive().optional(),
  })
  .strict();

export const GridsWorkflowRunStatusSchema = z.enum(["queued", "running", "waiting", "succeeded", "failed", "canceled", "needs_attention"]);

export const GridsWorkflowListSchema = z.array(GridsWorkflowSchema);

export const GridsWorkflowLauncherSchema = z.object({
  id: z.string().uuid(),
  shortId: z.string().length(6),
  baseId: z.string().uuid(),
  workflowId: z.string().uuid(),
  name: z.string(),
  config: GridsWorkflowLauncherConfigSchema,
  enabled: z.boolean(),
  validatedRevision: z.number().int().positive(),
  diagnostics: z.array(WorkflowDiagnosticSchema),
  deletedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const GridsWorkflowLauncherListSchema = z.object({ items: z.array(GridsWorkflowLauncherSchema) });

export const WorkflowInvocationReceiptSchema = z.object({
  runId: z.string().uuid(),
  workflowId: z.string().uuid(),
  revision: z.string().min(1),
  mode: z.enum(["execute", "dryRun"]),
  channel: z.enum(GRIDS_WORKFLOW_CHANNELS),
  created: z.boolean(),
  status: GridsWorkflowRunStatusSchema,
});

export const GridsWorkflowRunSchema = z.object({
  id: z.string().uuid(),
  workflowId: z.string().uuid().nullable(),
  launcherId: z.string().uuid().nullable(),
  baseId: z.string().uuid(),
  workflowRevision: z.number().int().positive(),
  mode: z.enum(["execute", "dryRun"]),
  channel: z.enum(GRIDS_WORKFLOW_CHANNELS),
  actorUserId: z.string().uuid().nullable(),
  serviceAccountId: z.string().uuid().nullable(),
  inputs: z.record(z.string(), z.json()),
  status: GridsWorkflowRunStatusSchema,
  result: z.json().nullable(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      retryable: z.boolean(),
      details: z.record(z.string(), z.json()).optional(),
    })
    .nullable(),
  resultMessage: z.string().nullable(),
  createdAt: z.string().datetime(),
  startedAt: z.string().datetime().nullable(),
  finishedAt: z.string().datetime().nullable(),
});

export const GridsWorkflowRunListSchema = z.object({
  items: z.array(GridsWorkflowRunSchema),
  nextCursor: z.string().nullable(),
});

/*
 * A step's states are the kernel's, not the run's. An executed step ends
 * "completed" and a planned one "planned" — neither is "succeeded", which is a
 * run's word. Restating the run vocabulary here is how a finished step ended up
 * rendered as though it were still going.
 */
export const GridsWorkflowStepStatusSchema = z.enum([
  "running",
  "completed",
  "waiting",
  "failed",
  "needs_attention",
  "terminal",
  "planned",
  "unsupported",
  "indeterminate",
  "canceled",
]);

export const GridsWorkflowStepRunSchema = z.object({
  runId: z.string().uuid(),
  key: z.string(),
  sourcePath: z.array(z.union([z.string(), z.number()])),
  iterationPath: z.array(z.number().int().nonnegative()),
  kind: z.string(),
  action: z.string().nullable(),
  status: GridsWorkflowStepStatusSchema,
  outcome: z.json().nullable(),
  executionGeneration: z.number().int().nonnegative(),
  startedAt: z.string().datetime().nullable(),
  finishedAt: z.string().datetime().nullable(),
});

export const GridsWorkflowStepRunListSchema = z.object({
  items: z.array(GridsWorkflowStepRunSchema),
  truncated: z.boolean(),
});

export const GridsWorkflowEmailDeliverySchema = z.object({
  id: z.string().uuid(),
  workflowId: z.string().uuid().nullable(),
  workflowRunId: z.string().uuid().nullable(),
  templateId: z.string().uuid().nullable(),
  subject: z.string().nullable(),
  recipients: z.array(
    z.object({
      kind: z.enum(["email", "user"]),
      recipient: z.string(),
      notificationId: z.string().uuid().optional(),
      status: z.string().optional(),
    }),
  ),
  status: z.enum(["pending", "sent", "failed"]),
  error: z.string().nullable(),
  createdAt: z.string().datetime(),
});

export type GridsWorkflowEmailDelivery = z.infer<typeof GridsWorkflowEmailDeliverySchema>;

export const GridsWorkflowEmailDeliveryListSchema = z.object({
  items: z.array(GridsWorkflowEmailDeliverySchema),
  nextCursor: z.string().nullable(),
});

export const GridsWorkflowRunStatsWindowSchema = z.enum(["10m", "1h", "12h", "24h", "7d", "30d"]);
export type GridsWorkflowRunStatsWindow = z.infer<typeof GridsWorkflowRunStatsWindowSchema>;

const GridsWorkflowRunStatsCountsSchema = z.object({
  total: z.number().int().nonnegative(),
  active: z.number().int().nonnegative(),
  queued: z.number().int().nonnegative(),
  running: z.number().int().nonnegative(),
  waiting: z.number().int().nonnegative(),
  succeeded: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  canceled: z.number().int().nonnegative(),
  needsAttention: z.number().int().nonnegative(),
  errorRate: z.number().nonnegative(),
  avgDurationMs: z.number().int().nonnegative().nullable(),
  p99DurationMs: z.number().int().nonnegative().nullable(),
  lastRunAt: z.string().datetime().nullable(),
});

export const GridsWorkflowRunStatsSchema = GridsWorkflowRunStatsCountsSchema.extend({
  window: GridsWorkflowRunStatsWindowSchema,
  failedLast24h: z.number().int().nonnegative(),
  byWorkflow: z.array(
    GridsWorkflowRunStatsCountsSchema.extend({
      workflowId: z.string().uuid(),
      latestStatus: GridsWorkflowRunStatusSchema.nullable(),
    }),
  ),
});

export type GridsWorkflowRunStats = z.infer<typeof GridsWorkflowRunStatsSchema>;

export const WorkflowAutocompleteBodySchema = z
  .object({
    source: z.string().max(200_000),
    caret: z.number().int().min(0).max(200_000).optional(),
  })
  .refine((body) => body.caret === undefined || body.caret <= body.source.length, {
    message: "caret must be inside source",
    path: ["caret"],
  });

const WorkflowCompletionItemSchema = z.object({
  label: z.string(),
  kind: z.enum(["keyword", "source", "field", "literal"]),
  detail: z.string().optional(),
  insertText: z.string(),
  textEdit: z.object({ start: z.number().int().nonnegative(), end: z.number().int().nonnegative(), text: z.string() }),
  commitCharacters: z.array(z.string()).optional(),
});

export type WorkflowCompletionItem = z.infer<typeof WorkflowCompletionItemSchema>;

export const WorkflowAutocompleteResponseSchema = z.object({
  ok: z.literal(true),
  diagnostics: z.array(WorkflowDiagnosticSchema),
  items: z.array(WorkflowCompletionItemSchema),
});

export type WorkflowAutocompleteResponse = z.infer<typeof WorkflowAutocompleteResponseSchema>;
