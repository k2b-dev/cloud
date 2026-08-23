import { z } from "zod";
import { RecordQuerySchema, ShortIdSchema } from "../contracts";
import {
  GRIDS_WORKFLOW_CHANNELS,
  type GridsWorkflow,
  GridsWorkflowLauncherConfigSchema,
  GridsWorkflowRunStatsWindowSchema,
  GridsWorkflowRunStatusSchema,
  GridsWorkflowStepStatusSchema,
  WorkflowDiagnosticSchema,
} from "../workflows/contracts";
import { PublicDocumentSchema } from "./document-public-contracts";

export const WorkflowValidateSchema = z.object({ source: z.string().min(1).max(200_000) });

const PublicWorkflowPlanSchema = z.custom<GridsWorkflow["plan"]>();

export const PublicWorkflowValidateResponseSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), plan: PublicWorkflowPlanSchema }),
  z.object({ ok: z.literal(false), diagnostics: z.array(WorkflowDiagnosticSchema) }),
]);

export const WorkflowRunDocumentsQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(500).optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
});

const parsePublicCursor = (value: string, context: z.RefinementCtx): string => {
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    if (!/^\d{4}-\d{2}-\d{2}T[^|]+\|[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(decoded)) {
      throw new Error("invalid cursor");
    }
    return decoded;
  } catch {
    context.addIssue({ code: "custom", message: "Invalid workflow cursor" });
    return z.NEVER;
  }
};

const PublicWorkflowCursorSchema = z.string().trim().min(1).max(400).transform(parsePublicCursor);

export const WorkflowRunsQuerySchema = z.object({
  workflowId: ShortIdSchema.optional(),
  status: GridsWorkflowRunStatusSchema.optional(),
  mode: z.enum(["execute", "dryRun"]).optional(),
  channel: z.enum(GRIDS_WORKFLOW_CHANNELS).optional(),
  cursor: PublicWorkflowCursorSchema.optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
});

export const WorkflowRunStatsQuerySchema = z.object({ window: GridsWorkflowRunStatsWindowSchema.optional() });

export const WorkflowEmailDeliveriesQuerySchema = WorkflowRunsQuerySchema.pick({
  workflowId: true,
  cursor: true,
  limit: true,
});

const LauncherInvocationBaseSchema = z.object({
  operationId: z.string().trim().min(1).max(120),
  mode: z.enum(["execute", "dryRun"]).default("execute"),
  expectedRevision: z.number().int().positive().optional(),
  inputs: z.record(z.string(), z.json()).default({}),
  occurredAt: z.string().datetime({ offset: true }).optional(),
});

export const ScannerLauncherRequestSchema = LauncherInvocationBaseSchema.extend({
  expectedRevision: z.number().int().positive(),
  scannedText: z.string().trim().min(1).max(4_096),
}).strict();

const BulkLauncherRecordIdsRequestSchema = LauncherInvocationBaseSchema.extend({
  recordIds: z.array(ShortIdSchema).min(1).max(10_000),
}).strict();

const BulkLauncherQueryRequestSchema = LauncherInvocationBaseSchema.extend({ query: RecordQuerySchema.strict() }).strict();

export const BulkLauncherRequestSchema = z.union([BulkLauncherRecordIdsRequestSchema, BulkLauncherQueryRequestSchema]);
export const RecordLauncherRequestSchema = LauncherInvocationBaseSchema.extend({
  expectedRevision: z.number().int().positive(),
  recordId: ShortIdSchema,
}).strict();
export const CustomAppLauncherRequestSchema = LauncherInvocationBaseSchema.strict();

