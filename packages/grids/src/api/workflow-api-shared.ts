import type { AuthContext } from "@k2b/cloud/server";
import {
  buildWorkflowManifestCompletions,
  type WorkflowInvocationReceipt,
  workflowCompletionContext,
  workflowCompletionItem,
} from "@k2b/cloud/workflows";
import { compileWorkflow } from "@k2b/cloud/workflows/language";
import type { Context } from "hono";
import { z } from "zod";
import type { DocumentSummaryList } from "../contracts";
import { get as getBase } from "../service/bases";
import { listTemplatesForTable } from "../service/document-templates";
import { listForBase as listEmailTemplatesForBase } from "../service/email-templates";
import { listByTable as listFieldsByTable } from "../service/field-read";
import { type PublicResourceType, projectPublicIds, resolvePublicId, resolvePublicIds } from "../service/public-resources";
import { listByBase as listTablesByBase } from "../service/tables";
import { buildWorkflowCatalog, type WorkflowCatalog, type WorkflowCatalogEntry } from "../service/workflow-catalog";
import { listWorkflowScopes, listWorkflows } from "../service/workflow-definitions";
import { bindGridsWorkflow } from "../workflows/binder";
import { presentWorkflowCompletions } from "../workflows/completion-presentation";
import type {
  GridsWorkflow,
  GridsWorkflowEmailDelivery,
  GridsWorkflowLauncher,
  GridsWorkflowRevision,
  GridsWorkflowRun,
  GridsWorkflowRunStats,
  GridsWorkflowStepRun,
  WorkflowCompletionItem,
  WorkflowTriggerRuntimeState,
} from "../workflows/contracts";
import { gridsWorkflows } from "../workflows/module";
import { projectDocuments } from "./documents-api-shared";
import { currentWorkflowPrincipal, gateAt } from "./permissions";
import {
  PublicGridsWorkflowEmailDeliveryListSchema,
  PublicGridsWorkflowLauncherSchema,
  PublicGridsWorkflowRevisionListSchema,
  PublicGridsWorkflowRevisionSchema,
  PublicGridsWorkflowRunListSchema,
  PublicGridsWorkflowRunSchema,
  PublicGridsWorkflowRunStatsSchema,
  PublicGridsWorkflowSchema,
  PublicGridsWorkflowStepRunListSchema,
  PublicWorkflowDocumentListSchema,
  PublicWorkflowInvocationReceiptSchema,
  PublicWorkflowTriggerRuntimeStateSchema,
} from "./workflow-public-contracts";

export * from "./workflow-public-contracts";

type PublicIdLoader = typeof projectPublicIds;
type PublicIdMaps = Partial<Record<PublicResourceType, Map<string, string>>>;

const requiredPublicId = (maps: PublicIdMaps, type: PublicResourceType, internalId: string): string => {
  const publicId = maps[type]?.get(internalId);
  if (!publicId) throw new Error(`Missing public id for ${type} ${internalId}`);
  return publicId;
};

const optionalPublicId = (maps: PublicIdMaps, type: PublicResourceType, internalId: string | null): string | null =>
  internalId === null ? null : requiredPublicId(maps, type, internalId);

const loadPublicIdMaps = async (
  references: Partial<Record<PublicResourceType, readonly string[]>>,
  load: PublicIdLoader = projectPublicIds,
): Promise<PublicIdMaps> =>
  Object.fromEntries(
    await Promise.all(Object.entries(references).map(async ([type, ids]) => [type, await load(type as PublicResourceType, ids)] as const)),
  );

const gridsPlanResourceTypes: readonly PublicResourceType[] = [
  "base",
  "table",
  "field",
  "record",
  "comment",
  "file",
  "view",
  "form",
  "documentTemplate",
  "document",
  "documentSnapshot",
  "documentLink",
  "emailTemplate",
  "customApp",
  "workflow",
  "workflowLauncher",
  "workflowRun",
];

