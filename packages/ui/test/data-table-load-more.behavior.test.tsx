import { afterEach, describe, expect, test } from "bun:test";
import { createSignal } from "solid-js";
import { isServer, render } from "solid-js/web";
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

type Row = { id: string; name: string };

const rowsUpTo = (count: number): Row[] => Array.from({ length: count }, (_, index) => ({ id: `r${index}`, name: `Row ${index}` }));

let cleanup = () => {};
afterEach(() => cleanup());

/**
 * happy-dom has no layout. The observer stub stands in for the browser's IntersectionObserver: a test says whether the
 * edge is within reach, and every observe() delivers the current state again, as a real observer does.
 */
function stubObserver() {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "IntersectionObserver");
  const state = { inReach: false, observers: [] as Array<{ init?: IntersectionObserverInit; notify: () => void }> };
  class ManualIntersectionObserver {
    private targets = new Set<Element>();
    constructor(
      private readonly callback: IntersectionObserverCallback,
      readonly init?: IntersectionObserverInit,
    ) {
      state.observers.push({ init, notify: () => this.deliver() });
    }
    private deliver() {
      const entries = [...this.targets].map((target) => ({ target, isIntersecting: state.inReach }) as IntersectionObserverEntry);
      if (entries.length > 0) this.callback(entries, this as unknown as IntersectionObserver);
    }
    observe(target: Element) {
      this.targets.add(target);
      queueMicrotask(() => this.deliver());
    }
    unobserve(target: Element) {
      this.targets.delete(target);
    }
    disconnect() {
      this.targets.clear();
    }
    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }
  }
  Object.defineProperty(globalThis, "IntersectionObserver", { configurable: true, writable: true, value: ManualIntersectionObserver });
  const restore = () => {
    if (previous) Object.defineProperty(globalThis, "IntersectionObserver", previous);
    else delete (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;
  };
  return {
    state,
    restore,
    /** The reader scrolls the edge into or out of reach. */
    reach: async (inReach: boolean) => {
      state.inReach = inReach;
      for (const observer of state.observers) observer.notify();
      await settle();
    },
  };
}

const settle = () => new Promise((done) => setTimeout(done, 0));

async function renderTable(options: { onLoadMore?: (loads: number) => unknown } = {}) {
  const dom = createDomTestHarness();
  const observer = stubObserver();
  const { DataTable } = modules!;
  const [rows, setRows] = createSignal(rowsUpTo(3));
  const [hasMore, setHasMore] = createSignal(false);
  const [loadingMore, setLoadingMore] = createSignal(false);
  let loads = 0;
  const dispose = render(
    () => (
      <DataTable
        rows={rows()}
        columns={[{ id: "name", header: "Name", value: "name" }]}
        getRowId={(row) => row.id}
        hasMore={hasMore()}
        loadingMore={loadingMore()}
        onLoadMore={() => {
          loads++;
          return options.onLoadMore?.(loads);
        }}
      />
    ),
    dom.root,
  );
  cleanup = () => {
    dispose();
    dom.cleanup();
    observer.restore();
    cleanup = () => {};
  };
  // A table that fills its height keeps one scroll height while short pages arrive; its row count tells them apart.
  const wrap = dom.root.querySelector<HTMLElement>(".k2b-table-wrap")!;
  Object.defineProperty(wrap, "scrollHeight", { configurable: true, get: () => 600 });
  await settle();
  return {
    dom,
    observer,
    loads: () => loads,
    setRows,
    setHasMore,
    setLoadingMore,
    edge: () => dom.root.querySelector<HTMLElement>(".k2b-load-more"),
  };
}