export const PublicGridsWorkflowSchema = z
  .object({
    id: ShortIdSchema,
    baseId: ShortIdSchema,
    name: z.string(),
    description: z.string().nullable(),
    source: z.string(),
    plan: PublicWorkflowPlanSchema,
    diagnostics: z.array(WorkflowDiagnosticSchema),
    enabled: z.boolean(),
    position: z.number().int().nonnegative(),
    revision: z.number().int().positive(),
    ownerUserId: z.string().uuid().nullable(),
    deletedAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export const PublicGridsWorkflowListSchema = z.array(PublicGridsWorkflowSchema);

export const PublicGridsWorkflowRevisionSchema = z
  .object({
    workflowId: ShortIdSchema,
    revision: z.number().int().positive(),
    name: z.string(),
    description: z.string().nullable(),
    source: z.string(),
    plan: PublicWorkflowPlanSchema,
    diagnostics: z.array(WorkflowDiagnosticSchema),
    position: z.number().int().nonnegative(),
    actorUserId: z.string().uuid().nullable(),
    createdAt: z.string().datetime(),
  })
  .strict();
const PublicGridsWorkflowRevisionSummarySchema = z
  .object({
    workflowId: ShortIdSchema,
    revision: z.number().int().positive(),
    name: z.string(),
    actorUserId: z.string().uuid().nullable(),
    createdAt: z.string().datetime(),
  })
  .strict();
export const PublicGridsWorkflowRevisionListSchema = z
  .object({
    items: z.array(PublicGridsWorkflowRevisionSummarySchema),
    nextRevision: z.number().int().positive().nullable(),
  })
  .strict();

export const PublicWorkflowTriggerRuntimeStateSchema = z
  .object({
    schedule: z
      .object({
        cron: z.string(),
        timezone: z.string(),
        state: z.enum(["paused", "pending", "reconciled", "degraded"]),
        nextRunAt: z.string().datetime().nullable(),
        problem: z.string().nullable(),
      })
      .strict()
      .nullable(),
    recordEvents: z.array(
      z
        .object({
          tableId: ShortIdSchema.nullable(),
          event: z.string(),
          hasFilter: z.boolean(),
          state: z.enum(["paused", "active"]),
        })
        .strict(),
    ),
  })
  .strict();

export const PublicGridsWorkflowLauncherSchema = z
  .object({
    id: ShortIdSchema,
    baseId: ShortIdSchema,
    workflowId: ShortIdSchema,
    name: z.string(),
    config: GridsWorkflowLauncherConfigSchema,
    enabled: z.boolean(),
    validatedRevision: z.number().int().positive(),
    diagnostics: z.array(WorkflowDiagnosticSchema),
    deletedAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export const PublicGridsWorkflowLauncherListSchema = z
  .object({
    items: z.array(PublicGridsWorkflowLauncherSchema),
  })
  .strict();

export const PublicWorkflowInvocationReceiptSchema = z
  .object({
    runId: ShortIdSchema,
    workflowId: ShortIdSchema,
    revision: z.string().min(1),
    mode: z.enum(["execute", "dryRun"]),
    channel: z.enum(GRIDS_WORKFLOW_CHANNELS),
    created: z.boolean(),
    status: GridsWorkflowRunStatusSchema,
  })
  .strict();

const WorkflowErrorSchema = z
  .object({
    code: z.string(),
    message: z.string(),
    retryable: z.boolean(),
    details: z.record(z.string(), z.json()).optional(),
  })
  .strict();

export const PublicGridsWorkflowRunSchema = z
  .object({
    id: ShortIdSchema,
    workflowId: ShortIdSchema.nullable(),
    launcherId: ShortIdSchema.nullable(),
    baseId: ShortIdSchema,
    workflowRevision: z.number().int().positive(),
    mode: z.enum(["execute", "dryRun"]),
    channel: z.enum(GRIDS_WORKFLOW_CHANNELS),
    actorUserId: z.string().uuid().nullable(),
    serviceAccountId: z.string().uuid().nullable(),
    inputs: z.record(z.string(), z.json()),
    status: GridsWorkflowRunStatusSchema,
    result: z.json().nullable(),
    error: WorkflowErrorSchema.nullable(),
    resultMessage: z.string().nullable(),
    createdAt: z.string().datetime(),
    startedAt: z.string().datetime().nullable(),
    finishedAt: z.string().datetime().nullable(),
  })
  .strict();
export const PublicGridsWorkflowRunListSchema = z
  .object({
    items: z.array(PublicGridsWorkflowRunSchema),
    nextCursor: z.string().nullable(),
  })
  .strict();

export const PublicGridsWorkflowStepRunSchema = z
  .object({
    runId: ShortIdSchema,
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
  })
  .strict();
export const PublicGridsWorkflowStepRunListSchema = z
  .object({
    items: z.array(PublicGridsWorkflowStepRunSchema),
    truncated: z.boolean(),
  })
  .strict();

const PublicWorkflowRunStatsCountsSchema = z
  .object({
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
  })
  .strict();
export const PublicGridsWorkflowRunStatsSchema = z
  .object({
    window: GridsWorkflowRunStatsWindowSchema,
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
    failedLast24h: z.number().int().nonnegative(),
    byWorkflow: z.array(
      PublicWorkflowRunStatsCountsSchema.extend({
        workflowId: ShortIdSchema,
        latestStatus: GridsWorkflowRunStatusSchema.nullable(),
      }).strict(),
    ),
  })
  .strict();

const PublicWorkflowEmailRecipientSchema = z
  .object({
    kind: z.enum(["email", "user"]),
    recipient: z.string(),
    notificationId: z.string().uuid().optional(),
    status: z.string().optional(),
  })
  .strict();
const PublicGridsWorkflowEmailDeliverySchema = z
  .object({
    workflowId: ShortIdSchema.nullable(),
    workflowRunId: ShortIdSchema.nullable(),
    templateId: ShortIdSchema.nullable(),
    subject: z.string().nullable(),
    recipients: z.array(PublicWorkflowEmailRecipientSchema),
    status: z.enum(["pending", "sent", "failed"]),
    error: z.string().nullable(),
    createdAt: z.string().datetime(),
  })
  .strict();
export const PublicGridsWorkflowEmailDeliveryListSchema = z
  .object({
    items: z.array(PublicGridsWorkflowEmailDeliverySchema),
    nextCursor: z.string().nullable(),
  })
  .strict();

export const PublicWorkflowDocumentListSchema = z
  .object({
    items: z.array(PublicDocumentSchema),
    total: z.number().int().nonnegative(),
    hasMore: z.boolean(),
    nextOffset: z.number().int().nonnegative().nullable(),
  })
  .strict();
