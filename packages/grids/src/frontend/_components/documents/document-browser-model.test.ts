import { describe, expect, test } from "bun:test";
import {
  activeDocumentViewMode,
  appendDocumentBrowserPage,
  documentBrowserEmptyText,
  documentBrowserKey,
  documentCountLabel,
  documentActionState,
  replaceDocumentBrowserPage,
  serializeDocumentBrowserKey,
} from "./document-browser-model";
import type { PublicDocumentFolder, PublicDocument } from "./public-document-types";

const document = (id: string): PublicDocument => ({
  id,
  baseId: "base",
  tableId: "table",
  recordId: "record",
  filename: `${id}.pdf`,
  templateId: "template",
  number: id,
  tags: [],
  artifacts: [{ key: "pdf", filename: `${id}.pdf`, mimeType: "application/pdf", sizeBytes: 4, sha256: "a".repeat(64) }],
  renderer: { kind: "html" },
  validationStatus: null,
  createdBy: null,
  createdAt: "2026-01-01T00:00:00.000Z",
});
const folder = (label: string, count: number): PublicDocumentFolder => ({ kind: "year", key: label, label, count, path: [label] });

describe("document browser model", () => {
  test("search always uses list mode and removes folder scope", () => {
    expect(activeDocumentViewMode("folders", "invoice")).toBe("list");
    expect(documentBrowserKey("template", "folders", "invoice", ["2026", "07"])).toEqual({
      templateId: "template",
      search: "invoice",
      mode: "list",
      path: [],
    });
  });

  test("folder mode keeps its current path without search", () => {
    const key = documentBrowserKey("template", "folders", "", ["2026", "07"]);
    expect(key.path).toEqual(["2026", "07"]);
    expect(serializeDocumentBrowserKey(key)).toBe("template:folders::2026/07");
  });

  test("pagination appends only to the browser request that started it", () => {
    const initial = replaceDocumentBrowserPage({ items: [document("one")], folders: [], hasMore: true, cursor: "next" });
    const appended = appendDocumentBrowserPage(
      initial,
      { items: [document("two")], hasMore: true, cursor: "last" },
      "same",
      "same",
    );
    expect(appended.documents.map((item) => item.id)).toEqual(["one", "two"]);
    expect(appended.cursor).toBe("last");

    const stale = appendDocumentBrowserPage(appended, { items: [document("stale")], hasMore: false, cursor: null }, "old", "new");
    expect(stale).toBe(appended);
  });

  test("count and empty labels match list, search, and folder states", () => {
    expect(documentCountLabel("list", [], [document("one")], true)).toBe("1+ documents");
    expect(documentCountLabel("folders", [folder("2026", 4), folder("2025", 2)], [], false)).toBe("6 documents");
    expect(documentBrowserEmptyText("invoice", "list", [])).toBe("No documents match this search.");
    expect(documentBrowserEmptyText("", "folders", ["2026"])).toBe("This folder is empty.");
  });

  test("read users only get download actions and busy state is per Document", () => {
    expect(documentActionState(false, "one", "one")).toEqual({ showEdit: false, showLink: false, downloadBusy: true });
    expect(documentActionState(true, "one", "two")).toEqual({ showEdit: true, showLink: true, downloadBusy: false });
  });
});
