import { PUBLIC_DOCUMENT_PAGE_LIMIT } from "../../../api/document-public-contracts";
import type { DocumentTemplate } from "../../../contracts";
import type { Table } from "../../../service";
import { gridsService } from "../../../service";
import { resolveBaseLevel } from "./workspace-state-access";
import { okState } from "./workspace-state-helpers";
import type { GridsWorkspaceState, OkWorkspaceState, WorkspaceCommon } from "./workspace-state-model";

export const loadDocumentTemplateState = async (
  common: WorkspaceCommon,
  table: Table,
  template: DocumentTemplate,
): Promise<OkWorkspaceState | Extract<GridsWorkspaceState, { kind: "accessDenied" }>> => {
  const level = await resolveBaseLevel(common.params.user, common.base.id);
  if (!gridsService.permission.hasAtLeast(level, "read")) {
    return { kind: "accessDenied", title: "Access denied", message: "No access to this document template" };
  }
  const canWriteTemplate = gridsService.permission.hasAtLeast(level, "write");
  const canManageTemplate = gridsService.permission.hasAtLeast(level, "admin");
  const initialDocumentViewMode = common.params.initialDocumentViewMode ?? "list";
  const initialBrowserPage = await gridsService.document.browseDocumentsForTemplate({
    templateId: template.id,
    q: "",
    tags: [],
    path: [],
    limit: PUBLIC_DOCUMENT_PAGE_LIMIT,
    cursor: null,
    timeZone: common.params.dateConfig?.timeZone,
    mode: initialDocumentViewMode,
  });
  return okState(
    common,
    {
      kind: "documentTemplate",
      table,
      template: gridsService.document.summarizeTemplate(template),
      editableTemplate: canManageTemplate ? template : null,
      canWriteTemplate,
      canManageTemplate,
      initialRecordId: common.chrome.url.searchParams.get("record"),
      initialDocumentViewMode,
      initialBrowserPage: {
        path: initialBrowserPage.path,
        folders: initialBrowserPage.folders,
        items: initialBrowserPage.items.map(gridsService.document.summarizeDocument),
        total: initialBrowserPage.total,
        limit: initialBrowserPage.limit,
        hasMore: initialBrowserPage.hasMore,
        nextCursor: initialBrowserPage.nextCursor,
      },
    },
    [...common.chrome.titleBase, { title: "Documents" }, { title: template.name }],
  );
};
