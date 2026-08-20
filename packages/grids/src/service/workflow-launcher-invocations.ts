import { err, fail, ok, type Result } from "@k2b/stdlib";
import { get as settingsGet } from "@valentinkolb/cloud/services/settings";
import { normalizeTimeZone } from "@valentinkolb/cloud/shared";
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
};

export type WorkflowLauncherInvocationDeps = {
  getLauncher: typeof getLauncher;
  getWorkflow: typeof getWorkflow;
  authorize: (input: LauncherAuthorizationInput) => Promise<Result<AuthorizedRecordAccess | null>>;
  resolveScanCode: (baseId: string, tableId: string, scannedText: string, recordAccess: AuthorizedRecordAccess) => Promise<Result<string>>;
  resolveUniqueField: (
    baseId: string,
    tableId: string,
    fieldRef: string,
    scannedText: string,
    recordAccess: AuthorizedRecordAccess,
  ) => Promise<Result<string>>;
  resolveExplicitRecordIds: (
    baseId: string,
    tableId: string,
    recordIds: string[],
    recordAccess: AuthorizedRecordAccess,
  ) => Promise<Result<string[]>>;
  resolveQueryRecordIds: (
    tableId: string,
    query: RecordQuery,
    principal: GridsWorkflowPrincipal,
    recordAccess: AuthorizedRecordAccess,
  ) => Promise<Result<string[]>>;
  invokeWorkflow: typeof invokeGridsWorkflow;
};

