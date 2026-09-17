import { expect, test } from "bun:test";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../ui/test/dom";

const domTest = isServer ? test.skip : test;

domTest("an empty search keeps its input available until the user clears the filter", async () => {
  const dom = createDomTestHarness();
  const originalFetch = globalThis.fetch;
  const columns = [{ key: "name", label: "Name", type: "text", sqlType: "text" }];
  const requests: string[] = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      requests.push(String(input));
      return Response.json({ ok: true, mode: "rows", limit: 25, columns, rows: [] });
    },
    { preconnect: originalFetch.preconnect },
  );
  const { default: RecordsTable } = await import("./RecordsTable.island");
  const dispose = render(
    () => (
      <RecordsTable
        title="Invoices"
        emptyText="No invoices yet."
        baseId="BASE01"
        appId="APP001"
        endpoint="/records"
        searchable
        result={{
          ok: true,
          mode: "rows",
          limit: 25,
          columns,
          rows: [{ tableId: "TABLE1", recordId: "REC001", values: { name: "Invoice A" } }],
        }}
      />
    ),
    dom.root,
  );
  const search = (value: string) => {
    const input = dom.root.querySelector<HTMLInputElement>('input[type="search"]')!;
    input.value = value;
    const event = new Event("input", { bubbles: true });
    Object.defineProperty(event, "currentTarget", { value: input });
    const handler = (input as HTMLInputElement & { $$input?: (event: Event) => void }).$$input;
    if (handler) handler(event);
    else input.dispatchEvent(event);
  };
  try {
    search("missing");
    await Bun.sleep(350);
    expect(requests.at(-1)).toContain("_search=missing");
    expect(dom.root.querySelector('input[type="search"]')).not.toBeNull();
    expect(dom.root.textContent).toContain("missing");
    search("");
    await Bun.sleep(350);
    expect(requests.at(-1)).toBe("/records");
    expect(dom.root.querySelector('input[type="search"]')).toBeNull();
    expect(dom.root.querySelector("thead")).toBeNull();
    expect(dom.root.textContent).toContain("No invoices yet.");
  } finally {
    dispose();
    globalThis.fetch = originalFetch;
    dom.cleanup();
  }
});
