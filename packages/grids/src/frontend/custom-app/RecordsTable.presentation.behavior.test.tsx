import { expect, test } from "bun:test";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../ui/test/dom";
import type { CustomAppRecordsSuccess } from "./RecordsTable.island";

const domTest = isServer ? test.skip : test;

for (const reordered of [false, true]) {
  domTest(`mobile rows resolve author labels independently of positional keys (reordered: ${reordered})`, async () => {
    const dom = createDomTestHarness();
    const { default: RecordsTable } = await import("./RecordsTable.island");
    const customerKey = reordered ? "q_col_2" : "q_col_0";
    const amountKey = "q_col_1";
    const internalKey = reordered ? "q_col_0" : "q_col_2";
    const columns = [
      { key: customerKey, fieldId: "FIELD1", label: "Customer", type: "text", sqlType: "text" },
      { key: amountKey, label: "Outstanding", type: "number", sqlType: "numeric" },
      { key: internalKey, label: "Internal detail", type: "text", sqlType: "text" },
    ];
    if (reordered) columns.reverse();
    const dispose = render(
      () => (
        <RecordsTable
          title="Orders"
          emptyText="No orders"
          appId="APP001"
          baseId="BASE01"
          tablePresentation={{ mobile: { titleColumnId: "Customer", detailColumnIds: ["Outstanding"] } }}
          columnReference="label"
          rowNavigate={{ kind: "navigate", pageId: "order", history: "push", params: { order: { source: "ROW", path: "id" } } }}
          rowActions={[{ id: "confirm", label: "Confirm", endpoint: "/confirm", showLabel: true }]}
          result={{
            ok: true,
            mode: "rows",
            limit: 25,
            columns,
            rows: [
              { recordId: "ORDER1", tableId: "TABLE1", values: { [customerKey]: "Acme", [amountKey]: 42, [internalKey]: "Internal note" } },
            ],
          }}
        />
      ),
      dom.root,
    );
    try {
      const mobile = dom.root.querySelector('ul[aria-label="Orders"]')!;
      expect(mobile.textContent).toContain("Acme");
      expect(mobile.textContent).toContain("Outstanding");
      expect(mobile.textContent).not.toContain("Internal note");
      expect(mobile.querySelectorAll("button").length).toBe(1);
      expect(mobile.querySelector("a")?.getAttribute("href")).toBe("/apps/APP001/order?order=ORDER1");
      expect(dom.root.querySelector("table")?.textContent).toContain("Internal note");
    } finally {
      dispose();
      dom.cleanup();
    }
  });
}

domTest("date annotations accept GQL calendar dates and leave timestamp values alone", async () => {
  const dom = createDomTestHarness();
  const { default: RecordsTable } = await import("./RecordsTable.island");
  const base = new Date().toISOString();
  const day = base.slice(0, 10);
  const dispose = render(
    () => (
      <RecordsTable
        title="Due dates"
        emptyText="None"
        appId="APP001"
        baseId="BASE01"
        relativeDateBase={base}
        dateConfig={{ timeZone: "UTC" }}
        tablePresentation={{ relativeDateColumnIds: ["Due", "Updated"] }}
        result={{
          ok: true,
          mode: "rows",
          limit: 25,
          columns: [
            { key: "q_col_1", label: "Due", type: "date", sqlType: "date" },
            { key: "q_col_0", label: "Updated", type: "date", sqlType: "timestamptz" },
          ],
          rows: [{ values: { q_col_1: `${day}T00:00:00.000Z`, q_col_0: base } }],
        }}
      />
    ),
    dom.root,
  );
  try {
    expect(dom.root.querySelectorAll(`time[datetime="${day}"]`).length).toBe(1);
  } finally {
    dispose();
    dom.cleanup();
  }
});

domTest("an empty later page keeps Previous available and returns to the first page", async () => {
  const dom = createDomTestHarness();
  const { default: RecordsTable } = await import("./RecordsTable.island");
  const first: CustomAppRecordsSuccess = {
    ok: true,
    mode: "rows",
    limit: 25,
    columns: [{ key: "name", label: "Name", type: "text", sqlType: "text" }],
    rows: [{ values: { name: "First order" } }],
    page: { size: 25, start: 0, returned: 1, nextCursor: "second-page" },
  };
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      requests.push(String(input));
      return Response.json(
        String(input).includes("_cursor") ? { ...first, rows: [], page: { size: 25, start: 25, returned: 0, nextCursor: null } } : first,
      );
    },
    { preconnect: originalFetch.preconnect },
  );
  const dispose = render(
    () => <RecordsTable title="Orders" emptyText="No orders" appId="APP001" baseId="BASE01" endpoint="/orders" result={first} />,
    dom.root,
  );
  const button = (label: string) => Array.from(dom.root.querySelectorAll("button")).find((item) => item.textContent === label);
  try {
    button("Next")!.click();
    await Bun.sleep(5);
    expect(dom.root.textContent).toContain("No orders");
    expect(button("Previous")?.disabled).toBe(false);
    expect(button("Next")?.disabled).toBe(true);
    button("Previous")!.click();
    await Bun.sleep(5);
    expect(dom.root.textContent).toContain("First order");
    expect(button("Previous")?.disabled).toBe(true);
    expect(requests).toEqual(["/orders?_cursor=second-page", "/orders"]);
  } finally {
    dispose();
    globalThis.fetch = originalFetch;
    dom.cleanup();
  }
});

for (const nextCursor of [null, "next-page"]) {
  domTest(`initial empty rows are quiet only without another page (${nextCursor ?? "none"})`, async () => {
    const dom = createDomTestHarness();
    const { default: RecordsTable } = await import("./RecordsTable.island");
    const dispose = render(
      () => (
        <RecordsTable
          title="Orders"
          emptyText="No orders"
          appId="APP001"
          baseId="BASE01"
          endpoint="/orders"
          result={{
            ok: true,
            mode: "rows",
            limit: 25,
            columns: [{ key: "name", label: "Name", type: "text", sqlType: "text" }],
            rows: [],
            page: { size: 25, start: 0, returned: 0, nextCursor },
          }}
        />
      ),
      dom.root,
    );
    try {
      expect(dom.root.textContent).toContain("No orders");
      const next = Array.from(dom.root.querySelectorAll("button")).find((item) => item.textContent === "Next");
      if (nextCursor) expect(next?.disabled).toBe(false);
      else {
        expect(next).toBeUndefined();
        expect(dom.root.querySelector(".k2b-paper")).toBeNull();
      }
    } finally {
      dispose();
      dom.cleanup();
    }
  });
}
