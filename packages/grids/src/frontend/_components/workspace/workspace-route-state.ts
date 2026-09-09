import { resolveWorkspaceMessages } from "./messages";
import { loadDocumentsState, loadDocumentTemplateState } from "./workspace-document-state";
import { loadQueryState } from "./workspace-query-state";
import { loadRecordsState } from "./workspace-records-state";
import type { WorkspaceRequestContext } from "./workspace-request-state";
import { okState } from "./workspace-state-helpers";
import type { GridsWorkspaceState } from "./workspace-state-model";
import { loadWorkflowState } from "./workspace-workflow-state";

export const tableForPublicRouteId = <T extends { shortId: string }>(tables: readonly T[], id: string | null | undefined): T | null =>
  (id ? tables.find((table) => table.shortId === id) : null) ?? null;

export const loadWorkspaceRoute = async (request: WorkspaceRequestContext): Promise<GridsWorkspaceState> => {
  const { common } = request;
  const t = resolveWorkspaceMessages(common.params.locale);
  if (common.params.activeCustomAppSlug) {
    if (!request.requestedCustomApp) return { kind: "notFound", title: t.notFound, message: t.appNotFound };
    return okState(
      common,
      {
        kind: "customApp",
        app: request.requestedCustomApp,
        initialSettingsOpen: common.chrome.url.searchParams.get("settings") === "app",
      },
      [...common.chrome.titleBase, { title: request.requestedCustomApp.name }],
    );
  }
  const queryWorkspaceRequested = common.chrome.url.pathname.endsWith("/query");
  const workflowWorkspaceRequested = common.chrome.url.pathname.includes("/workflows");
  const activeTableFromSlug = request.requestedViewTable ?? tableForPublicRouteId(common.catalog.tables, common.params.activeTableSlug);

  if (common.params.documentsRequested) {
    return loadDocumentsState(common);
  }
  if (queryWorkspaceRequested) return loadQueryState(common, activeTableFromSlug, common.params.activeViewSlug);
  if (workflowWorkspaceRequested) {
    return loadWorkflowState(common, request.requestedWorkflow, common.params.activeWorkflowSlug);
  }
  if (common.params.activeDocumentTableSlug && common.params.activeDocumentTemplateSlug) {
    if (!request.requestedDocumentTable || !request.requestedDocumentTemplate) {
      return { kind: "notFound", title: t.notFound, message: t.documentTemplateNotFound };
    }
    return loadDocumentTemplateState(common, request.requestedDocumentTable, request.requestedDocumentTemplate);
  }

  if (!common.params.activeTableSlug && !common.params.activeViewSlug) return okState(common, { kind: "overview" });
  const activeTable = activeTableFromSlug ?? null;
  if (!activeTable) return okState(common, { kind: "empty" });
  return loadRecordsState(common, activeTable, common.params.activeViewSlug);
};
