import { err, fail, ok, type Result } from "@k2b/stdlib";
import { get as settingsGet } from "@valentinkolb/cloud/services/settings";
import { normalizeLocale, normalizeTimeZone } from "@valentinkolb/cloud/shared";
import type { WorkflowInvocationMode, WorkflowInvocationReceipt, WorkflowJsonValue } from "@valentinkolb/cloud/workflows";
import { sql } from "bun";
import { z } from "zod";
import { type RecordQuery, RecordQuerySchema } from "../contracts";
import {
  CLOSE_SELECTION_MODE_INPUT,
  CLOSE_SELECTION_POLICY_REVISION_INPUT,
  type GridsWorkflow,
  type GridsWorkflowLauncher,
  type GridsWorkflowLauncherConfig,
  GridsWorkflowLauncherConfigSchema,
  type GridsWorkflowPrincipal,
  GridsWorkflowPrincipalSchema,
  scannerLauncherInputSources,
} from "../workflows/contracts";
import { type AuthorizedRecordAccess, recordAccessPredicate } from "./record-access";
import { list as listRecords } from "./records";
import { canExecuteWorkflow, resolveWorkflowExecutionRecordAccess } from "./workflow-action-scope";
import {
  authorizeWorkflowBase,
  resolveWorkflowBaseRecordAccess,
  revalidateWorkflowPrincipal,
  workflowPermissionAllows,
} from "./workflow-authorization";
import { loadWorkflowCatalog, resolveWorkflowFieldRef } from "./workflow-catalog";
import { getWorkflow } from "./workflow-definitions";
import { workflowConflict } from "./workflow-errors";
import { getLauncher } from "./workflow-launchers";
import { invokeGridsWorkflow } from "./workflow-runtime";
import { workflowServiceText } from "./workflow-service-messages";

export const MAX_BULK_LAUNCHER_RECORDS = 10_000;

const SCAN_CODE_PATH_RE = /(?:^|\/)scan(?:\?|$)/;
const operationIdSchema = z.string().trim().min(1).max(120);
const jsonInputsSchema = z.record(z.string(), z.json());
const principalSchema = GridsWorkflowPrincipalSchema;

const launcherAuthorizationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("workflow") }).strict(),
  z
    .object({
      kind: z.literal("custom-app-action"),
      customAppId: z.string().uuid(),
      publishedAt: z.string().datetime(),
      pageId: z.string().min(1),
      pageParams: z.record(z.string(), z.string().uuid()),
      timeZone: z.string().min(1).max(100),
      blockId: z.string().min(1),
      actionId: z.string().min(1),
      recordId: z.string().uuid().optional(),
      search: z.string().max(200).optional(),
      cursor: z.string().max(8_000).optional(),
      revision: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("custom-app-bulk-action"),
      customAppId: z.string().uuid(),
      publishedAt: z.string().datetime(),
      pageId: z.string().min(1),
      pageParams: z.record(z.string(), z.string().uuid()),
      timeZone: z.string().min(1).max(100),
      blockId: z.string().min(1),
      actionId: z.string().min(1),
      recordIds: z.array(z.string().uuid()).min(1).max(10_000),
      search: z.string().max(200).optional(),
      cursor: z.string().max(8_000).optional(),
      revision: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("custom-app-sidebar-action"),
      customAppId: z.string().uuid(),
      publishedAt: z.string().datetime(),
      timeZone: z.string().min(1).max(100),
      actionId: z.string().min(1),
      revision: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("custom-app-scanner"),
      customAppId: z.string().uuid(),
      publishedAt: z.string().datetime(),
      pageId: z.string().min(1),
      pageParams: z.record(z.string(), z.string().uuid()),
      timeZone: z.string().min(1).max(100),
      blockId: z.string().min(1),
      revision: z.number().int().positive(),
      configHash: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict(),
]);

const invocationFields = {
  launcherId: z.string().uuid(),
  operationId: operationIdSchema,
  mode: z.enum(["execute", "dryRun"]),
  expectedRevision: z.number().int().positive().optional(),
  principal: principalSchema,
  authorization: launcherAuthorizationSchema.optional(),
  inputs: jsonInputsSchema.default({}),
  occurredAt: z.string().datetime({ offset: true }).optional(),
  locale: z.string().trim().min(1).max(100).optional(),
};

