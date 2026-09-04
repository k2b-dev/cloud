import { describe, expect, mock, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../ui/test/dom";
import type { SpacesViewSnapshot } from "../src/frontend/[id]/_components/workspace/workspace-types";

const BASE = "/app/spaces/Space1?view=list";
type Snapshot = Extract<SpacesViewSnapshot, { kind: "list" }>;
const result = (total: number): Snapshot => ({
  kind: "list",
  currentView: "list",
  itemsResult: { items: [], total, page: 1, pageSize: 50, totalPages: Math.ceil(total / 50) },
});
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

describe("Spaces list search", () => {
  if (isServer) {
    test.skip("runs with browser conditions", () => {});
    return;
  }
  test("keeps focus and last-good SSR data, ignores stale responses, retries and restores history", async () => {
    const dom = createDomTestHarness();
    dom.window.history.replaceState(null, "", BASE);
    const requests: Array<{ href: string; signal: AbortSignal; deferred: ReturnType<typeof deferred<Snapshot>> }> = [];
    mock.module("../src/frontend/[id]/_components/workspace/view-query", () => ({
      SpacesViewUnavailableError: class extends Error {},
      loadSpacesViewSnapshot: (href: string, signal: AbortSignal) => {
        const pending = deferred<Snapshot>();
        requests.push({ href, signal, deferred: pending });
        return pending.promise;
      },
    }));
    const { useSpacesListQuery } = await import("../src/frontend/[id]/_components/workspace/list-query");
    const { default: SearchInput } = await import("../src/frontend/[id]/_components/filter/SearchInput");
    let controller!: ReturnType<typeof useSpacesListQuery>;
    const dispose = render(() => {
      controller = useSpacesListQuery({ initialSource: BASE, initialItemsResult: result(70).itemsResult, currentView: "list" });
      return createComponent(SearchInput, {
        get value() {
          return controller.requestedFilter().search;
        },
        get busy() {
          return controller.busy();
        },
        get reset() {
          return controller.searchReset();
        },
        debounceMs: 1,
        onSearch: (search) => controller.open(`${BASE}&q=${encodeURIComponent(search)}`),
      });
    }, dom.root);
    try {
      await flush();
      expect(requests).toHaveLength(0);
      const input = dom.root.querySelector("input")!;
      input.focus();
      const type = async (value: string) => {
        input.value = value;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 5));
        await flush();
      };
      await type("a");
      await type("ab");
      expect(requests).toHaveLength(2);
      expect(requests[0]!.signal.aborted).toBe(true);
      expect(controller.current().itemsResult.total).toBe(70);
      expect(dom.window.location.search).toBe("?view=list");
      requests[1]!.deferred.resolve(result(2));
      await flush();
      requests[0]!.deferred.resolve(result(999));
      await flush();
      expect(controller.current().itemsResult.total).toBe(2);
      expect(controller.filter().search).toBe("ab");
      expect(dom.document.activeElement).toBe(input);
      expect(input.value).toBe("ab");
      expect(new URL(dom.window.location.href).searchParams.get("q")).toBe("ab");

      await type("failed");
      requests.at(-1)!.deferred.reject(new Error("Search unavailable"));
      await flush();
      expect(controller.error()?.message).toBe("Search unavailable");
      expect(controller.current().itemsResult.total).toBe(2);
      expect(input.value).toBe("failed");
      expect(new URL(dom.window.location.href).searchParams.get("q")).toBe("ab");
      const retry = controller.refresh();
      await flush();
      requests.at(-1)!.deferred.resolve(result(3));
      await retry;
      await flush();
      expect(new URL(dom.window.location.href).searchParams.get("q")).toBe("failed");

      dom.window.history.replaceState(null, "", `${BASE}&q=back`);
      dom.window.dispatchEvent(new dom.window.PopStateEvent("popstate"));
      await flush();
      expect(input.value).toBe("back");
      requests.at(-1)!.deferred.reject(new Error("Back unavailable"));
      await flush();
      expect(new URL(dom.window.location.href).searchParams.get("q")).toBe("failed");
      expect(controller.current().itemsResult.total).toBe(3);
      const retryBack = controller.refresh();
      await flush();
      requests.at(-1)!.deferred.resolve(result(4));
      await retryBack;
      await flush();
      expect(new URL(dom.window.location.href).searchParams.get("q")).toBe("back");
      expect(controller.filter().search).toBe("back");

      // History cancels a draft that has not reached the debounced query yet.
      input.value = "unsubmitted";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      const requestCount = requests.length;
      dom.window.dispatchEvent(new dom.window.PopStateEvent("popstate"));
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(input.value).toBe("back");
      expect(requests).toHaveLength(requestCount);

      const { invalidateSpacesData } = await import("../src/frontend/[id]/_components/workspace/workspace-events");
      let covered = false;
      const coverage = invalidateSpacesData(["view"], "cursor-1").then(() => {
        covered = true;
      });
      await flush();
      const oldLiveRequest = requests.at(-1)!;
      await type("during-live");
      expect(oldLiveRequest.signal.aborted).toBe(true);
      expect(covered).toBe(false);
      // The invalidation may need a trailing read after the new source load.
      for (let i = 0; i < 4 && !covered; i++) {
        requests.at(-1)!.deferred.resolve(result(5));
        await flush();
      }
      expect(covered).toBe(true);
      await coverage;
      expect(controller.filter().search).toBe("during-live");

      // Selection made while searching belongs to the independent detail island.
      await type("selected");
      dom.window.history.replaceState(null, "", `${dom.window.location.href}&item=Item1`);
      requests.at(-1)!.deferred.resolve(result(6));
      await flush();
      expect(new URL(dom.window.location.href).searchParams.get("item")).toBe("Item1");
      expect(controller.current().source).not.toContain("item=");

      dom.window.history.replaceState(null, "", `${BASE}&q=history-selection&item=Older`);
      dom.window.dispatchEvent(new dom.window.PopStateEvent("popstate"));
      await flush();
      dom.window.history.replaceState(null, "", `${BASE}&q=history-selection&item=Newer`);
      requests.at(-1)!.deferred.resolve(result(7));
      await flush();
      expect(new URL(dom.window.location.href).searchParams.get("item")).toBe("Newer");

      // A normal detail selection must also update the list's rollback URL.
      dom.window.history.replaceState(null, "", `${BASE}&q=history-selection&item=Latest`);
      const { publishSpacesDetailState } = await import("../src/frontend/[id]/_components/workspace/workspace-events");
      publishSpacesDetailState({ itemId: "Latest", occurrenceId: null, selectionId: "Latest" });

      dom.window.history.replaceState(null, "", `${BASE}&q=history-retry&item=RetryItem`);
      dom.window.dispatchEvent(new dom.window.PopStateEvent("popstate"));
      await flush();
      requests.at(-1)!.deferred.reject(new Error("History failed"));
      await flush();
      expect(new URL(dom.window.location.href).searchParams.get("item")).toBe("Latest");
      const retrySelection = controller.refresh();
      await flush();
      requests.at(-1)!.deferred.resolve(result(8));
      await retrySelection;
      await flush();
      expect(new URL(dom.window.location.href).searchParams.get("item")).toBe("RetryItem");

      await type("dispose");
      dispose();
      expect(requests.at(-1)!.signal.aborted).toBe(true);
    } finally {
      dispose();
      dom.cleanup();
    }
  });

  test.each(["list", "table"] as const)("%s keeps pagination tied to displayed results", async (currentView) => {
    const dom = createDomTestHarness();
    const previousCss = Object.getOwnPropertyDescriptor(globalThis, "CSS");
    Object.defineProperty(globalThis, "CSS", { configurable: true, value: dom.window.CSS });
    const base = `/app/spaces/Space1?view=${currentView}&q=initial&page=2`;
    dom.window.history.replaceState(null, "", base);
    const pending = deferred<Snapshot>();
    mock.module("../src/frontend/[id]/_components/workspace/view-query", () => ({
      SpacesViewUnavailableError: class extends Error {},
      loadSpacesViewSnapshot: () => pending.promise,
    }));
    const { default: SpacesListRoute } = await import("../src/frontend/[id]/_components/workspace/SpacesListRoute.island");
    const { parseFilterFromUrl } = await import("../src/frontend/[id]/_components/filter/types");
    const dispose = render(
      () =>
        createComponent(SpacesListRoute, {
          spaceId: "Space1",
          currentView,
          columns: [],
          tags: [],
          filter: parseFilterFromUrl(new URL(base, "http://localhost")),
          initialItemsResult: { ...result(120).itemsResult, page: 2 },
          initialSelectedItemId: "",
          itemLinkBaseUrl: base,
          paginationBaseUrl: "unused",
          canWrite: false,
        }),
      dom.root,
    );
    try {
      const paginationLinks = () => Array.from(dom.root.querySelectorAll<HTMLAnchorElement>('a[href*="page="]'));
      expect(paginationLinks().some((link) => new URL(link.href).searchParams.get("page") === "3")).toBe(true);
      const input = dom.root.querySelector("input")!;
      input.focus();
      input.value = "new search";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 220));
      expect(paginationLinks().every((link) => new URL(link.href).searchParams.get("q") === "initial")).toBe(true);
      pending.resolve({ ...result(80), currentView });
      await flush();
      expect(paginationLinks().length).toBeGreaterThan(0);
      expect(paginationLinks().every((link) => new URL(link.href).searchParams.get("q") === "new search")).toBe(true);
      expect(new URL(dom.window.location.href).searchParams.has("page")).toBe(false);
      expect(dom.document.activeElement).toBe(input);
    } finally {
      dispose();
      dom.cleanup();
      if (previousCss) Object.defineProperty(globalThis, "CSS", previousCss);
      else Reflect.deleteProperty(globalThis, "CSS");
    }
  });
});
