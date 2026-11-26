import { expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import "../ssr-test-plugin";

const { default: DocumentTemplateScreen, parseTemplateDocumentsState, templateDocumentsHref } = await import("./DocumentTemplateScreen");
const { testFrame } = await import("../records-view/records-frame.test-fixture");

const table = {
  id: "TBL001",
  baseId: "BASE01",
  name: "Orders",
  description: null,
  icon: null,
  kind: "stored" as const,
  columns: [],
  displayConfig: { mode: "table" as const },
  auditPolicy: {},
  mutationPolicy: { mode: "all" as const },
  position: 0,
  disableDirectInsert: false,
  createdAt: "2026-08-02T00:00:00.000Z",
  updatedAt: "2026-08-02T00:00:00.000Z",
  deletedAt: null,
};

const render = (state: { mode: "list" | "folders"; q: string; path: string[] }, folders = false) =>
  renderToString(() =>
    createComponent(DocumentTemplateScreen, {
      frame: testFrame(),
      baseId: "BASE01",
      table,
      template: {
        id: "TPL001",
        tableId: "TBL001",
        name: "Invoice",
        description: null,
        enabled: true,
        issuancePolicy: "repeatable",
        position: 0,
        createdAt: "2026-08-02T00:00:00.000Z",
        updatedAt: "2026-08-02T00:00:00.000Z",
        renderer: { kind: "html" },
      },
      editableTemplate: null,
      canWriteTemplate: true,
      initialRecordId: null,
      initialState: state,
      initialBrowserPage: {
        items: [],
        path: state.path,
        cursor: null,
        hasMore: false,
        folders: folders ? [{ kind: "year", key: "2026", label: "2026", path: ["2026"], count: 4 }] : [],
      },
    }),
  );

test("the documents of a template render their years on the server, each a link in the address", () => {
  const html = render({ mode: "folders", q: "", path: [] }, true);
  expect(html).toContain('href="/app/grids/BASE01/document/TBL001/TPL001?mode=folders&amp;path=2026"');
  expect(html).toContain("Generate Document");
  expect(html).not.toContain('data-k2-part="Loading"');
});

test("the address holds the view, the search and the open month; a search lists", () => {
  const read = (search: string) => parseTemplateDocumentsState(new URLSearchParams(search), "list");
  expect(read("mode=folders&path=2026/11/extra")).toEqual({ mode: "folders", q: "", path: ["2026", "11"] });
  expect(read("q=R-12&mode=folders&path=2026")).toEqual({ mode: "list", q: "R-12", path: [] });
  expect(read("")).toEqual({ mode: "list", q: "", path: [] });
  expect(templateDocumentsHref("/t", { mode: "folders", q: "", path: ["2026", "11"] })).toBe("/t?mode=folders&path=2026%2F11");
  expect(templateDocumentsHref("/t", { mode: "list", q: "R-12", path: [] })).toBe("/t?q=R-12");
});
