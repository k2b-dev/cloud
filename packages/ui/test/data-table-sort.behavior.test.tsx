import { afterEach, describe, expect, test } from "bun:test";
import { createSignal } from "solid-js";
import { delegateEvents, isServer, render } from "solid-js/web";
import { createDomTestHarness } from "./dom";

// Load once outside any test, so the cold Solid transform of the library source does not count against the 5 s test
// timeout. The library needs a document while its modules evaluate.
const load = async () => {
  const dom = createDomTestHarness();
  try {
    return await import("../src");
  } finally {
    dom.cleanup();
  }
};
const modules = isServer ? undefined : await load();

type Row = { id: string; name: string; count: number };

let cleanup = () => {};
afterEach(() => cleanup());

describe("@k2b/ui DataTable client sorting", () => {
  if (isServer) {
    test.skip("runs in the dedicated browser-conditions test process", () => {});
    return;
  }

  test("a sorted header button keeps keyboard focus, so the reader can press it again to reverse the order", () => {
    const dom = createDomTestHarness();
    // The library registered its delegated click handler on the document it was loaded in.
    delegateEvents(["click"], dom.document);
    const { DataTable } = modules!;
    const [sort, setSort] = createSignal<{ key: string; direction: "asc" | "desc" } | null>(null);
    const dispose = render(
      () => (
        <DataTable<Row>
          rows={[
            { id: "a", name: "Alpha", count: 2 },
            { id: "b", name: "Beta", count: 1 },
          ]}
          columns={[
            { id: "name", header: "Name", value: "name", sortable: true },
            { id: "count", header: "Count", value: "count", sortable: true },
          ]}
          getRowId={(row) => row.id}
          sort={sort()}
          onSortChange={setSort}
        />
      ),
      dom.root,
    );
    cleanup = () => {
      dispose();
      dom.cleanup();
      cleanup = () => {};
    };

    const header = () => dom.root.querySelectorAll<HTMLElement>("th")[1]!;
    const button = header().querySelector<HTMLButtonElement>("button.k2b-data-table__sort")!;
    const icon = () => button.querySelector(".k2b-data-table__sort-icon")!;
    button.focus();
    expect(dom.document.activeElement).toBe(button);
    expect(header().getAttribute("aria-sort")).toBe("none");

    button.click();
    expect(sort()).toEqual({ key: "count", direction: "desc" });
    expect(header().querySelector("button")).toBe(button);
    expect(button.isConnected).toBe(true);
    expect(dom.document.activeElement).toBe(button);
    expect(header().getAttribute("aria-sort")).toBe("descending");
    expect(icon().getAttribute("data-active")).toBe("true");
    expect(icon().classList.contains("ti-arrow-down")).toBe(true);

    button.click();
    expect(sort()).toEqual({ key: "count", direction: "asc" });
    expect(header().querySelector("button")).toBe(button);
    expect(dom.document.activeElement).toBe(button);
    expect(header().getAttribute("aria-sort")).toBe("ascending");
    expect(icon().classList.contains("ti-arrow-up")).toBe(true);

    // Another column takes over; the first one shows the dimmed marker again.
    dom.root.querySelectorAll<HTMLButtonElement>("button.k2b-data-table__sort")[0]!.click();
    expect(sort()).toEqual({ key: "name", direction: "desc" });
    expect(header().getAttribute("aria-sort")).toBe("none");
    expect(icon().getAttribute("data-active")).toBeNull();
  });
});