const collectUuidStrings = (value: unknown, into = new Set<string>()): Set<string> => {
  if (typeof value === "string") {
    if (z.string().uuid().safeParse(value).success) into.add(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectUuidStrings(item, into);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectUuidStrings(item, into);
  }
  return into;
};

const projectJsonIds = (value: unknown, ids: ReadonlyMap<string, string>): unknown => {
  if (typeof value === "string") return ids.get(value) ?? value;
  if (Array.isArray(value)) return value.map((item) => projectJsonIds(item, ids));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, projectJsonIds(item, ids)]));
};

const publicPlans = async (plans: readonly unknown[], load: PublicIdLoader): Promise<unknown[]> => {
  const collected = new Set<string>();
  for (const plan of plans) collectUuidStrings(plan, collected);
  const internalIds = [...collected];
  if (internalIds.length === 0) return [...plans];
  const maps = await Promise.all(gridsPlanResourceTypes.map((type) => load(type, internalIds)));
  const ids = new Map(maps.flatMap((map) => [...map]));
  return plans.map((plan) => projectJsonIds(plan, ids));
};

export const toPublicWorkflowPlan = async (plan: unknown, load: PublicIdLoader = projectPublicIds) => (await publicPlans([plan], load))[0];

export const toPublicWorkflows = async (workflows: readonly GridsWorkflow[], load: PublicIdLoader = projectPublicIds) => {
  const [maps, plans] = await Promise.all([
    loadPublicIdMaps({ base: workflows.map((workflow) => workflow.baseId) }, load),
    publicPlans(
      workflows.map((workflow) => workflow.plan),
      load,
    ),
  ]);
  return workflows.map((workflow, index) =>
    PublicGridsWorkflowSchema.parse({
      id: workflow.shortId,
      baseId: requiredPublicId(maps, "base", workflow.baseId),
      name: workflow.name,
      description: workflow.description,
      source: workflow.source,
      plan: plans[index],
      diagnostics: workflow.diagnostics,
      enabled: workflow.enabled,
      position: workflow.position,
      revision: workflow.revision,
      ownerUserId: workflow.ownerUserId,
      deletedAt: workflow.deletedAt,
      createdAt: workflow.createdAt,
      updatedAt: workflow.updatedAt,
    }),
  );
};

export const toPublicWorkflow = async (workflow: GridsWorkflow, load: PublicIdLoader = projectPublicIds) =>
  (await toPublicWorkflows([workflow], load))[0]!;

export const toPublicWorkflowRevision = async (
  revision: GridsWorkflowRevision,
  workflowPublicId: string,
  load: PublicIdLoader = projectPublicIds,
) =>
  PublicGridsWorkflowRevisionSchema.parse({
    workflowId: workflowPublicId,
    revision: revision.revision,
    name: revision.name,
    description: revision.description,
    source: revision.source,
    plan: (await publicPlans([revision.plan], load))[0],
    diagnostics: revision.diagnostics,
    position: revision.position,
    actorUserId: revision.actorUserId,
    createdAt: revision.createdAt,
  });

export const toPublicWorkflowRevisionList = (
  page: {
    items: Array<Pick<GridsWorkflowRevision, "workflowId" | "revision" | "name" | "actorUserId" | "createdAt">>;
    nextRevision: number | null;
  },
  workflowPublicId: string,
) =>
  PublicGridsWorkflowRevisionListSchema.parse({
    items: page.items.map((revision) => ({
      workflowId: workflowPublicId,
      revision: revision.revision,
      name: revision.name,
      actorUserId: revision.actorUserId,
      createdAt: revision.createdAt,
    })),
    nextRevision: page.nextRevision,
  });

