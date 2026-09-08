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
    const { default: RecordReferencedBy } = await import("./RecordReferencedBy.island");
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
      dom.root.querySelector<HTMLButtonElement>("button")?.click();
      await settle(() => dom.root.querySelectorAll("a").length === 6);
      expect(dom.root.querySelector("button")).toBeNull();
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
});
