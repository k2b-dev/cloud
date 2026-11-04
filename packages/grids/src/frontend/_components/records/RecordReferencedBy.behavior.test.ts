import { describe, expect, spyOn, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";

// Run with the shared Solid DOM preload and --conditions=browser.
describe("record reverse relations interaction", () => {
  if (isServer) {
    test.skip("requires browser conditions", () => {});
    return;
  }

  test("retries failures, appends five-item cursor pages and retains native keyboard links", async () => {
    const { createDomTestHarness } = await import("../../../../../ui/test/dom");
    const dom = createDomTestHarness();
    const { default: RecordReferencedBy } = await import("./RecordReferencedBy");
    const requests: string[] = [];
    const fetchMock = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        async (input: RequestInfo | URL) => {
          const url = String(input);
          requests.push(url);
          if (requests.length === 1) return Response.json({ message: "References temporarily unavailable" }, { status: 503 });
          const more = new URL(url, "http://localhost").searchParams.has("cursor");
          return Response.json({
            items: Array.from({ length: more ? 1 : 5 }, (_, index) => ({
              sourceTableId: "TABLE2",
              sourceTableName: "Orders",
              sourceRecordId: `REC00${more ? 6 : index + 1}`,
              sourceRecordLabel: `Order ${more ? 6 : index + 1}`,
              relationFieldId: "FIELD1",
              relationFieldName: "Customer",
            })),
            nextCursor: more ? null : "page+2/token",
          });
        },
        { preconnect: globalThis.fetch.preconnect },
      ),
    );
    const settle = async (ready: () => boolean) => {
      for (let attempt = 0; attempt < 100 && !ready(); attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
      expect(ready()).toBe(true);
    };
    const dispose = render(
      () => createComponent(RecordReferencedBy, { baseId: "BASE01", tableId: "TABLE1", recordId: "REC001" }),
      dom.root,
    );
    try {
      await settle(() => dom.root.querySelector('[role="alert"]') !== null);
      expect(dom.root.textContent).toContain("Could not load all links");
      // The server's own words stay beside it.
      expect(dom.root.textContent).toContain("References temporarily unavailable");
      const retry = dom.root.querySelector<HTMLButtonElement>('[role="alert"] button');
      retry?.focus();
      expect(dom.document.activeElement).toBe(retry);
      retry?.click();
      await settle(() => dom.root.querySelectorAll("a").length === 5);
      expect(dom.root.querySelector('[role="alert"]')).toBeNull();
      const firstLink = dom.root.querySelector<HTMLAnchorElement>("a");
      firstLink?.focus();
      expect(dom.document.activeElement).toBe(firstLink);
      expect(firstLink?.getAttribute("href")).toBe("/app/grids/BASE01/table/TABLE2?record=REC001");
      expect(dom.root.textContent).toContain("Linked from 5");
      const loadMore = () =>
        [...dom.root.querySelectorAll<HTMLButtonElement>("button.k2b-detail-panel__action")].find((button) =>
          button.textContent?.includes("Loading more"),
        );
      loadMore()?.click();
      await settle(() => dom.root.querySelectorAll("a").length === 6);
      // Every loaded row stays visible; the last page ends "Load more".
      expect(loadMore()).toBeUndefined();
      expect(dom.root.textContent).not.toContain("Show 1 more");
      expect(dom.root.querySelector("details")).toBeNull();
      expect(requests).toHaveLength(3);
      for (const request of requests) expect(new URL(request, "http://localhost").searchParams.get("limit")).toBe("5");
      expect(new URL(requests[2]!, "http://localhost").searchParams.get("cursor")).toBe("page+2/token");
    } finally {
      dispose();
      fetchMock.mockRestore();
      dom.cleanup();
    }
  });

  test("a fresh detail of the open record refreshes the links in place and keeps focus on a row that stays", async () => {
    const { createDomTestHarness } = await import("../../../../../ui/test/dom");
    const dom = createDomTestHarness();
    const { createSignal } = await import("solid-js");
    const { RecordLinks } = await import("./RecordReferencedBy");
    const page = (labels: string[]) => ({
      items: labels.map((label, index) => ({
        sourceTableId: "TABLE2",
        sourceTableName: "Orders",
        sourceRecordId: `REC10${index}`,
        sourceRecordLabel: label,
        relationFieldId: "FIELD1",
        relationFieldName: "Customer",
      })),
      nextCursor: null,
    });
    const requests: string[] = [];
    const fetchMock = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        async (input: RequestInfo | URL) => {
          requests.push(String(input));
          return Response.json(page(["Order 1", "Order 7"]));
        },
        { preconnect: globalThis.fetch.preconnect },
      ),
    );
    const settle = async (ready: () => boolean) => {
      for (let attempt = 0; attempt < 100 && !ready(); attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
      expect(ready()).toBe(true);
    };
    // The first detail brings its page; a later detail of the same record comes without one.
    const [detail, setDetail] = createSignal<{ referencedBy: ReturnType<typeof page> | null }>({ referencedBy: page(["Order 1"]) });
    const dispose = render(
      () =>
        createComponent(RecordLinks, {
          baseId: "BASE01",
          tableId: "TABLE1",
          recordId: "REC001",
          ready: true,
          get initialPage() {
            return detail().referencedBy;
          },
          get revision() {
            return detail();
          },
        }),
      dom.root,
    );
    try {
      expect(requests).toHaveLength(0);
      const kept = [...dom.root.querySelectorAll<HTMLAnchorElement>("a")].find((link) => link.textContent?.includes("Order 1"));
      if (!kept) throw new Error("The server page's row is missing");
      kept.focus();
      expect(dom.document.activeElement).toBe(kept);
      setDetail({ referencedBy: null });
      await settle(() => dom.root.textContent?.includes("Customer · Order 7") ?? false);
      expect(requests).toHaveLength(1);
      // The row that stayed is the same element and keeps focus.
      expect(dom.root.contains(kept)).toBe(true);
      expect(dom.document.activeElement).toBe(kept);
    } finally {
      dispose();
      fetchMock.mockRestore();
      dom.cleanup();
    }
  });

  test("two fresh details while a refresh runs end with the newest answer", async () => {
    const { createDomTestHarness } = await import("../../../../../ui/test/dom");
    const dom = createDomTestHarness();
    const { createSignal } = await import("solid-js");
    const { RecordLinks } = await import("./RecordReferencedBy");
    const page = (labels: string[]) => ({
      items: labels.map((label, index) => ({
        sourceTableId: "TABLE2",
        sourceTableName: "Orders",
        sourceRecordId: `REC20${index}`,
        sourceRecordLabel: label,
        relationFieldId: "FIELD1",
        relationFieldName: "Customer",
      })),
      nextCursor: null,
    });
    // The server's state changes while the first refresh is still on its way.
    let serverLabels = ["Order 1"];
    const fetchMock = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        async () => {
          const answer = page(serverLabels);
          await new Promise((resolve) => setTimeout(resolve, 30));
          return Response.json(answer);
        },
        { preconnect: globalThis.fetch.preconnect },
      ),
    );
    const settle = async (ready: () => boolean) => {
      for (let attempt = 0; attempt < 100 && !ready(); attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
      expect(ready()).toBe(true);
    };
    const [revision, setRevision] = createSignal(0);
    const dispose = render(
      () =>
        createComponent(RecordLinks, {
          baseId: "BASE01",
          tableId: "TABLE1",
          recordId: "REC001",
          ready: true,
          initialPage: page([]),
          get revision() {
            return revision();
          },
        }),
      dom.root,
    );
    try {
      setRevision(1);
      await new Promise((resolve) => setTimeout(resolve, 5));
      serverLabels = ["Order 9"];
      setRevision(2);
      await settle(() => dom.root.textContent?.includes("Customer · Order 9") ?? false);
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(dom.root.textContent).toContain("Customer · Order 9");
      expect(dom.root.textContent).not.toContain("Customer · Order 1");
    } finally {
      dispose();
      fetchMock.mockRestore();
      dom.cleanup();
    }
  });
});
