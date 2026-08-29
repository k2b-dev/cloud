import type { DocumentTemplate } from "../../../contracts";
import type { Base, CustomApp, Table, Workflow } from "../../../service";
import { gridsService } from "../../../service";
import { resolveWorkspaceMessages } from "./messages";
import { canUseEditModeForCatalog, loadCatalog } from "./workspace-catalog-state";
import { resolveBaseLevel } from "./workspace-state-access";
import { buildChrome } from "./workspace-state-helpers";
import type { GridsWorkspaceState, LoadWorkspaceParams, WorkspaceCommon } from "./workspace-state-model";

export type WorkspaceRequestContext = {
  common: WorkspaceCommon;
  requestedDocumentTable: Table | null;
  requestedDocumentTemplate: DocumentTemplate | null;
  requestedWorkflow: Workflow | null;
  requestedViewTable: Table | null;
  requestedCustomApp: CustomApp | null;
};

export const loadWorkspaceRequest = async (
  params: LoadWorkspaceParams,
  base: Base,
  eventCursors: { metadata: string | null; records: string | null },
): Promise<WorkspaceRequestContext | Extract<GridsWorkspaceState, { kind: "accessDenied" }>> => {
  const t = resolveWorkspaceMessages(params.locale);
  const level = await resolveBaseLevel(params.user, base.id);
  const canManageBase = gridsService.permission.hasAtLeast(level, "admin");
  const hasBaseRead = gridsService.permission.hasAtLeast(level, "read");
  if (!hasBaseRead) return { kind: "accessDenied", title: t.accessDenied, message: t.noBaseAccess };
  const catalog = await loadCatalog(base.id, params.user, canManageBase);
  if (params.activeCustomAppSlug && !canManageBase) {
    return { kind: "accessDenied", title: t.accessDenied, message: t.appAdminRequired };
  }
  const requestedCustomApp = params.activeCustomAppSlug
    ? await gridsService.customApp.getByShortIdForBase(base.id, params.activeCustomAppSlug)
    : null;
  const requestedDocumentTable =
    params.activeDocumentTableSlug && params.activeDocumentTemplateSlug
      ? await gridsService.table.getByShortIdForBase(base.id, params.activeDocumentTableSlug)
      : null;
  const requestedDocumentTemplate =
    requestedDocumentTable && params.activeDocumentTemplateSlug
      ? await gridsService.document.getTemplateByShortIdForTable(requestedDocumentTable.id, params.activeDocumentTemplateSlug)
      : null;
  const requestedWorkflow = params.activeWorkflowSlug
    ? await gridsService.workflow.getByShortIdForBase(base.id, params.activeWorkflowSlug)
    : null;
  const requestedViewTable =
    params.activeTableSlug && params.activeViewSlug ? await gridsService.table.getByShortIdForBase(base.id, params.activeTableSlug) : null;
  const requestedView =
    requestedViewTable && params.activeViewSlug
      ? await gridsService.view.getByShortIdForTable(requestedViewTable.id, params.activeViewSlug)
      : null;

  const canCreateTables = gridsService.permission.hasAtLeast(level, "write");
  return {
    common: {
      params,
      base,
      chrome: buildChrome(params.href, base, params.locale),
      catalog,
      canManageBase,
      canCreateTables,
      canUseEditMode: canUseEditModeForCatalog(catalog, params.user, canManageBase, canCreateTables),
      canUseQueryWorkspace: hasBaseRead,
      metadataEventCursor: eventCursors.metadata,
      recordEventCursor: eventCursors.records,
    },
    requestedDocumentTable,
    requestedDocumentTemplate,
    requestedWorkflow,
    requestedViewTable: requestedView ? requestedViewTable : null,
    requestedCustomApp,
  };
};