export const toPublicWorkflowTriggerState = async (state: WorkflowTriggerRuntimeState, load: PublicIdLoader = projectPublicIds) => {
  const maps = await loadPublicIdMaps({ table: state.recordEvents.flatMap((event) => (event.tableId ? [event.tableId] : [])) }, load);
  return PublicWorkflowTriggerRuntimeStateSchema.parse({
    schedule: state.schedule
      ? {
          cron: state.schedule.cron,
          timezone: state.schedule.timezone,
          state: state.schedule.state,
          nextRunAt: state.schedule.nextRunAt,
          problem: state.schedule.problem,
        }
      : null,
    recordEvents: state.recordEvents.map((event) => ({
      tableId: optionalPublicId(maps, "table", event.tableId),
      event: event.event,
      hasFilter: event.hasFilter,
      state: event.state,
    })),
  });
};

export const toPublicWorkflowLaunchers = async (launchers: readonly GridsWorkflowLauncher[], load: PublicIdLoader = projectPublicIds) => {
  const maps = await loadPublicIdMaps(
    {
      base: launchers.map((launcher) => launcher.baseId),
      workflow: launchers.map((launcher) => launcher.workflowId),
    },
    load,
  );
  return launchers.map((launcher) =>
    PublicGridsWorkflowLauncherSchema.parse({
      id: launcher.shortId,
      baseId: requiredPublicId(maps, "base", launcher.baseId),
      workflowId: requiredPublicId(maps, "workflow", launcher.workflowId),
      name: launcher.name,
      config: launcher.config,
      enabled: launcher.enabled,
      validatedRevision: launcher.validatedRevision,
      diagnostics: launcher.diagnostics,
      deletedAt: launcher.deletedAt,
      createdAt: launcher.createdAt,
      updatedAt: launcher.updatedAt,
    }),
  );
};

export const toPublicWorkflowLauncher = async (launcher: GridsWorkflowLauncher, load: PublicIdLoader = projectPublicIds) =>
  (await toPublicWorkflowLaunchers([launcher], load))[0]!;

export const toPublicWorkflowRuns = async (runs: readonly GridsWorkflowRun[], load: PublicIdLoader = projectPublicIds) => {
  const [maps, payloads] = await Promise.all([
    loadPublicIdMaps(
      {
        workflowRun: runs.map((run) => run.id),
        workflow: runs.flatMap((run) => (run.workflowId ? [run.workflowId] : [])),
        workflowLauncher: runs.flatMap((run) => (run.launcherId ? [run.launcherId] : [])),
        base: runs.map((run) => run.baseId),
      },
      load,
    ),
    publicPlans(
      runs.map((run) => ({ inputs: run.inputs, result: run.result, errorDetails: run.error?.details ?? null })),
      load,
    ),
  ]);
  return runs.map((run, index) => {
    const payload = z
      .object({
        inputs: z.record(z.string(), z.json()),
        result: z.json().nullable(),
        errorDetails: z.record(z.string(), z.json()).nullable(),
      })
      .parse(payloads[index]);
    return PublicGridsWorkflowRunSchema.parse({
      id: requiredPublicId(maps, "workflowRun", run.id),
      workflowId: optionalPublicId(maps, "workflow", run.workflowId),
      launcherId: optionalPublicId(maps, "workflowLauncher", run.launcherId),
      baseId: requiredPublicId(maps, "base", run.baseId),
      workflowRevision: run.workflowRevision,
      mode: run.mode,
      channel: run.channel,
      actorUserId: run.actorUserId,
      serviceAccountId: run.serviceAccountId,
      inputs: payload.inputs,
      status: run.status,
      result: payload.result,
      error: run.error
        ? {
            code: run.error.code,
            message: run.error.message,
            retryable: run.error.retryable,
            ...(payload.errorDetails ? { details: payload.errorDetails } : { details: undefined }),
          }
        : null,
      resultMessage: run.resultMessage,
      createdAt: run.createdAt,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
    });
  });
};

export const toPublicWorkflowRun = async (run: GridsWorkflowRun, load: PublicIdLoader = projectPublicIds) =>
  (await toPublicWorkflowRuns([run], load))[0]!;

const publicCursor = (cursor: string | null): string | null => (cursor ? Buffer.from(cursor).toString("base64url") : null);