export const ScannerLauncherInvocationSchema = z
  .object({
    ...invocationFields,
    expectedRevision: z.number().int().positive(),
    scannedText: z.string().trim().min(1).max(4_096),
  })
  .strict();

const explicitRecordIdsSchema = z
  .array(z.string().uuid())
  .min(1)
  .max(MAX_BULK_LAUNCHER_RECORDS)
  .superRefine((recordIds, ctx) => {
    if (new Set(recordIds).size !== recordIds.length) ctx.addIssue({ code: "custom", message: "record IDs must be unique" });
  });

const BulkRecordIdsLauncherInvocationSchema = z
  .object({
    ...invocationFields,
    recordIds: explicitRecordIdsSchema,
  })
  .strict();

const BulkQueryLauncherInvocationSchema = z
  .object({
    ...invocationFields,
    query: RecordQuerySchema.strict(),
  })
  .strict();

export const BulkLauncherInvocationSchema = z.union([BulkRecordIdsLauncherInvocationSchema, BulkQueryLauncherInvocationSchema]);

export const RecordLauncherInvocationSchema = z
  .object({
    ...invocationFields,
    recordId: z.string().uuid(),
  })
  .strict();

export const CustomAppLauncherInvocationSchema = z.object(invocationFields).strict();

const StrictLauncherConfigSchema = GridsWorkflowLauncherConfigSchema;

export type ScannerLauncherInvocation = z.infer<typeof ScannerLauncherInvocationSchema>;
export type BulkLauncherInvocation = z.infer<typeof BulkLauncherInvocationSchema>;
export type RecordLauncherInvocation = z.infer<typeof RecordLauncherInvocationSchema>;
export type CustomAppLauncherInvocation = z.infer<typeof CustomAppLauncherInvocationSchema>;

type LauncherKind = GridsWorkflowLauncherConfig["kind"];

type LauncherContext = {
  launcher: GridsWorkflowLauncher;
  workflow: GridsWorkflow;
  config: z.infer<typeof StrictLauncherConfigSchema>;
  tableId: string | null;
};

type LauncherAuthorizationInput = {
  launcherId: string;
  workflow: GridsWorkflow;
  principal: GridsWorkflowPrincipal;
  tableId: string | null;
  authorization?: z.infer<typeof launcherAuthorizationSchema>;
  locale?: string;
};

const formatZodError = (error: z.ZodError): string => {
  const issue = error.issues[0];
  if (!issue) return "invalid input";
  const path = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
  return `${path}${issue.message}`;
};

export type WorkflowLauncherInvocationDeps = {
  getLauncher: typeof getLauncher;
  getWorkflow: typeof getWorkflow;
  authorize: (input: LauncherAuthorizationInput) => Promise<Result<AuthorizedRecordAccess | null>>;
  resolveScanCode: (
    baseId: string,
    tableId: string,
    scannedText: string,
    recordAccess: AuthorizedRecordAccess,
    locale?: string,
  ) => Promise<Result<string>>;
  resolveUniqueField: (
    baseId: string,
    tableId: string,
    fieldRef: string,
    scannedText: string,
    recordAccess: AuthorizedRecordAccess,
    locale?: string,
  ) => Promise<Result<string>>;
  resolveExplicitRecordIds: (
    baseId: string,
    tableId: string,
    recordIds: string[],
    recordAccess: AuthorizedRecordAccess,
    locale?: string,
  ) => Promise<Result<string[]>>;
  resolveQueryRecordIds: (
    tableId: string,
    query: RecordQuery,
    principal: GridsWorkflowPrincipal,
    recordAccess: AuthorizedRecordAccess,
    locale?: string,
  ) => Promise<Result<string[]>>;
  invokeWorkflow: typeof invokeGridsWorkflow;
};

const normalizeScannedText = (value: string): string => {
  const trimmed = value.trim();
  try {
    const parsed = new URL(trimmed, "https://grids.local");
    const code = parsed.searchParams.get("code");
    if (code && SCAN_CODE_PATH_RE.test(parsed.pathname)) return code.trim();
  } catch {
    // Raw scanner values are expected.
  }
  return trimmed;
};

const invocationLocale = (input: unknown): string | undefined => {
  if (!input || typeof input !== "object") return undefined;
  const locale = (input as { locale?: unknown }).locale;
  return typeof locale === "string" ? locale : undefined;
};

