import { expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import "../ssr-test-plugin";

const { default: DocumentsWorkspace } = await import("./DocumentsWorkspace");
const { default: DocumentBrowser } = await import("./DocumentBrowser");
const { DEFAULT_DOCUMENT_CATALOG_STATE } = await import("./document-catalog-url-state");

test("document errors appear once and preserve distinct details", () => {
  const renderError = (message: string) =>
    renderToString(() =>
      createComponent(DocumentBrowser, {
        loading: false,
        error: new Error(message),
        mode: "list",
        searching: false,
        folders: [],
        documents: [],
        breadcrumbs: [],
        emptyText: "",
        hasMore: false,
        loadingMore: false,
        busyDocumentId: null,
        canWrite: false,
        folderTitle: (folder) => folder.label,
        onBreadcrumb: () => {},
        onFolder: () => {},
        onDocument: () => {},
        onEdit: () => {},
        onLink: () => {},
        onDownload: () => {},
        onLoadMore: () => {},
      }),
    );
  const title = "Could not load generated documents";
  expect(renderError(title).split(title)).toHaveLength(2);
  expect(renderError("Request timed out")).toContain("Request timed out");
  expect(renderError("Request timed out")).toContain(title);
});

test("All documents renders its initial folders and search field on the server", () => {
  const html = renderToString(() =>
    createComponent(DocumentsWorkspace, {
      baseId: "BASE01",
      canWriteDocuments: false,
      documentTemplateLevels: {},
      linkableWorkflowIds: [],
      initialCatalog: DEFAULT_DOCUMENT_CATALOG_STATE,
      facets: { workflows: [], templates: [], tables: [], mediaTypes: [] },
      initialBrowserPage: {
        items: [],
        path: [],
        cursor: null,
        hasMore: false,
        folders: [{ kind: "template", key: "TMPL01", label: "Demo invoices", path: ["TMPL01"], count: 3 }],
      },
    }),
  );
  expect(html).toContain("Demo invoices");
  expect(html).toContain('type="search"');
  expect(html).toContain("Folders");
  expect(html).not.toContain("Loading documents");
});

test("All documents renders filtered rows with their file type and a link to the workflow run", () => {
  const document = {
    id: "DOC001",
    baseId: "BASE01",
    tableId: null,
    recordId: null,
    templateId: null,
    workflowId: "FLOW01",
    workflowRunId: "RUN001",
    number: "ZIP-1",
    filename: "bundle.zip",
    createdAt: "2026-09-01T10:00:00.000Z",
    tags: [],
    createdBy: null,
    renderer: { kind: "profile" as const, id: "grids.zip", version: 1 },
    validationStatus: "valid" as const,
    artifacts: [
      {
        key: "zip",
        filename: "bundle.zip",
        mimeType: "application/zip",
        sizeBytes: 22,
        sha256: "a".repeat(64),
        downloadUrl: "/api/grids/documents/DOC001/artifacts/zip",
      },
    ],
    primaryArtifactKey: "zip",
    downloadUrl: "/api/grids/documents/DOC001/download",
    sourceRecordCount: null,
    dataSnapshot: null,
  };
  const html = renderToString(() =>
    createComponent(DocumentsWorkspace, {
      baseId: "BASE01",
      canWriteDocuments: false,
      documentTemplateLevels: {},
      linkableWorkflowIds: ["FLOW01"],
      initialCatalog: { ...DEFAULT_DOCUMENT_CATALOG_STATE, workflow: "FLOW01", mediaType: "application/zip" },
      facets: { workflows: [{ id: "FLOW01", name: "Monthly export" }], templates: [], tables: [], mediaTypes: ["application/zip"] },
      initialBrowserPage: { items: [document], path: [], cursor: null, hasMore: false, folders: [] },
    }),
  );
  expect(html).toContain("bundle.zip");
  expect(html).toContain("Monthly export");
  expect(html).toContain("/app/grids/BASE01/workflows/FLOW01?run=RUN001");
  expect(html).toContain("File type");
  expect(html).not.toContain("Record table");
  expect(html).not.toContain("ti-file-type-pdf");
});