const formatZodError = (error: z.ZodError): string => {
  const issue = error.issues[0];
  if (!issue) return "invalid input";
  const path = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
  return `${path}${issue.message}`;
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

const authorize: WorkflowLauncherInvocationDeps["authorize"] = async ({ launcherId, workflow, principal, tableId, authorization }) => {
  const principalState = await revalidateWorkflowPrincipal(principal, workflow.baseId);
  if (!principalState.ok || !workflowPermissionAllows(principalState.permissionCap, "write")) {
    return fail(err.forbidden("Workflow actor cannot run this workflow."));
  }
  if (!authorization || authorization.kind === "workflow") {
    if (!(await authorizeWorkflowBase(principal, workflow.baseId, "write"))) {
      return fail(err.forbidden("Workflow actor cannot run this workflow."));
    }
  }
  if (authorization && authorization.kind !== "workflow") {
    const claim = { baseId: workflow.baseId, workflowId: workflow.id, principal, authorization, launcherId };
    if (tableId) {
      const recordAccess = await resolveWorkflowExecutionRecordAccess(claim, tableId, "read");
      return recordAccess ? ok(recordAccess) : fail(err.forbidden("Workflow actor cannot run this workflow."));
    }
    return (await canExecuteWorkflow(claim)) ? ok(null) : fail(err.forbidden("Workflow actor cannot run this workflow."));
  }
  if (tableId) {
    const recordAccess = await resolveWorkflowBaseRecordAccess(principal, { baseId: workflow.baseId, tableId }, "read");
    if (!recordAccess) return fail(err.forbidden("Workflow actor cannot read the launcher input table."));
    return ok(recordAccess);
  }
  return ok(null);
};

const resolveScanCode: WorkflowLauncherInvocationDeps["resolveScanCode"] = async (baseId, tableId, scannedText, recordAccess) => {
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
  return row ? ok(row.id) : fail(err.notFound("scan code"));
};

const resolveUniqueField: WorkflowLauncherInvocationDeps["resolveUniqueField"] = async (
  baseId,
  tableId,
  fieldRef,
  scannedText,
  recordAccess,
) => {
  const field = resolveWorkflowFieldRef(await loadWorkflowCatalog(baseId), tableId, fieldRef);
  if (!field) return fail(err.badInput(`unknown or ambiguous scanner field "${fieldRef}"`));
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
  if (!storedField) return fail(err.badInput(`unknown scanner field "${fieldRef}"`));
  if (!storedField.unique_constraint) return fail(err.badInput(`scanner field "${fieldRef}" must enforce unique values`));
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
  if (rows.length === 0) return fail(err.notFound("scanned record"));
  if (rows.length > 1) return fail(err.badInput(`scanner field "${fieldRef}" matched more than one record`));
  return ok(rows[0]!.id);
};

const resolveExplicitRecordIds: WorkflowLauncherInvocationDeps["resolveExplicitRecordIds"] = async (
  baseId,
  tableId,
  recordIds,
  recordAccess,
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
  return found.size === recordIds.length ? ok(recordIds) : fail(err.notFound("Record"));
};

const resolveQueryRecordIds: WorkflowLauncherInvocationDeps["resolveQueryRecordIds"] = async (tableId, query, principal, recordAccess) => {
  if ((query.groupBy?.length ?? 0) > 0 || (query.aggregations?.length ?? 0) > 0 || (query.groupSort?.length ?? 0) > 0) {
    return fail(err.badInput("bulk selection queries must be row-shaped"));
  }
  if (query.includeDeleted || query.deletedOnly) return fail(err.badInput("bulk selection queries cannot include deleted records"));

  const requestedCount = query.limit ?? MAX_BULK_LAUNCHER_RECORDS + 1;
  const ids: string[] = [];
  let cursor: string | null = null;
  const dateConfig = {
    timeZone: normalizeTimeZone(String((await settingsGet<string>("app.timezone")) || "").trim(), "UTC"),
    locale: "en",
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
  if (ids.length === 0) return fail(err.badInput("bulk selection query returned no records"));
  if (ids.length > MAX_BULK_LAUNCHER_RECORDS) {
    return fail(err.badInput(`bulk selection supports at most ${MAX_BULK_LAUNCHER_RECORDS} records`));
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
): Promise<Result<LauncherContext>> => {
  const launcher = await deps.getLauncher(launcherId);
  if (!launcher) return fail(err.notFound("workflow launcher"));
  const config = StrictLauncherConfigSchema.safeParse(launcher.config);
  if (!config.success) return fail(err.badInput(`invalid workflow launcher config: ${formatZodError(config.error)}`));
  if (config.data.kind !== expectedKind) return fail(err.badInput(`workflow launcher is not a ${expectedKind} launcher`));
  if (!launcher.enabled || launcher.diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    return fail(err.badInput("workflow launcher is disabled or invalid"));
  }
  const workflow = await deps.getWorkflow(launcher.workflowId);
  if (!workflow || workflow.baseId !== launcher.baseId) return fail(err.notFound("workflow"));
  if (launcher.validatedRevision !== workflow.revision) return fail(workflowConflict("Workflow launcher must be revalidated."));
  if (expectedRevision !== undefined && workflow.revision !== expectedRevision) {
    return fail(workflowConflict("Workflow changed since the launcher operation started."));
  }

  let tableId: string | null = null;
  if (config.data.kind === "scanner") {
    const scanEntries = Object.entries(scannerLauncherInputSources(config.data)).filter(([, source]) => source.kind === "scan");
    const [scanEntry] = scanEntries;
    if (!scanEntry || scanEntries.length !== 1) return fail(err.badInput("scanner launcher must define exactly one scan input"));
    const [inputName, source] = scanEntry;
    const input = workflow.plan.inputs.find((candidate) => candidate.name === inputName);
    const expectedType = source.kind === "scan" && source.value === "record" ? "record" : "text";
    if (!input || input.type !== expectedType) return fail(err.badInput("scanner launcher input contract is invalid"));
    if (source.kind === "scan" && source.value === "record") {
      tableId = boundTableId(workflow, inputName);
      if (!tableId) return fail(err.badInput("scanner launcher input has no bound table"));
    }
  } else if (config.data.kind === "bulk" || config.data.kind === "record") {
    const bulkInputName = config.data.input;
    const input = workflow.plan.inputs.find((candidate) => candidate.name === bulkInputName);
    const expectedType = config.data.kind === "bulk" ? "recordList" : "record";
    if (!input || input.type !== expectedType) return fail(err.badInput(`${config.data.kind} launcher input contract is invalid`));
    tableId = boundTableId(workflow, bulkInputName);
    if (!tableId) return fail(err.badInput(`${config.data.kind} launcher input has no bound table`));
  } else {
    const inputNames = new Set(workflow.plan.inputs.map((input) => input.name));
    const unknownBinding = Object.keys(config.data.inputBindings ?? {}).find((name) => !inputNames.has(name));
    if (unknownBinding) return fail(err.badInput(`Grids App launcher binds unknown workflow input "${unknownBinding}"`));
  }
  return ok({ launcher, workflow, config: config.data, tableId });
};

const idempotencyKey = (launcherId: string, operationId: string): string => `launcher:${launcherId}:${operationId}`;

const mergeInputs = (
  fixed: Record<string, WorkflowJsonValue>,
  supplied: Record<string, WorkflowJsonValue>,
): Result<Record<string, WorkflowJsonValue>> => {
  const conflict = Object.keys(fixed).find((name) => Object.hasOwn(supplied, name));
  return conflict
    ? fail(err.badInput(`launcher-controlled workflow input "${conflict}" cannot be overridden`))
    : ok({ ...supplied, ...fixed });
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
    context: { launcher: { id: ctx.launcher.id, kind: ctx.config.kind, operationId: input.operationId } },
  });

export const invokeScannerLauncher = async (
  rawInput: unknown,
  deps: WorkflowLauncherInvocationDeps = defaultDeps,
): Promise<Result<WorkflowInvocationReceipt>> => {
  const input = ScannerLauncherInvocationSchema.safeParse(rawInput);
  if (!input.success) return fail(err.badInput(`invalid scanner launcher invocation: ${formatZodError(input.error)}`));
  const loaded = await loadLauncherContext(input.data.launcherId, "scanner", input.data.expectedRevision, deps);
  if (!loaded.ok) return loaded;
  const ctx = loaded.data;
  if (ctx.config.kind !== "scanner") return fail(err.internal("scanner launcher context is invalid"));
  const sources = scannerLauncherInputSources(ctx.config);
  const scanEntry = Object.entries(sources).find(([, source]) => source.kind === "scan");
  if (!scanEntry) return fail(err.internal("scanner launcher context has no scan input"));
  const [scanInputName, scanSource] = scanEntry;
  const suppliedInputName = Object.keys(input.data.inputs).find((name) => {
    const source = sources[name];
    return !source || (source.kind !== "session" && source.kind !== "afterScan");
  });
  if (suppliedInputName) {
    return fail(err.badInput(`workflow input "${suppliedInputName}" is not supplied by the scanner user`));
  }
  const authorized = await deps.authorize({
    launcherId: ctx.launcher.id,
    workflow: ctx.workflow,
    principal: input.data.principal,
    tableId: ctx.tableId,
    authorization: input.data.authorization,
  });
  if (!authorized.ok) return authorized;
  const scannedText = normalizeScannedText(input.data.scannedText);
  const controlledInputs: Record<string, WorkflowJsonValue> = Object.fromEntries(
    Object.entries(sources)
      .filter(([, source]) => source.kind === "fixed")
      .map(([name, source]) => [name, source.kind === "fixed" ? source.value : null]),
  );
  let trustedRecordIds: ReadonlyMap<string, ReadonlySet<string>> | undefined;
  if (scanSource.kind !== "scan") return fail(err.internal("scanner launcher scan input is invalid"));
  if (scanSource.value === "text") {
    controlledInputs[scanInputName] = scannedText;
  } else {
    if (!ctx.tableId) return fail(err.internal("scanner record input has no table"));
    if (!authorized.data) return fail(err.internal("scanner record input has no record access policy"));
    const recordId =
      scanSource.resolve.by === "field"
        ? await deps.resolveUniqueField(ctx.workflow.baseId, ctx.tableId, scanSource.resolve.field!, scannedText, authorized.data)
        : await deps.resolveScanCode(ctx.workflow.baseId, ctx.tableId, scannedText, authorized.data);
    if (!recordId.ok) return recordId;
    controlledInputs[scanInputName] = recordId.data;
    trustedRecordIds = new Map([[ctx.tableId, new Set([recordId.data])]]);
  }
  const inputs = mergeInputs(controlledInputs, input.data.inputs);
  return inputs.ok ? invoke(ctx, { ...input.data, inputs: inputs.data, trustedRecordIds }, deps) : inputs;
};

export const invokeBulkLauncher = async (
  rawInput: unknown,
  deps: WorkflowLauncherInvocationDeps = defaultDeps,
): Promise<Result<WorkflowInvocationReceipt>> => {
  const input = BulkLauncherInvocationSchema.safeParse(rawInput);
  if (!input.success) return fail(err.badInput(`invalid bulk launcher invocation: ${formatZodError(input.error)}`));
  const loaded = await loadLauncherContext(input.data.launcherId, "bulk", input.data.expectedRevision, deps);
  if (!loaded.ok) return loaded;
  const ctx = loaded.data;
  if (ctx.config.kind !== "bulk" || !ctx.tableId) return fail(err.internal("bulk launcher context is invalid"));
  if ("profile" in ctx.config && ctx.config.profile === "closeSelection") {
    if (!("recordIds" in input.data)) {
      return fail(err.badInput("This workflow run option requires an explicit Record selection."));
    }
    const mode = input.data.inputs[CLOSE_SELECTION_MODE_INPUT];
    if (mode !== "direct" && mode !== "fourEyes") {
      return fail(err.badInput("Close selection requires the previewed Finalization mode."));
    }
    const policyRevision = input.data.inputs[CLOSE_SELECTION_POLICY_REVISION_INPUT];
    if (typeof policyRevision !== "number" || !Number.isSafeInteger(policyRevision) || policyRevision < 1) {
      return fail(err.badInput("Close selection requires the previewed Finalization policy revision."));
    }
  }
  if (input.data.authorization?.kind === "custom-app-bulk-action") {
    if (!("recordIds" in input.data)) return fail(err.badInput("Grids App bulk launchers require explicit record IDs"));
    const claimed = [...input.data.authorization.recordIds].sort();
    const supplied = [...input.data.recordIds].sort();
    if (claimed.length !== supplied.length || claimed.some((recordId, index) => supplied[index] !== recordId)) {
      return fail(err.badInput("Grids App bulk selection does not match its authorization"));
    }
  }
  const authorized = await deps.authorize({
    launcherId: ctx.launcher.id,
    workflow: ctx.workflow,
    principal: input.data.principal,
    tableId: ctx.tableId,
    authorization: input.data.authorization,
  });
  if (!authorized.ok) return authorized;
  if (!authorized.data) return fail(err.internal("bulk launcher input has no record access policy"));
  const recordIds =
    "recordIds" in input.data
      ? await deps.resolveExplicitRecordIds(ctx.workflow.baseId, ctx.tableId, input.data.recordIds, authorized.data)
      : await deps.resolveQueryRecordIds(ctx.tableId, input.data.query, input.data.principal, authorized.data);
  if (!recordIds.ok) return recordIds;
  const inputs = mergeInputs({ [ctx.config.input]: recordIds.data }, input.data.inputs);
  return inputs.ok
    ? invoke(ctx, { ...input.data, inputs: inputs.data, trustedRecordIds: new Map([[ctx.tableId, new Set(recordIds.data)]]) }, deps)
    : inputs;
};

export const admitBulkLauncher = async (
  input: {
    launcherId: string;
    expectedRevision?: number;
    principal: GridsWorkflowPrincipal;
  },
  deps: WorkflowLauncherInvocationDeps = defaultDeps,
): Promise<Result<void>> => {
  const loaded = await loadLauncherContext(input.launcherId, "bulk", input.expectedRevision, deps);
  if (!loaded.ok) return loaded;
  const ctx = loaded.data;
  const authorized = await deps.authorize({
    launcherId: ctx.launcher.id,
    workflow: ctx.workflow,
    principal: input.principal,
    tableId: ctx.tableId,
  });
  return authorized.ok ? ok() : authorized;
};

export const invokeRecordLauncher = async (
  rawInput: unknown,
  deps: WorkflowLauncherInvocationDeps = defaultDeps,
): Promise<Result<WorkflowInvocationReceipt>> => {
  const input = RecordLauncherInvocationSchema.safeParse(rawInput);
  if (!input.success) return fail(err.badInput(`invalid record launcher invocation: ${formatZodError(input.error)}`));
  const loaded = await loadLauncherContext(input.data.launcherId, "record", input.data.expectedRevision, deps);
  if (!loaded.ok) return loaded;
  const ctx = loaded.data;
  if (ctx.config.kind !== "record" || !ctx.tableId) return fail(err.internal("record launcher context is invalid"));
  if (Object.keys(input.data.inputs).length > 0) return fail(err.badInput("record actions do not accept additional workflow inputs"));
  const authorized = await deps.authorize({
    launcherId: ctx.launcher.id,
    workflow: ctx.workflow,
    principal: input.data.principal,
    tableId: ctx.tableId,
    authorization: input.data.authorization,
  });
  if (!authorized.ok) return authorized;
  if (!authorized.data) return fail(err.internal("record launcher input has no record access policy"));
  const recordIds = await deps.resolveExplicitRecordIds(ctx.workflow.baseId, ctx.tableId, [input.data.recordId], authorized.data);
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
  input: { launcherId: string; expectedRevision?: number; principal: GridsWorkflowPrincipal },
  deps: WorkflowLauncherInvocationDeps = defaultDeps,
): Promise<Result<void>> => {
  const loaded = await loadLauncherContext(input.launcherId, "record", input.expectedRevision, deps);
  if (!loaded.ok) return loaded;
  const ctx = loaded.data;
  const authorized = await deps.authorize({
    launcherId: ctx.launcher.id,
    workflow: ctx.workflow,
    principal: input.principal,
    tableId: ctx.tableId,
  });
  return authorized.ok ? ok() : authorized;
};

export const invokeCustomAppLauncher = async (
  rawInput: unknown,
  deps: WorkflowLauncherInvocationDeps = defaultDeps,
): Promise<Result<WorkflowInvocationReceipt>> => {
  const input = CustomAppLauncherInvocationSchema.safeParse(rawInput);
  if (!input.success) return fail(err.badInput(`invalid Grids App launcher invocation: ${formatZodError(input.error)}`));
  const loaded = await loadLauncherContext(input.data.launcherId, "customApp", input.data.expectedRevision, deps);
  if (!loaded.ok) return loaded;
  const ctx = loaded.data;
  if (ctx.config.kind !== "customApp") return fail(err.internal("Grids App launcher context is invalid"));
  const authorized = await deps.authorize({
    launcherId: ctx.launcher.id,
    workflow: ctx.workflow,
    principal: input.data.principal,
    tableId: null,
    authorization: input.data.authorization,
  });
  if (!authorized.ok) return authorized;
  const suppliedInputs = input.data.inputs;
  if (ctx.config.inputMode === "fixed" && Object.keys(suppliedInputs).length > 0) {
    return fail(err.badInput("fixed Grids App launchers do not accept runtime inputs"));
  }
  const inputs = ctx.config.inputMode === "fixed" ? (ctx.config.inputBindings ?? {}) : suppliedInputs;
  return invoke(ctx, { ...input.data, inputs }, deps);
};
