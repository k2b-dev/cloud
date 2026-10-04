import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness, type DomTestHarness } from "../../../../../ui/test/dom";
import type { PublicRecordSnapshotSummary } from "../documents/public-document-types";

const snapshot: PublicRecordSnapshotSummary = {
  id: "Snap01",
  baseId: "Base01",
  tableId: "Table1",
  recordId: "Rec001",
  createdBy: "00000000-0000-4000-8000-000000000001",
  createdAt: "2026-10-03T10:00:00.000Z",
};
const flush = async () => {
  await Promise.resolve();
  await Bun.sleep(10);
};
const until = async (done: () => boolean) => {
  for (let attempt = 0; attempt < 40 && !done(); attempt++) await flush();
};
/** The lines the shared polite status region of `@k2b/ui` reads, once its announcement delay has passed. */
const announcements = async (document: Document) => {
  await Bun.sleep(150);
  return [...document.querySelectorAll('[data-k2b-live] [role="status"] > div')].map((line) => line.textContent);
};

describe("Record snapshot feedback", () => {
  if (isServer) {
    test.skip("runs in the dedicated browser-conditions test process", () => {});
    return;
  }
  let dom: DomTestHarness;
  const originalFetch = globalThis.fetch;
  beforeAll(() => {
    dom = createDomTestHarness();
    globalThis.fetch = Object.assign(
      async (_input: RequestInfo | URL, init?: RequestInit) =>
        init?.method === "POST" ? Response.json({ snapshot: { ...snapshot, root: {}, graph: {} } }) : Response.json({ items: [snapshot] }),
      { preconnect: originalFetch.preconnect },
    );
  });
  afterAll(() => {
    globalThis.fetch = originalFetch;
    dom.cleanup();
  });

  test("a created snapshot is announced to screen readers, with no toast", async () => {
    const { toast } = await import("@k2b/ui");
    const successes = spyOn(toast, "success").mockImplementation(() => ({ dismiss: () => {}, update: () => {} }));
    const { default: RecordDocumentsSection } = await import("./RecordDocumentsSection");
    dom.document.querySelector("[data-k2b-live]")?.remove();
    const dispose = render(
      () =>
        createComponent(RecordDocumentsSection, {
          cloudUrl: "http://localhost:3000",
          tableId: "Table1",
          tableName: "Invoices",
          recordId: "Rec001",
          live: true,
          canWrite: true,
          templates: [],
          initialDocuments: { items: [], cursor: null, hasMore: false },
          initialSnapshots: [],
        }),
      dom.root,
    );
    try {
      [...dom.root.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent?.includes("Create snapshot"))!
        .click();
      await until(() => dom.root.textContent?.includes("SNAP-SNAP01") ?? false);

      expect(await announcements(dom.document)).toEqual(["Snapshot created"]);
      // Nothing visible is added: the list itself shows the snapshot.
      expect(successes).not.toHaveBeenCalled();
    } finally {
      dispose();
      successes.mockRestore();
    }
  });
});