const authorize: WorkflowLauncherInvocationDeps["authorize"] = async ({
  launcherId,
  workflow,
  principal,
  tableId,
  authorization,
  locale,
}) => {
  const t = workflowServiceText(locale);
  const principalState = await revalidateWorkflowPrincipal(principal, workflow.baseId);
  if (!principalState.ok || !workflowPermissionAllows(principalState.permissionCap, "write")) {
    return fail(err.forbidden(t.actorCannotRun));
  }
  if (!authorization || authorization.kind === "workflow") {
    if (!(await authorizeWorkflowBase(principal, workflow.baseId, "write"))) {
      return fail(err.forbidden(t.actorCannotRun));
    }
  }
  if (authorization && authorization.kind !== "workflow") {
    const claim = { baseId: workflow.baseId, workflowId: workflow.id, principal, authorization, launcherId };
    if (tableId) {
      const recordAccess = await resolveWorkflowExecutionRecordAccess(claim, tableId, "read");
      return recordAccess ? ok(recordAccess) : fail(err.forbidden(t.actorCannotRun));
    }
    return (await canExecuteWorkflow(claim)) ? ok(null) : fail(err.forbidden(t.actorCannotRun));
  }
  if (tableId) {
    const recordAccess = await resolveWorkflowBaseRecordAccess(principal, { baseId: workflow.baseId, tableId }, "read");
    if (!recordAccess) return fail(err.forbidden(t.actorCannotReadInput));
    return ok(recordAccess);
  }
  return ok(null);
};

const resolveScanCode: WorkflowLauncherInvocationDeps["resolveScanCode"] = async (baseId, tableId, scannedText, recordAccess, locale) => {
  const [row] = await sql<Array<{ id: string }>>`
    SELECT r.id::text AS id
    FROM grids.record_scan_codes scan
    JOIN grids.records r ON r.id = scan.record_id AND r.deleted_at IS NULL
    JOIN grids.tables t ON t.id = r.table_id AND t.deleted_at IS NULL
    JOIN grids.bases b ON b.id = t.base_id AND b.deleted_at IS NULL
    WHERE scan.code = ${scannedText}
      AND scan.active = TRUE
      AND scan.base_id = ${baseId}::uuid
      AND scan.table_id = ${tableId}::uuid
      AND r.table_id = ${tableId}::uuid
      AND ${recordAccessPredicate(recordAccess, "r")}
  `;
  return row ? ok(row.id) : fail({ ...err.notFound("scan code"), message: workflowServiceText(locale).scanCodeNotFound });
};

const resolveUniqueField: WorkflowLauncherInvocationDeps["resolveUniqueField"] = async (
  baseId,
  tableId,
  fieldRef,
  scannedText,
  recordAccess,
  locale,
) => {
  const t = workflowServiceText(locale);
  const field = resolveWorkflowFieldRef(await loadWorkflowCatalog(baseId), tableId, fieldRef);
  if (!field) return fail(err.badInput(t.scannerFieldUnknown({ field: fieldRef })));
  const [storedField] = await sql<Array<{ unique_constraint: boolean }>>`
    SELECT f.unique_constraint
    FROM grids.fields f
    JOIN grids.tables t ON t.id = f.table_id AND t.deleted_at IS NULL
    JOIN grids.bases b ON b.id = t.base_id AND b.deleted_at IS NULL
    WHERE b.id = ${baseId}::uuid
      AND f.table_id = ${tableId}::uuid
      AND f.id = ${field.id}::uuid
      AND f.deleted_at IS NULL
  `;
  if (!storedField) return fail(err.badInput(t.scannerStoredFieldUnknown({ field: fieldRef })));
  if (!storedField.unique_constraint) return fail(err.badInput(t.scannerFieldUnique({ field: fieldRef })));
  const rows = await sql<Array<{ id: string }>>`
    SELECT r.id::text AS id
    FROM grids.records r
    JOIN grids.tables t ON t.id = r.table_id AND t.deleted_at IS NULL
    JOIN grids.bases b ON b.id = t.base_id AND b.deleted_at IS NULL
    WHERE b.id = ${baseId}::uuid
      AND r.table_id = ${tableId}::uuid
      AND r.deleted_at IS NULL
      AND r.data ->> ${field.id} = ${scannedText}
      AND ${recordAccessPredicate(recordAccess, "r")}
    ORDER BY r.id
    LIMIT 2
  `;
  if (rows.length === 0) return fail({ ...err.notFound("scanned record"), message: t.scannedRecordNotFound });
  if (rows.length > 1) return fail(err.badInput(t.scannerFieldMultiple({ field: fieldRef })));
  return ok(rows[0]!.id);
};

