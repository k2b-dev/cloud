import { z } from "zod";
import type { Workflow } from "../../../service";
import { gridsService } from "../../../service";
import type { DocumentReadAuthorizer } from "../../../service/document-browse";
import type { ExpansionViewer } from "../../../service/relation-access";
import { buildRelationLabelCacheForIds } from "../../../service/relation-labels";
import {
  getWorkflowRunProvenance,
  getWorkflowRunStats,
  listWorkflowRunsPage,
  listWorkflowStepRunsPage,
} from "../../../service/workflow-runs";
import { getWorkflowTriggerRuntimeState } from "../../../service/workflow-runtime";
import type { GridsWorkflowRun } from "../../../workflows/contracts";
import { parseWorkflowUrlState } from "../workflows/workflow-url-state";
import { resolveBaseLevel } from "./workspace-state-access";
import { buildViewer, okState } from "./workspace-state-helpers";
import type { GridsWorkspaceState, WorkspaceCommon, WorkspaceWorkflowRunDetail } from "./workspace-state-model";

const WORKFLOW_PAGE_SIZE = 50;
const RUN_DOCUMENT_LIMIT = 100;
const uuidSchema = z.string().uuid();

export const workflowOverviewRedirectHref = (currentUrl: URL, baseShortId: string, workflowShortId: string): string => {
  const url = new URL(currentUrl);
  url.pathname = `/app/grids/${encodeURIComponent(baseShortId)}/workflows/${encodeURIComponent(workflowShortId)}`;
  url.searchParams.delete("run");
  return `${url.pathname}${url.search}`;
};

export const collectWorkflowRunInputRecordIds = (
  run: Pick<GridsWorkflowRun, "inputs">,
  workflow: Pick<Workflow, "plan">,
): Map<string, Set<string>> => {
  const idsByTable = new Map<string, Set<string>>();
  for (const input of workflow.plan.inputs) {
    if (input.type !== "record" && input.type !== "recordList") continue;
    const tableId = workflow.plan.bindings[`inputs.${input.name}.table`];
    if (typeof tableId !== "string" || !uuidSchema.safeParse(tableId).success) continue;
    const rawValue = run.inputs[input.name];
    const ids = idsByTable.get(tableId) ?? new Set<string>();
    for (const value of Array.isArray(rawValue) ? rawValue : [rawValue]) {
      if (typeof value === "string" && uuidSchema.safeParse(value).success) ids.add(value);
    }
    if (ids.size > 0) idsByTable.set(tableId, ids);
  }
  return idsByTable;
};

const workflowRunInputLabels = async (
  run: GridsWorkflowRun,
  workflow: Workflow | null,
  viewer: ExpansionViewer | undefined,
): Promise<Record<string, string>> => {
  if (!workflow || !viewer) return {};
  return buildRelationLabelCacheForIds(collectWorkflowRunInputRecordIds(run, workflow), viewer);
};

export const loadWorkflowRunDetail = async (
  run: GridsWorkflowRun,
  options: { canReadDocument: DocumentReadAuthorizer; workflow?: Workflow | null; viewer?: ExpansionViewer },
): Promise<WorkspaceWorkflowRunDetail> => {
  const [stepPage, documents, provenance, inputLabels] = await Promise.all([
    listWorkflowStepRunsPage(run.id),
    gridsService.document.listDocumentsForWorkflow(run.id, { limit: RUN_DOCUMENT_LIMIT }, options.canReadDocument),
    getWorkflowRunProvenance(run.id),
    workflowRunInputLabels(run, options.workflow ?? null, options.viewer),
  ]);
  return {
    run,
    inputLabels,
    provenance,
    steps: stepPage.items,
    stepsTruncated: stepPage.truncated,
    documents: {
      items: documents.items,
      total: documents.total ?? documents.items.length,
      hasMore: documents.hasMore ?? false,
      nextOffset: documents.nextOffset ?? null,
    },
  };
};