export const toPublicWorkflowRunPage = async (
  page: { items: GridsWorkflowRun[]; nextCursor: string | null },
  load: PublicIdLoader = projectPublicIds,
) =>
  PublicGridsWorkflowRunListSchema.parse({
    items: await toPublicWorkflowRuns(page.items, load),
    nextCursor: publicCursor(page.nextCursor),
  });

export const toPublicWorkflowSteps = async (
  page: { items: GridsWorkflowStepRun[]; truncated: boolean },
  runPublicId: string,
  load: PublicIdLoader = projectPublicIds,
) => {
  const outcomes = await publicPlans(
    page.items.map((step) => step.outcome),
    load,
  );
  return PublicGridsWorkflowStepRunListSchema.parse({
    items: page.items.map((step, index) => ({
      runId: runPublicId,
      key: step.key,
      sourcePath: step.sourcePath,
      iterationPath: step.iterationPath,
      kind: step.kind,
      action: step.action,
      status: step.status,
      outcome: z.json().nullable().parse(outcomes[index]),
      executionGeneration: step.executionGeneration,
      startedAt: step.startedAt,
      finishedAt: step.finishedAt,
    })),
    truncated: page.truncated,
  });
};

export const toPublicWorkflowStats = async (stats: GridsWorkflowRunStats, load: PublicIdLoader = projectPublicIds) => {
  const maps = await loadPublicIdMaps({ workflow: stats.byWorkflow.map((item) => item.workflowId) }, load);
  return PublicGridsWorkflowRunStatsSchema.parse({
    window: stats.window,
    total: stats.total,
    active: stats.active,
    queued: stats.queued,
    running: stats.running,
    waiting: stats.waiting,
    succeeded: stats.succeeded,
    failed: stats.failed,
    canceled: stats.canceled,
    needsAttention: stats.needsAttention,
    errorRate: stats.errorRate,
    avgDurationMs: stats.avgDurationMs,
    p99DurationMs: stats.p99DurationMs,
    lastRunAt: stats.lastRunAt,
    failedLast24h: stats.failedLast24h,
    byWorkflow: stats.byWorkflow.map((item) => ({
      workflowId: requiredPublicId(maps, "workflow", item.workflowId),
      total: item.total,
      active: item.active,
      queued: item.queued,
      running: item.running,
      waiting: item.waiting,
      succeeded: item.succeeded,
      failed: item.failed,
      canceled: item.canceled,
      needsAttention: item.needsAttention,
      errorRate: item.errorRate,
      avgDurationMs: item.avgDurationMs,
      p99DurationMs: item.p99DurationMs,
      lastRunAt: item.lastRunAt,
      latestStatus: item.latestStatus,
    })),
  });
};

export const toPublicWorkflowDeliveries = async (
  page: { items: GridsWorkflowEmailDelivery[]; nextCursor: string | null },
  load: PublicIdLoader = projectPublicIds,
) => {
  const maps = await loadPublicIdMaps(
    {
      workflow: page.items.flatMap((item) => (item.workflowId ? [item.workflowId] : [])),
      workflowRun: page.items.flatMap((item) => (item.workflowRunId ? [item.workflowRunId] : [])),
      emailTemplate: page.items.flatMap((item) => (item.templateId ? [item.templateId] : [])),
    },
    load,
  );
  return PublicGridsWorkflowEmailDeliveryListSchema.parse({
    items: page.items.map((item) => ({
      workflowId: optionalPublicId(maps, "workflow", item.workflowId),
      workflowRunId: optionalPublicId(maps, "workflowRun", item.workflowRunId),
      templateId: optionalPublicId(maps, "emailTemplate", item.templateId),
      subject: item.subject,
      recipients: item.recipients.map((recipient) => ({
        kind: recipient.kind,
        recipient: recipient.recipient,
        ...(recipient.notificationId ? { notificationId: recipient.notificationId } : {}),
        ...(recipient.status ? { status: recipient.status } : {}),
      })),
      status: item.status,
      error: item.error,
      createdAt: item.createdAt,
    })),
    nextCursor: publicCursor(page.nextCursor),
  });
};