const resolveExplicitRecordIds: WorkflowLauncherInvocationDeps["resolveExplicitRecordIds"] = async (
  baseId,
  tableId,
  recordIds,
  recordAccess,
  locale,
) => {
  const rows = await sql<Array<{ id: string }>>`
    SELECT r.id::text AS id
    FROM grids.records r
    JOIN grids.tables t ON t.id = r.table_id AND t.deleted_at IS NULL
    JOIN grids.bases b ON b.id = t.base_id AND b.deleted_at IS NULL
    WHERE b.id = ${baseId}::uuid
      AND r.table_id = ${tableId}::uuid
      AND r.id = ANY(${sql.array(recordIds, "UUID")}::uuid[])
      AND r.deleted_at IS NULL
      AND ${recordAccessPredicate(recordAccess, "r")}
  `;
  const found = new Set(rows.map((row) => row.id));
  return found.size === recordIds.length
    ? ok(recordIds)
    : fail({ ...err.notFound("Record"), message: workflowServiceText(locale).recordsNotFound });
};

const resolveQueryRecordIds: WorkflowLauncherInvocationDeps["resolveQueryRecordIds"] = async (
  tableId,
  query,
  principal,
  recordAccess,
  locale,
) => {
  const t = workflowServiceText(locale);
  if ((query.groupBy?.length ?? 0) > 0 || (query.aggregations?.length ?? 0) > 0 || (query.groupSort?.length ?? 0) > 0) {
    return fail(err.badInput(t.bulkRowsOnly));
  }
  if (query.includeDeleted || query.deletedOnly) return fail(err.badInput(t.bulkNoDeleted));

  const requestedCount = query.limit ?? MAX_BULK_LAUNCHER_RECORDS + 1;
  const ids: string[] = [];
  let cursor: string | null = null;
  const dateConfig = {
    timeZone: normalizeTimeZone(String((await settingsGet<string>("app.timezone")) || "").trim(), "UTC"),
    locale: normalizeLocale(locale),
    firstDayOfWeek: 1 as const,
  };
  while (ids.length < requestedCount) {
    const page = await listRecords({
      tableId,
      cursor,
      limit: Math.min(500, requestedCount - ids.length),
      filter: query.filter ?? null,
      search: query.search ?? null,
      recordMeta: query.recordMeta ?? null,
      sort: query.sort ?? [],
      viewer: { userId: principal.userId, userGroups: principal.groupIds, serviceAccountId: principal.serviceAccountId },
      recordAccess,
      dateConfig,
    });
    if (!page.ok) return page;
    ids.push(...page.data.items.map((record) => record.id));
    if (!page.data.nextCursor || page.data.items.length === 0) break;
    cursor = page.data.nextCursor;
  }
  if (ids.length === 0) return fail(err.badInput(t.bulkEmpty));
  if (ids.length > MAX_BULK_LAUNCHER_RECORDS) {
    return fail(err.badInput(t.bulkLimit({ count: MAX_BULK_LAUNCHER_RECORDS })));
  }
  return ok(ids);
};

const defaultDeps: WorkflowLauncherInvocationDeps = {
  getLauncher,
  getWorkflow,
  authorize,
  resolveScanCode,
  resolveUniqueField,
  resolveExplicitRecordIds,
  resolveQueryRecordIds,
  invokeWorkflow: invokeGridsWorkflow,
};

const boundTableId = (workflow: GridsWorkflow, inputName: string): string | null => {
  const value = workflow.plan.bindings[`inputs.${inputName}.table`];
  return typeof value === "string" && z.string().uuid().safeParse(value).success ? value : null;
};