const loadSelectedRun = async (
  selectedRunId: string | null,
  workflows: Workflow[],
  viewer: ExpansionViewer,
  canReadDocument: DocumentReadAuthorizer,
): Promise<WorkspaceWorkflowRunDetail | null> => {
  if (!selectedRunId || !z.string().uuid().safeParse(selectedRunId).success) return null;
  const run = await gridsService.workflow.getRun(selectedRunId);
  if (!run?.workflowId) return null;
  const workflow = workflows.find((item) => item.id === run.workflowId);
  if (!workflow) return null;
  return loadWorkflowRunDetail(run, { canReadDocument, workflow, viewer });
};

const workflowDocumentAuthorizer =
  (common: WorkspaceCommon): DocumentReadAuthorizer =>
  async (document) => {
    if (document.baseId !== common.base.id) return false;
    const level = await resolveBaseLevel(common.params.user, document.baseId);
    return gridsService.permission.hasAtLeast(level, "read");
  };

export const loadWorkflowState = async (
  common: WorkspaceCommon,
  requestedWorkflow: Workflow | null,
  activeWorkflowSlug?: string | null,
): Promise<GridsWorkspaceState> => {
  if (activeWorkflowSlug && !requestedWorkflow) {
    return { kind: "notFound", title: "Not found", message: "Workflow not found" };
  }
  const activeWorkflow = requestedWorkflow
    ? (common.catalog.workflows.find((workflow) => workflow.id === requestedWorkflow.id) ?? null)
    : null;
  if (activeWorkflowSlug && !activeWorkflow) {
    return { kind: "accessDenied", title: "Access denied", message: "No access to this workflow" };
  }
  if (!common.canUseQueryWorkspace && common.catalog.workflows.length === 0) {
    return { kind: "accessDenied", title: "Access denied", message: "No access to workflows" };
  }
  if (!activeWorkflowSlug && common.catalog.workflows.length > 0) {
    const target = common.catalog.workflows[0]!;
    return {
      kind: "redirect",
      href: workflowOverviewRedirectHref(common.chrome.url, common.base.shortId, target.shortId),
    };
  }
  const level = activeWorkflow ? (common.catalog.workflowLevels[activeWorkflow.id] ?? "none") : "none";
  const selectedRunId = common.chrome.url.searchParams.get("run");
  const visibleWorkflowIds = common.catalog.workflows.map((workflow) => workflow.id);
  const filters = parseWorkflowUrlState(common.chrome.url.searchParams);
  const [stats, runs, launchers, triggerState, initialSelectedRun] = await Promise.all([
    getWorkflowRunStats(common.base.id, visibleWorkflowIds, { window: filters.window }),
    listWorkflowRunsPage({
      baseId: common.base.id,
      workflowIds: visibleWorkflowIds,
      workflowId: activeWorkflow?.id,
      status: filters.status === "all" ? undefined : filters.status,
      channel: filters.channel === "all" ? undefined : filters.channel,
      limit: WORKFLOW_PAGE_SIZE,
    }),
    activeWorkflow ? gridsService.workflow.launcher.list(activeWorkflow.id) : Promise.resolve([]),
    activeWorkflow ? getWorkflowTriggerRuntimeState(activeWorkflow) : Promise.resolve(null),
    loadSelectedRun(selectedRunId, common.catalog.workflows, buildViewer(common.params.user), workflowDocumentAuthorizer(common)),
  ]);
  return okState(
    common,
    {
      kind: "workflows",
      activeWorkflow,
      canRunActiveWorkflow: gridsService.permission.hasAtLeast(level, "write"),
      canManageActiveWorkflow: gridsService.permission.hasAtLeast(level, "admin"),
      selectedRunId: initialSelectedRun?.run.id ?? null,
      initialOverview: { filters, stats, runs, launchers, triggerState },
      initialSelectedRun,
    },
    [...common.chrome.titleBase, { title: "Workflows" }, ...(activeWorkflow ? [{ title: activeWorkflow.name }] : [])],
  );
};