export const toPublicDocuments = async (page: DocumentSummaryList) => {
  return PublicWorkflowDocumentListSchema.parse({
    items: await projectDocuments(page.items),
    total: page.total ?? page.items.length,
    hasMore: page.hasMore ?? false,
    nextOffset: page.nextOffset ?? null,
  });
};

export const toPublicWorkflowReceipt = async (receipt: WorkflowInvocationReceipt, load: PublicIdLoader = projectPublicIds) => {
  const maps = await loadPublicIdMaps({ workflowRun: [receipt.runId], workflow: [receipt.workflowId] }, load);
  return PublicWorkflowInvocationReceiptSchema.parse({
    runId: requiredPublicId(maps, "workflowRun", receipt.runId),
    workflowId: requiredPublicId(maps, "workflow", receipt.workflowId),
    revision: receipt.revision,
    mode: receipt.mode,
    channel: receipt.channel,
    created: receipt.created,
    status: receipt.status,
  });
};

export const resolveWorkflowFilterId = (publicId: string | undefined) =>
  publicId === undefined ? Promise.resolve(undefined) : resolvePublicId("workflow", publicId).then((id) => id ?? null);

export const resolveBulkRecordIds = async (publicIds: readonly string[]): Promise<string[] | null> => {
  const resolved = await resolvePublicIds("record", publicIds);
  const ids = publicIds.map((id) => resolved.get(id));
  return ids.every((id): id is string => Boolean(id)) ? ids : null;
};

export const canReadWorkflow = async (c: Context<AuthContext>, workflow: { baseId: string; id: string }): Promise<boolean> => {
  const gate = await gateAt(c, { baseId: workflow.baseId }, "read");
  return gate.ok;
};

const readableWorkflowIds = async (
  c: Context<AuthContext>,
  baseId: string,
  workflows: Array<{ id: string; baseId: string }>,
): Promise<Set<string>> => {
  const gate = await gateAt(c, { baseId }, "read");
  return gate.ok ? new Set(workflows.filter((workflow) => workflow.baseId === baseId).map((workflow) => workflow.id)) : new Set();
};

export const visibleWorkflowsForBase = async (c: Context<AuthContext>, baseId: string, options: { includeDeleted?: boolean } = {}) => {
  const workflows = await listWorkflows(baseId, false, options.includeDeleted);
  const visibleIds = await readableWorkflowIds(c, baseId, workflows);
  return workflows.filter((workflow) => visibleIds.has(workflow.id));
};

export const visibleWorkflowIdsForBase = async (
  c: Context<AuthContext>,
  baseId: string,
  options: { includeDeleted?: boolean } = {},
): Promise<string[]> => {
  const workflows = await listWorkflowScopes(baseId, options.includeDeleted);
  return [...(await readableWorkflowIds(c, baseId, workflows))];
};

type WorkflowCatalogDeps = {
  listTablesByBase: typeof listTablesByBase;
  listTemplatesForTable: typeof listTemplatesForTable;
  listFieldsByTable: typeof listFieldsByTable;
  listEmailTemplatesForBase: typeof listEmailTemplatesForBase;
};

const workflowCatalogDeps: WorkflowCatalogDeps = {
  listTablesByBase,
  listTemplatesForTable,
  listFieldsByTable,
  listEmailTemplatesForBase,
};