const loadLauncherContext = async (
  launcherId: string,
  expectedKind: LauncherKind,
  expectedRevision: number | undefined,
  deps: WorkflowLauncherInvocationDeps,
  locale?: string,
): Promise<Result<LauncherContext>> => {
  const t = workflowServiceText(locale);
  const launcher = await deps.getLauncher(launcherId);
  if (!launcher) return fail({ ...err.notFound("workflow launcher"), message: t.launcherNotFound });
  const config = StrictLauncherConfigSchema.safeParse(launcher.config);
  if (!config.success) return fail(err.badInput(t.invalidLauncherConfig({ detail: formatZodError(config.error) })));
  if (config.data.kind !== expectedKind) return fail(err.badInput(t.wrongLauncherKind({ kind: expectedKind })));
  if (!launcher.enabled || launcher.diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    return fail(err.badInput(t.launcherDisabled));
  }
  const workflow = await deps.getWorkflow(launcher.workflowId);
  if (!workflow || workflow.baseId !== launcher.baseId) return fail({ ...err.notFound("workflow"), message: t.workflowNotFound });
  if (launcher.validatedRevision !== workflow.revision) return fail(workflowConflict(t.launcherRevalidate));
  if (expectedRevision !== undefined && workflow.revision !== expectedRevision) {
    return fail(workflowConflict(t.launcherOperationChanged));
  }

  let tableId: string | null = null;
  if (config.data.kind === "scanner") {
    const scanEntries = Object.entries(scannerLauncherInputSources(config.data)).filter(([, source]) => source.kind === "scan");
    const [scanEntry] = scanEntries;
    if (!scanEntry || scanEntries.length !== 1) return fail(err.badInput(t.scannerInputCount));
    const [inputName, source] = scanEntry;
    const input = workflow.plan.inputs.find((candidate) => candidate.name === inputName);
    const expectedType = source.kind === "scan" && source.value === "record" ? "record" : "text";
    if (!input || input.type !== expectedType) return fail(err.badInput(t.scannerInputContract));
    if (source.kind === "scan" && source.value === "record") {
      tableId = boundTableId(workflow, inputName);
      if (!tableId) return fail(err.badInput(t.scannerInputTable));
    }
  } else if (config.data.kind === "bulk" || config.data.kind === "record") {
    const bulkInputName = config.data.input;
    const input = workflow.plan.inputs.find((candidate) => candidate.name === bulkInputName);
    const expectedType = config.data.kind === "bulk" ? "recordList" : "record";
    if (!input || input.type !== expectedType) return fail(err.badInput(t.launcherInputContract({ kind: config.data.kind })));
    tableId = boundTableId(workflow, bulkInputName);
    if (!tableId) return fail(err.badInput(t.launcherInputTable({ kind: config.data.kind })));
  } else {
    const inputNames = new Set(workflow.plan.inputs.map((input) => input.name));
    const unknownBinding = Object.keys(config.data.inputBindings ?? {}).find((name) => !inputNames.has(name));
    if (unknownBinding) return fail(err.badInput(t.unknownBoundInput({ input: unknownBinding })));
  }
  return ok({ launcher, workflow, config: config.data, tableId });
};

const admitLauncherVisibility = async (
  launcherId: string,
  principal: GridsWorkflowPrincipal,
  deps: WorkflowLauncherInvocationDeps,
  locale?: string,
): Promise<Result<void>> => {
  const t = workflowServiceText(locale);
  const launcher = await deps.getLauncher(launcherId);
  if (!launcher) return fail({ ...err.notFound("Workflow launcher"), message: t.launcherNotFound });
  const workflow = await deps.getWorkflow(launcher.workflowId);
  if (!workflow || workflow.baseId !== launcher.baseId) return fail({ ...err.notFound("Workflow launcher"), message: t.launcherNotFound });
  const authorized = await deps.authorize({ launcherId: launcher.id, workflow, principal, tableId: null, locale });
  if (!authorized.ok) {
    return authorized.error.status === 403 ? fail({ ...err.notFound("Workflow launcher"), message: t.launcherNotFound }) : authorized;
  }
  return ok();
};

const idempotencyKey = (launcherId: string, operationId: string): string => `launcher:${launcherId}:${operationId}`;

const mergeInputs = (
  fixed: Record<string, WorkflowJsonValue>,
  supplied: Record<string, WorkflowJsonValue>,
  locale?: string,
): Result<Record<string, WorkflowJsonValue>> => {
  const conflict = Object.keys(fixed).find((name) => Object.hasOwn(supplied, name));
  return conflict ? fail(err.badInput(workflowServiceText(locale).controlledInput({ input: conflict }))) : ok({ ...supplied, ...fixed });
};

