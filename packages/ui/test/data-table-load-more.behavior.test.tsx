import { afterEach, describe, expect, test } from "bun:test";
import { createSignal } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "./dom";

type Row = { id: string; name: string };

const rowsUpTo = (count: number): Row[] => Array.from({ length: count }, (_, index) => ({ id: `r${index}`, name: `Row ${index}` }));

let cleanup = () => {};
afterEach(() => cleanup());

/**
 * happy-dom has no layout, so each test states the geometry a browser would
 * report: the table viewport's scroll box, the sentinel's position, and the
 * window height. The observer stub lets a test deliver the notification a
 * real IntersectionObserver sends when the sentinel crosses the viewport.
 */
async function renderLoadMoreTable() {
  const dom = createDomTestHarness();
  const previousObserver = Object.getOwnPropertyDescriptor(globalThis, "IntersectionObserver");
  const observers: Array<{ notify: () => void; init: IntersectionObserverInit | undefined }> = [];
  class ManualIntersectionObserver {
    constructor(
      private readonly callback: IntersectionObserverCallback,
      readonly init?: IntersectionObserverInit,
    ) {
      observers.push({ notify: () => this.callback([], this as unknown as IntersectionObserver), init });
    }
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }
  }
  Object.defineProperty(globalThis, "IntersectionObserver", { configurable: true, writable: true, value: ManualIntersectionObserver });

  const { DataTable } = await import("../src");
  const [rows, setRows] = createSignal(rowsUpTo(3));
  const [hasMore, setHasMore] = createSignal(false);
  let loads = 0;
  const dispose = render(
    () => (
      <DataTable
        rows={rows()}
        columns={[{ id: "name", header: "Name", value: "name" }]}
        getRowId={(row) => row.id}
        hasMore={hasMore()}
        onLoadMore={() => {
          loads++;
        }}
      />
    ),
    dom.root,
  );
  cleanup = () => {
    dispose();
    dom.cleanup();
    if (previousObserver) Object.defineProperty(globalThis, "IntersectionObserver", previousObserver);
    else delete (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;
    cleanup = () => {};
  };

  const wrap = dom.root.querySelector<HTMLElement>(".k2b-table-wrap")!;
  const sentinel = dom.root.querySelector<HTMLElement>(".k2b-data-table__sentinel")!;
  const layout = { scrollHeight: 0, clientHeight: 0, scrollTop: 0, sentinelTop: 0 };
  Object.defineProperty(wrap, "scrollHeight", { configurable: true, get: () => layout.scrollHeight });
  Object.defineProperty(wrap, "clientHeight", { configurable: true, get: () => layout.clientHeight });
  Object.defineProperty(wrap, "scrollTop", { configurable: true, get: () => layout.scrollTop });
  sentinel.getBoundingClientRect = () => ({ top: layout.sentinelTop }) as DOMRect;
  Object.defineProperty(dom.window, "innerHeight", { configurable: true, value: 844 });

  expect(observers).toHaveLength(1);
  return {
    layout,
    loads: () => loads,
    observer: observers[0]!,
    setRows,
    setHasMore,
    scrollTable: () => wrap.dispatchEvent(new Event("scroll")),
  };
}

describe("@k2b/ui DataTable infinite loading", () => {
  if (isServer) {
    test.skip("runs in the dedicated browser-conditions test process", () => {});
    return;
  }

  test("a bounded table loads the next page when its own viewport nears the end", async () => {
    const table = await renderLoadMoreTable();
    // The table scrolls itself and sits inside the window, so only its own scroll position counts.
    Object.assign(table.layout, { scrollHeight: 2000, clientHeight: 400, scrollTop: 0, sentinelTop: 400 });

    table.setHasMore(true);
    expect(table.loads()).toBe(0);

    table.layout.scrollTop = 1400;
    table.scrollTable();
    expect(table.loads()).toBe(1);

    table.scrollTable();
    expect(table.loads()).toBe(1);
  });

  test("a table that grows with its rows loads the next page when the page scrolls to its end", async () => {
    const table = await renderLoadMoreTable();
    // Narrow layouts let the table grow; the document scrolls and the table viewport never does.
    Object.assign(table.layout, { scrollHeight: 3000, clientHeight: 3000, scrollTop: 0, sentinelTop: 3000 });

    table.setHasMore(true);
    expect(table.loads()).toBe(0);
    expect(table.observer.init?.root ?? null).toBeNull();

    table.layout.sentinelTop = 900;
    table.observer.notify();
    expect(table.loads()).toBe(1);

    // The appended page pushes the end below the window again: no chained request.
    table.layout.sentinelTop = 5000;
    table.setRows(rowsUpTo(6));
    expect(table.loads()).toBe(1);

    table.layout.sentinelTop = 700;
    table.observer.notify();
    expect(table.loads()).toBe(2);
  });

  test("leaving the end re-arms a request the owner declined", async () => {
    const table = await renderLoadMoreTable();
    Object.assign(table.layout, { scrollHeight: 3000, clientHeight: 3000, scrollTop: 0, sentinelTop: 700 });

    // The owner ignores the request, for example because its first page is still loading.
    table.setHasMore(true);
    expect(table.loads()).toBe(1);
    table.observer.notify();
    expect(table.loads()).toBe(1);

    table.layout.sentinelTop = 3000;
    table.observer.notify();
    table.layout.sentinelTop = 700;
    table.observer.notify();
    expect(table.loads()).toBe(2);
  });
});