export const permissionedWorkflowCatalog = async (
  c: Context<AuthContext>,
  baseId: string,
  deps: WorkflowCatalogDeps = workflowCatalogDeps,
): Promise<WorkflowCatalog> => {
  const gate = await gateAt(c, { baseId }, "read");
  if (!gate.ok) return buildWorkflowCatalog({ tables: [], fieldsByTable: new Map(), templates: [], emailTemplates: [] });
  const visibleTables = [];
  const fieldsByTable = new Map<
    string,
    Array<{
      id: string;
      shortId: string;
      name: string;
      relation?: { targetTableId: string; cardinality: "single" | "multiple" };
    }>
  >();
  const templates = [];
  const emailTemplates = [];
  for (const table of await deps.listTablesByBase(baseId)) {
    for (const template of await deps.listTemplatesForTable(table.id)) {
      templates.push({ id: template.id, shortId: template.shortId, name: template.name, tableId: template.tableId });
    }
    visibleTables.push({ id: table.id, shortId: table.shortId, name: table.name, kind: table.kind });
    const fields = await deps.listFieldsByTable(table.id);
    fieldsByTable.set(
      table.id,
      fields
        .filter((field) => !field.deletedAt)
        .map((field) => {
          const config = field.config as { targetTableId?: unknown; cardinality?: unknown };
          const relation =
            field.type === "relation" && typeof config.targetTableId === "string"
              ? {
                  targetTableId: config.targetTableId,
                  cardinality: config.cardinality === "single" ? ("single" as const) : ("multiple" as const),
                }
              : undefined;
          return { id: field.id, shortId: field.shortId, name: field.name, ...(relation ? { relation } : {}) };
        }),
    );
  }
  for (const template of await deps.listEmailTemplatesForBase(baseId)) {
    if (template.enabled) emailTemplates.push({ id: template.id, shortId: template.shortId, name: template.name });
  }
  return buildWorkflowCatalog({ tables: visibleTables, fieldsByTable, templates, emailTemplates });
};

export const validatePermissionedWorkflowSource = async (
  c: Context<AuthContext>,
  baseId: string,
  source: string,
  catalog?: WorkflowCatalog,
) => {
  const compiled = await compileWorkflow(source, gridsWorkflows);
  if (!compiled.ok) return compiled;
  return bindGridsWorkflow(compiled.ir, catalog ?? (await permissionedWorkflowCatalog(c, baseId)));
};

const uniqueEntries = <T extends WorkflowCatalogEntry>(index: { refs: Map<string, T> }): T[] =>
  [...new Map([...index.refs.values()].map((entry) => [entry.id, entry])).values()].sort(
    (left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
  );

export const buildWorkflowCompletions = (
  source: string,
  caret: number,
  catalog: WorkflowCatalog,
  locale?: string,
): WorkflowCompletionItem[] => {
  const context = workflowCompletionContext(source, caret);

  if (context.key === "table") {
    return presentWorkflowCompletions(
      uniqueEntries(catalog.tables).map((entry) =>
        workflowCompletionItem(context, "source", entry.name, entry.name, `Table ${entry.shortId}`),
      ),
      locale,
    );
  }
  if (context.key === "field") {
    const fields = [...catalog.fieldsByTable.values()].flatMap(uniqueEntries);
    return presentWorkflowCompletions(
      [...new Map(fields.map((entry) => [entry.id, entry])).values()].map((entry) =>
        workflowCompletionItem(context, "field", entry.name, entry.name, `Field ${entry.shortId}`),
      ),
      locale,
    );
  }
  if (context.key === "template") {
    return presentWorkflowCompletions(
      [
        ...uniqueEntries(catalog.templates).map((entry) =>
          workflowCompletionItem(context, "source", entry.name, entry.name, "Document template"),
        ),
        ...uniqueEntries(catalog.emailTemplates).map((entry) =>
          workflowCompletionItem(context, "source", entry.name, entry.name, "Email template"),
        ),
      ],
      locale,
    );
  }
  return presentWorkflowCompletions(buildWorkflowManifestCompletions(source, caret, gridsWorkflows), locale);
};

export const baseExists = async (baseId: string): Promise<boolean> => Boolean(await getBase(baseId));

export const workflowPrincipal = (c: Context<AuthContext>) => {
  return currentWorkflowPrincipal(c);
};
