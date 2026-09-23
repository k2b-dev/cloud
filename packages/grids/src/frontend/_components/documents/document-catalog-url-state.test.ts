import { describe, expect, test } from "bun:test";
import {
  DEFAULT_DOCUMENT_CATALOG_STATE,
  documentCatalogIsFlat,
  documentCatalogUrlHref,
  parseDocumentCatalogUrlState,
} from "./document-catalog-url-state";

const parse = (query: string) => parseDocumentCatalogUrlState(new URLSearchParams(query));

describe("All documents URL state", () => {
  test("round-trips filters, sort, search and folder path so a reload keeps them", () => {
    const state = {
      ...DEFAULT_DOCUMENT_CATALOG_STATE,
      q: "bundle",
      workflow: "FLOW01",
      template: "TMPL01",
      table: "TABL01",
      mediaType: "application/zip",
      sort: "oldest" as const,
    };
    const href = documentCatalogUrlHref(new URL("https://cloud.test/app/grids/BASE01/documents?keep=1"), state);
    expect(href).toBe(
      "/app/grids/BASE01/documents?keep=1&q=bundle&workflow=FLOW01&template=TMPL01&table=TABL01&type=application%2Fzip&sort=oldest",
    );
    expect(parseDocumentCatalogUrlState(new URL(href, "https://cloud.test").searchParams)).toEqual(state);
    const folder = { ...DEFAULT_DOCUMENT_CATALOG_STATE, path: ["workflow:FLOW01", "2026"] };
    const folderHref = documentCatalogUrlHref(new URL("https://cloud.test/d?sort=name&type=text%2Fcsv"), folder);
    expect(folderHref).toBe("/d?path=workflow%3AFLOW01%2F2026");
    expect(parse(folderHref.slice(3))).toEqual(folder);
  });

  test("falls back to defaults for invalid values", () => {
    expect(parse("workflow=bad id&template=x&table=&type=pdf&sort=size&view=grid&path=a/b/c")).toEqual(DEFAULT_DOCUMENT_CATALOG_STATE);
    expect(parse("path=TMPL01/20x6").path).toEqual(["TMPL01"]);
  });

  test("search, any filter, list view or a non-default sort flatten the catalog", () => {
    expect(documentCatalogIsFlat(DEFAULT_DOCUMENT_CATALOG_STATE)).toBe(false);
    for (const patch of [
      { q: "x" },
      { view: "list" as const },
      { mediaType: "text/csv" },
      { table: "TABL01" },
      { sort: "name" as const },
    ]) {
      expect(documentCatalogIsFlat({ ...DEFAULT_DOCUMENT_CATALOG_STATE, ...patch })).toBe(true);
    }
  });
});