const invoke = (
  ctx: LauncherContext,
  input: {
    mode: WorkflowInvocationMode;
    operationId: string;
    expectedRevision?: number;
    principal: GridsWorkflowPrincipal;
    inputs: Record<string, WorkflowJsonValue>;
    occurredAt?: string;
    locale?: string;
    authorization?: z.infer<typeof launcherAuthorizationSchema>;
    trustedRecordIds?: ReadonlyMap<string, ReadonlySet<string>>;
  },
  deps: WorkflowLauncherInvocationDeps,
): Promise<Result<WorkflowInvocationReceipt>> =>
  deps.invokeWorkflow({
    workflowId: ctx.workflow.id,
    mode: input.mode,
    channel: ctx.config.kind,
    inputs: input.inputs,
    idempotencyKey: idempotencyKey(ctx.launcher.id, input.operationId),
    expectedRevision: input.expectedRevision,
    principal: input.principal,
    launcherId: ctx.launcher.id,
    authorization: input.authorization,
    occurredAt: input.occurredAt,
    trustedRecordIds: input.trustedRecordIds,
    context: {
      locale: normalizeLocale(input.locale),
      launcher: { id: ctx.launcher.id, kind: ctx.config.kind, operationId: input.operationId },
    },
  });

export const invokeScannerLauncher = async (
  rawInput: unknown,
  deps: WorkflowLauncherInvocationDeps = defaultDeps,
): Promise<Result<WorkflowInvocationReceipt>> => {
  const input = ScannerLauncherInvocationSchema.safeParse(rawInput);
  if (!input.success)
    return fail(
      err.badInput(
        workflowServiceText(invocationLocale(rawInput)).invalidLauncherInvocation({ kind: "scanner", detail: formatZodError(input.error) }),
      ),
    );
  const t = workflowServiceText(input.data.locale);
  const loaded = await loadLauncherContext(input.data.launcherId, "scanner", input.data.expectedRevision, deps, input.data.locale);
  if (!loaded.ok) return loaded;
  const ctx = loaded.data;
  if (ctx.config.kind !== "scanner") return fail(err.internal(t.launcherContextInvalid));
  const sources = scannerLauncherInputSources(ctx.config);
  const scanEntry = Object.entries(sources).find(([, source]) => source.kind === "scan");
  if (!scanEntry) return fail(err.internal(t.launcherContextInvalid));
  const [scanInputName, scanSource] = scanEntry;
  const suppliedInputName = Object.keys(input.data.inputs).find((name) => {
    const source = sources[name];
    return !source || (source.kind !== "session" && source.kind !== "afterScan");
  });
  if (suppliedInputName) {
    return fail(err.badInput(t.scannerUserInput({ input: suppliedInputName })));
  }
  const authorized = await deps.authorize({
    launcherId: ctx.launcher.id,
    workflow: ctx.workflow,
    principal: input.data.principal,
    tableId: ctx.tableId,
    authorization: input.data.authorization,
    locale: input.data.locale,
  });
  if (!authorized.ok) return authorized;
  const scannedText = normalizeScannedText(input.data.scannedText);
  const controlledInputs: Record<string, WorkflowJsonValue> = Object.fromEntries(
    Object.entries(sources)
      .filter(([, source]) => source.kind === "fixed")
      .map(([name, source]) => [name, source.kind === "fixed" ? source.value : null]),
  );
  let trustedRecordIds: ReadonlyMap<string, ReadonlySet<string>> | undefined;
  if (scanSource.kind !== "scan") return fail(err.internal(t.launcherContextInvalid));
  if (scanSource.value === "text") {
    controlledInputs[scanInputName] = scannedText;
  } else {
    if (!ctx.tableId) return fail(err.internal(t.launcherContextInvalid));
    if (!authorized.data) return fail(err.internal(t.launcherContextInvalid));
    const recordId =
      scanSource.resolve.by === "field"
        ? await deps.resolveUniqueField(
            ctx.workflow.baseId,
            ctx.tableId,
            scanSource.resolve.field!,
            scannedText,
            authorized.data,
            input.data.locale,
          )
        : await deps.resolveScanCode(ctx.workflow.baseId, ctx.tableId, scannedText, authorized.data, input.data.locale);
    if (!recordId.ok) return recordId;
    controlledInputs[scanInputName] = recordId.data;
    trustedRecordIds = new Map([[ctx.tableId, new Set([recordId.data])]]);
  }
  const inputs = mergeInputs(controlledInputs, input.data.inputs, input.data.locale);
  return inputs.ok ? invoke(ctx, { ...input.data, inputs: inputs.data, trustedRecordIds }, deps) : inputs;
};

