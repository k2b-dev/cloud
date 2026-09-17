import { expect, spyOn, test } from "bun:test";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../ui/test/dom";

const domTest = isServer ? test.skip : test;

for (const navigateTo of [undefined, "/apps/APP001/bill?bill_id=BILL01"]) {
  domTest(`successful row mutations refresh all page data${navigateTo ? " at the provided destination" : " with a reload"}`, async () => {
    const dom = createDomTestHarness();
    const originalFetch = globalThis.fetch;
    const reload = spyOn(dom.window.location, "reload").mockImplementation(() => {});
    const replace = spyOn(dom.window.location, "replace").mockImplementation(() => {});
    let finish: ((response: Response) => void) | undefined;
    const finished = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    let polls = 0;
    let recordReads = 0;
    const data = {
      ok: true as const,
      mode: "rows" as const,
      limit: 25,
      columns: [{ key: "name", label: "Name", type: "text", sqlType: "text" }],
      rows: [{ tableId: "TABLE1", recordId: "PAY001", values: { name: "Payment" } }],
    };
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL) => {
        if (String(input) === "/invoke") return Response.json({ statusUrl: "/status" });
        if (String(input) === "/status") {
          polls++;
          return polls === 1 ? Response.json({ status: "running", live: true, committedChanges: 1 }) : finished;
        }
        recordReads++;
        return Response.json(data);
      },
      { preconnect: originalFetch.preconnect },
    );
    const { default: RecordsTable } = await import("./RecordsTable.island");
    const dispose = render(
      () => (
        <RecordsTable
          title="Payments"
          emptyText="No payments"
          baseId="BASE01"
          appId="APP001"
          endpoint="/records"
          result={data}
          rowActions={[{ id: "confirm", label: "Confirm payment", showLabel: true, endpoint: "/invoke", variant: "primary" }]}
        />
      ),
      dom.root,
    );
    try {
      Array.from(dom.root.querySelectorAll<HTMLButtonElement>("button"))
        .find((button) => button.textContent?.includes("Confirm payment"))!
        .click();
      await Bun.sleep(10);
      expect(recordReads).toBe(1);
      expect(reload).not.toHaveBeenCalled();
      expect(replace).not.toHaveBeenCalled();
      finish!(Response.json({ status: "succeeded", live: true, committedChanges: 1, navigateTo }));
      await Bun.sleep(10);
      expect(recordReads).toBe(1);
      if (navigateTo) {
        expect(replace).toHaveBeenCalledWith(navigateTo);
        expect(reload).not.toHaveBeenCalled();
      } else {
        expect(reload).toHaveBeenCalledTimes(1);
        expect(replace).not.toHaveBeenCalled();
      }
    } finally {
      dispose();
      reload.mockRestore();
      replace.mockRestore();
      globalThis.fetch = originalFetch;
      dom.cleanup();
    }
  });
}
