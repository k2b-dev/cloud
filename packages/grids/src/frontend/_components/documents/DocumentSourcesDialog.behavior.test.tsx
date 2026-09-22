import { expect, test } from "bun:test";
import { isServer } from "solid-js/web";
import { createDomTestHarness } from "../../../../../ui/test/dom";

const domTest = isServer ? test.skip : test;
const until = async (condition: () => boolean) => {
  const deadline = Date.now() + 2000;
  while (!condition() && Date.now() < deadline) await Bun.sleep(5);
  expect(condition()).toBe(true);
};

domTest("source inspection shows readable labels, pages and keeps deleted sources non-navigable", async () => {
  const dom = createDomTestHarness();
  const originalFetch = globalThis.fetch;
  const paths: string[] = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      const path = String(input);
      paths.push(path);
      const second = new URL(path, "http://localhost").searchParams.get("offset") === "1";
      return Response.json({
        items: [
          {
            tableId: "TABLE1",
            recordId: second ? "RECD02" : "RECD01",
            tableName: "Expenses",
            label: second ? "Archived expense" : "Train ticket",
            version: second ? null : 4,
            deleted: second,
          },
        ],
        hasMore: !second,
      });
    },
    { preconnect: originalFetch.preconnect },
  );
  const { openDocumentDetailsDialog } = await import("./DocumentDetailsDialog");
  const { dialogCore } = await import("@k2b/ui");
  try {
    void openDocumentDetailsDialog({
      onDownload: async () => {},
      canWrite: false,
      document: {
        id: "DOC001",
        baseId: "BASE01",
        tableId: null,
        recordId: null,
        templateId: null,
        number: "EXPORT-1",
        filename: "export.csv",
        createdAt: "2026-09-13T12:00:00Z",
        createdBy: null,
        tags: [],
        renderer: { kind: "profile", id: "grids.csv", version: 1 },
        primaryArtifactKey: "csv",
        downloadUrl: "/api/grids/documents/DOC/download",
        sourceRecordCount: 2,
        dataSnapshot: null,
        validationStatus: null,
        artifacts: [
          {
            key: "csv",
            filename: "export.csv",
            mimeType: "text/csv",
            sizeBytes: 10,
            sha256: "a".repeat(64),
            downloadUrl: "/api/grids/documents/DOC/artifacts/csv",
          },
        ],
      },
    });
    const button = (label: string) => Array.from(dom.document.querySelectorAll("button")).find((node) => node.textContent?.includes(label));
    button("Source records")!.click();
    await until(() => dom.document.body.textContent?.includes("Train ticket") === true);
    expect(dom.document.body.textContent).toContain("Train ticket");
    expect(dom.document.body.textContent).toContain("Captured version 4");
    expect(dom.document.querySelector('a[href*="RECD01"]')?.getAttribute("target")).toBe("_blank");
    button("Load more")!.click();
    await until(() => dom.document.body.textContent?.includes("Archived expense") === true);
    expect(paths.at(-1)).toContain("offset=1");
    expect(dom.document.body.textContent).toContain("Archived expense");
    expect(dom.document.querySelector('a[href*="RECD02"]')).toBeNull();
    expect(dom.document.body.textContent).not.toContain("Captured version 0");
    expect(button("Load more")).toBeUndefined();
  } finally {
    dialogCore.close();
    dialogCore.close();
    globalThis.fetch = originalFetch;
    dom.cleanup();
  }
});