export const invokeBulkLauncher = async (
  rawInput: unknown,
  deps: WorkflowLauncherInvocationDeps = defaultDeps,
): Promise<Result<WorkflowInvocationReceipt>> => {
  const input = BulkLauncherInvocationSchema.safeParse(rawInput);
  if (!input.success)
    return fail(
      err.badInput(
        workflowServiceText(invocationLocale(rawInput)).invalidLauncherInvocation({ kind: "bulk", detail: formatZodError(input.error) }),
      ),
    );
  const t = workflowServiceText(input.data.locale);
  const loaded = await loadLauncherContext(input.data.launcherId, "bulk", input.data.expectedRevision, deps, input.data.locale);
  if (!loaded.ok) return loaded;
  const ctx = loaded.data;
  if (ctx.config.kind !== "bulk" || !ctx.tableId) return fail(err.internal(t.launcherContextInvalid));
  if ("profile" in ctx.config && ctx.config.profile === "closeSelection") {
    if (!("recordIds" in input.data)) {
      return fail(err.badInput(t.explicitSelectionRequired));
    }
    const mode = input.data.inputs[CLOSE_SELECTION_MODE_INPUT];
    if (mode !== "direct" && mode !== "fourEyes") {
      return fail(err.badInput(t.closeSelectionModeChanged));
    }
    const policyRevision = input.data.inputs[CLOSE_SELECTION_POLICY_REVISION_INPUT];
    if (typeof policyRevision !== "number" || !Number.isSafeInteger(policyRevision) || policyRevision < 1) {
      return fail(err.badInput(t.closeSelectionPolicyChanged));
    }
  }
  if (input.data.authorization?.kind === "custom-app-bulk-action") {
    if (!("recordIds" in input.data)) return fail(err.badInput(t.appExplicitIds));
    const claimed = [...input.data.authorization.recordIds].sort();
    const supplied = [...input.data.recordIds].sort();
    if (claimed.length !== supplied.length || claimed.some((recordId, index) => supplied[index] !== recordId)) {
      return fail(err.badInput(t.appAuthorizationMismatch));
    }
  }
  const authorized = await deps.authorize({
    launcherId: ctx.launcher.id,
    workflow: ctx.workflow,
    principal: input.data.principal,
    tableId: ctx.tableId,
    authorization: input.data.authorization,
    locale: input.data.locale,
  });
  if (!authorized.ok) return authorized;
  if (!authorized.data) return fail(err.internal(t.launcherContextInvalid));
  const recordIds =
    "recordIds" in input.data
      ? await deps.resolveExplicitRecordIds(ctx.workflow.baseId, ctx.tableId, input.data.recordIds, authorized.data, input.data.locale)
      : await deps.resolveQueryRecordIds(ctx.tableId, input.data.query, input.data.principal, authorized.data, input.data.locale);
  if (!recordIds.ok) return recordIds;
  const inputs = mergeInputs({ [ctx.config.input]: recordIds.data }, input.data.inputs, input.data.locale);
  return inputs.ok
    ? invoke(ctx, { ...input.data, inputs: inputs.data, trustedRecordIds: new Map([[ctx.tableId, new Set(recordIds.data)]]) }, deps)
    : inputs;
};

export const admitBulkLauncher = async (
  input: {
    launcherId: string;
    expectedRevision?: number;
    principal: GridsWorkflowPrincipal;
    locale?: string;
  },
  deps: WorkflowLauncherInvocationDeps = defaultDeps,
): Promise<Result<void>> => {
  const loaded = await loadLauncherContext(input.launcherId, "bulk", input.expectedRevision, deps, input.locale);
  if (!loaded.ok) return loaded;
  const ctx = loaded.data;
  const authorized = await deps.authorize({
    launcherId: ctx.launcher.id,
    workflow: ctx.workflow,
    principal: input.principal,
    tableId: ctx.tableId,
    locale: input.locale,
  });
  return authorized.ok ? ok() : authorized;
};

