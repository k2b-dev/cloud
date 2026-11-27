import { PUBLIC_DOCUMENT_PAGE_LIMIT } from "../../../api/document-public-contracts";
import type { DocumentTemplate } from "../../../contracts";
import type { Table } from "../../../service";
import { gridsService } from "../../../service";
import { parseDocumentCatalogUrlState } from "../documents/document-catalog-url-state";
import { resolveWorkspaceMessages } from "./messages";
import { resolveBaseLevel } from "./workspace-state-access";
import { okState } from "./workspace-state-helpers";
import type { GridsWorkspaceState, OkWorkspaceState, WorkspaceCommon } from "./workspace-state-model";

export const loadDocumentTemplateState = async (
  common: WorkspaceCommon,
  table: Table,
  template: DocumentTemplate,
): Promise<OkWorkspaceState | Extract<GridsWorkspaceState, { kind: "accessDenied" }>> => {
  const t = resolveWorkspaceMessages(common.params.locale);
  const level = await resolveBaseLevel(common.params.user, common.base.id);
  if (!gridsService.permission.hasAtLeast(level, "read")) {
    return { kind: "accessDenied", title: t.accessDenied, message: t.noDocumentTemplateAccess };
  }
  const canWriteTemplate = gridsService.permission.hasAtLeast(level, "write");
  const canManageTemplate = gridsService.permission.hasAtLeast(level, "admin");
  // The address names the view, the search and the open folder; without them the view last chosen (a cookie) stands.
  const address = common.chrome.url.searchParams;
  const initialSearch = (address.get("q") ?? "").trim();
  const requested = address.get("mode");
  const initialDocumentViewMode = initialSearch
    ? "list"
    : requested === "folders" || requested === "list"
      ? requested
      : (common.params.initialDocumentViewMode ?? "list");
  const initialPath = initialDocumentViewMode === "folders" ? (address.get("path") ?? "").split("/").filter(Boolean).slice(0, 2) : [];
  const initialBrowserPage = await gridsService.document.browseDocumentsForTemplate({
    templateId: template.id,
    q: initialSearch,
    tags: [],
    path: initialPath,
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
      initialSearch,
      initialPath,
      initialBrowserPage,
    },
    [...common.chrome.titleBase, { title: t.documents }, { title: template.name }],
  );
};

export const loadDocumentsState = async (common: WorkspaceCommon): Promise<GridsWorkspaceState> => {
  const t = resolveWorkspaceMessages(common.params.locale);
  const level = await resolveBaseLevel(common.params.user, common.base.id);
  if (!gridsService.permission.hasAtLeast(level, "read")) {
    return { kind: "accessDenied", title: t.accessDenied, message: t.noDocumentTemplateAccess };
  }
  const catalog = parseDocumentCatalogUrlState(common.chrome.url.searchParams);
  const [initialBrowserPage, facets] = await Promise.all([
    gridsService.document.browseDocumentsForBase({
      baseId: common.base.id,
      q: catalog.q,
      mode: catalog.view,
      path: catalog.path,
      filters: { workflowId: catalog.workflow, templateId: catalog.template, tableId: catalog.table, mediaType: catalog.mediaType },
      sort: catalog.sort,
      limit: PUBLIC_DOCUMENT_PAGE_LIMIT,
      timeZone: common.params.dateConfig?.timeZone,
    }),
    gridsService.document.catalogFacets(common.base.id),
  ]);
  return okState(
    common,
    {
      kind: "documents",
      canWriteDocuments: gridsService.permission.hasAtLeast(level, "write"),
      initialCatalog: catalog,
      facets,
      initialBrowserPage,
    },
    [...common.chrome.titleBase, { title: t.documents }],
  );
};