describe("@k2b/ui LoadMore in DataTable", () => {
  if (isServer) {
    test.skip("runs in the dedicated browser-conditions test process", () => {});
    return;
  }

  test("the table's end is the shared edge, watched in the window with the reach ahead of it", async () => {
    const table = await renderTable();
    expect(table.edge()?.dataset.state).toBe("done");
    expect(table.edge()?.querySelector("button")).toBeNull();
    expect(table.observer.state.observers).toHaveLength(1);
    expect(table.observer.state.observers[0]!.init?.root ?? null).toBeNull();
    expect(table.observer.state.observers[0]!.init?.rootMargin).toBe("240px 0px");

    table.setHasMore(true);
    await settle();
    expect(table.edge()?.dataset.state).toBe("idle");
    expect(table.edge()?.textContent).toContain("Load more");
  });

  test("loads once when the end comes within reach, and again after the owner's load finished", async () => {
    const table = await renderTable();
    table.setHasMore(true);
    await table.observer.reach(true);
    expect(table.loads()).toBe(1);

    // The owner reports its load; the edge stays one row of the same height and keeps its button.
    table.setLoadingMore(true);
    await settle();
    expect(table.edge()?.dataset.state).toBe("loading");
    expect(table.edge()?.textContent).toContain("Loading more…");
    expect(table.edge()?.querySelector("button")?.getAttribute("aria-disabled")).toBe("true");
    table.edge()!.querySelector("button")!.click();
    expect(table.loads()).toBe(1);

    // The page arrived while the end is still in reach: the next one follows.
    table.setRows(rowsUpTo(6));
    table.setLoadingMore(false);
    await settle();
    await settle();
    expect(table.loads()).toBe(2);

    // A load that brought nothing does not ask again while the end stays in reach.
    table.setLoadingMore(true);
    await settle();
    table.setLoadingMore(false);
    await settle();
    await settle();
    expect(table.loads()).toBe(2);
  });

  test("a promise that resolves without new rows waits for the reader instead of asking in a loop", async () => {
    const table = await renderTable({ onLoadMore: () => Promise.resolve() });
    table.setHasMore(true);
    await table.observer.reach(true);
    await settle();
    await settle();
    expect(table.loads()).toBe(1);
    expect(table.edge()?.dataset.state).toBe("idle");
  });

  test("leaving the end re-arms a request the owner declined", async () => {
    const table = await renderTable();
    table.setHasMore(true);
    await table.observer.reach(true);
    expect(table.loads()).toBe(1);
    // The owner ignores the request, for example because its first page is still loading.
    await table.observer.reach(true);
    expect(table.loads()).toBe(1);

    await table.observer.reach(false);
    await table.observer.reach(true);
    expect(table.loads()).toBe(2);
  });

  test("a failed load shows its message with Try again, and loads only when asked", async () => {
    let fail = true;
    const table = await renderTable({
      onLoadMore: () => (fail ? Promise.reject(new Error("Server unavailable")) : Promise.resolve()),
    });
    table.setHasMore(true);
    await table.observer.reach(true);
    await settle();
    expect(table.loads()).toBe(1);
    expect(table.edge()?.dataset.state).toBe("error");
    expect(table.edge()?.querySelector("[role='alert']")?.textContent).toContain("Server unavailable");

    // Staying at the end does not retry by itself.
    await table.observer.reach(true);
    expect(table.loads()).toBe(1);

    fail = false;
    const retry = table.edge()!.querySelector("button")!;
    expect(retry.textContent).toContain("Retry");
    retry.click();
    await settle();
    expect(table.loads()).toBe(2);
    expect(table.edge()?.dataset.state).toBe("idle");
    // Focus stays on the one button in every state.
    expect(table.edge()!.querySelector("button")).toBe(retry);
  });

  test("waits for the first rows, and needs only observe and disconnect from the observer", async () => {
    const dom = createDomTestHarness();
    const previous = Object.getOwnPropertyDescriptor(globalThis, "IntersectionObserver");
    // The smallest observer double the apps' tests use: the end is always in view.
    Object.defineProperty(globalThis, "IntersectionObserver", {
      configurable: true,
      writable: true,
      value: class {
        constructor(private readonly callback: IntersectionObserverCallback) {}
        observe(target: Element) {
          queueMicrotask(() =>
            this.callback([{ target, isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver),
          );
        }
        disconnect() {}
      },
    });
    const { DataTable } = modules!;
    const [rows, setRows] = createSignal<Row[]>([]);
    const [loading, setLoading] = createSignal(true);
    let loads = 0;
    const dispose = render(
      () => (
        <DataTable
          rows={rows()}
          columns={[{ id: "name", header: "Name", value: "name" }]}
          getRowId={(row) => row.id}
          loading={loading()}
          hasMore
          onLoadMore={() => {
            loads++;
          }}
        />
      ),
      dom.root,
    );
    try {
      await settle();
      // The first read runs: no second page, and no Load more under the placeholder rows.
      expect(loads).toBe(0);
      expect(dom.root.querySelector(".k2b-load-more")?.getAttribute("data-state")).toBe("done");

      setRows(rowsUpTo(3));
      setLoading(false);
      await settle();
      expect(loads).toBe(1);

      // The next page arrives while the end is still in view: the edge asks again without unobserve().
      setRows(rowsUpTo(6));
      await settle();
      expect(loads).toBe(2);
    } finally {
      dispose();
      dom.cleanup();
      if (previous) Object.defineProperty(globalThis, "IntersectionObserver", previous);
      else delete (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;
    }
  });
});