export const invokeRecordLauncher = async (
  rawInput: unknown,
  deps: WorkflowLauncherInvocationDeps = defaultDeps,
): Promise<Result<WorkflowInvocationReceipt>> => {
  const input = RecordLauncherInvocationSchema.safeParse(rawInput);
  if (!input.success)
    return fail(
      err.badInput(
        workflowServiceText(invocationLocale(rawInput)).invalidLauncherInvocation({ kind: "record", detail: formatZodError(input.error) }),
      ),
    );
  const t = workflowServiceText(input.data.locale);
  const visible = await admitLauncherVisibility(input.data.launcherId, input.data.principal, deps, input.data.locale);
  if (!visible.ok) return visible;
  const loaded = await loadLauncherContext(input.data.launcherId, "record", input.data.expectedRevision, deps, input.data.locale);
  if (!loaded.ok) return loaded;
  const ctx = loaded.data;
  if (ctx.config.kind !== "record" || !ctx.tableId) return fail(err.internal(t.launcherContextInvalid));
  if (Object.keys(input.data.inputs).length > 0) return fail(err.badInput(t.recordExtraInputs));
  const authorized = await deps.authorize({
    launcherId: ctx.launcher.id,
    workflow: ctx.workflow,
    principal: input.data.principal,
    tableId: ctx.tableId,
    authorization: input.data.authorization,
    locale: input.data.locale,
  });
  if (!authorized.ok) return authorized;
  if (!authorized.data) return fail(err.internal(t.launcherContextInvalid));
  const recordIds = await deps.resolveExplicitRecordIds(
    ctx.workflow.baseId,
    ctx.tableId,
    [input.data.recordId],
    authorized.data,
    input.data.locale,
  );
  if (!recordIds.ok) return recordIds;
  return invoke(
    ctx,
    {
      ...input.data,
      inputs: { [ctx.config.input]: recordIds.data[0]! },
      trustedRecordIds: new Map([[ctx.tableId, new Set(recordIds.data)]]),
    },
    deps,
  );
};

export const admitRecordLauncher = async (
  input: { launcherId: string; expectedRevision?: number; principal: GridsWorkflowPrincipal; locale?: string },
  deps: WorkflowLauncherInvocationDeps = defaultDeps,
): Promise<Result<void>> => {
  const visible = await admitLauncherVisibility(input.launcherId, input.principal, deps, input.locale);
  if (!visible.ok) return visible;
  const loaded = await loadLauncherContext(input.launcherId, "record", input.expectedRevision, deps, input.locale);
  if (!loaded.ok) return loaded;
  const ctx = loaded.data;
  const authorized = await deps.authorize({
    launcherId: ctx.launcher.id,
    workflow: ctx.workflow,
    principal: input.principal,
    tableId: ctx.tableId,
    locale: input.locale,
  });
  return authorized.ok ? ok() : authorized;
};

export const invokeCustomAppLauncher = async (
  rawInput: unknown,
  deps: WorkflowLauncherInvocationDeps = defaultDeps,
): Promise<Result<WorkflowInvocationReceipt>> => {
  const input = CustomAppLauncherInvocationSchema.safeParse(rawInput);
  if (!input.success)
    return fail(
      err.badInput(
        workflowServiceText(invocationLocale(rawInput)).invalidLauncherInvocation({
          kind: "Grids App",
          detail: formatZodError(input.error),
        }),
      ),
    );
  const t = workflowServiceText(input.data.locale);
  const loaded = await loadLauncherContext(input.data.launcherId, "customApp", input.data.expectedRevision, deps, input.data.locale);
  if (!loaded.ok) return loaded;
  const ctx = loaded.data;
  if (ctx.config.kind !== "customApp") return fail(err.internal(t.launcherContextInvalid));
  const authorized = await deps.authorize({
    launcherId: ctx.launcher.id,
    workflow: ctx.workflow,
    principal: input.data.principal,
    tableId: null,
    authorization: input.data.authorization,
    locale: input.data.locale,
  });
  if (!authorized.ok) return authorized;
  const suppliedInputs = input.data.inputs;
  if (ctx.config.inputMode === "fixed" && Object.keys(suppliedInputs).length > 0) {
    return fail(err.badInput(t.fixedInputs));
  }
  const inputs = ctx.config.inputMode === "fixed" ? (ctx.config.inputBindings ?? {}) : suppliedInputs;
  return invoke(ctx, { ...input.data, inputs }, deps);
};
