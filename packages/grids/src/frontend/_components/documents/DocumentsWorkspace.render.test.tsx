import { expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import "../ssr-test-plugin";

const { default: DocumentsWorkspace } = await import("./DocumentsWorkspace");
const { default: DocumentBrowser } = await import("./DocumentBrowser");

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
      documentTemplateLevels: {},
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
