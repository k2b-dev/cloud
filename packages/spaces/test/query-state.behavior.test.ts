import { describe, expect, test } from "bun:test";
import { mutation, query } from "@k2b/stdlib/solid";
import { createEffect, createSignal } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../ui/test/dom";
import { invalidateSpacesData, subscribeToSpacesDataInvalidation } from "../src/frontend/[id]/_components/workspace/workspace-events";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, reject, resolve };
};

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("Spaces owner-local query behavior", () => {
  if (isServer) {
    test.skip("runs in the dedicated browser-conditions test process", () => {});
    return;
  }

  test("suppresses the hydration read, guards last-good data, drops stale responses, and aborts on disposal", async () => {
    const dom = createDomTestHarness();
    const loads: Array<{ source: string; signal: AbortSignal; result: ReturnType<typeof deferred<{ source: string; value: string }>> }> =
      [];
    let setSource!: (source: string) => void;
    let disposeQuery!: () => void;

    const dispose = render(() => {
      const [source, updateSource] = createSignal("A");
      setSource = updateSource;
      const state = query.create<string, { source: string; value: string }>({
        source,
        initial: { source: "A", data: { source: "A", value: "initial-A" } },
        load: (nextSource, { abortSignal }) => {
          const result = deferred<{ source: string; value: string }>();
          loads.push({ source: nextSource, signal: abortSignal, result });
          return result.promise;
        },
      });
      const node = dom.document.createElement("output");
      createEffect(() => {
        const loaded = state.data();
        node.textContent = loaded?.source === source() ? loaded.value : "guarded";
      });
      disposeQuery = state.abort;
      return node;
    }, dom.root);

    await flush();
    expect(loads).toHaveLength(0);
    expect(dom.root.textContent).toBe("initial-A");

    setSource("B");
    await flush();
    expect(dom.root.textContent).toBe("guarded");
    expect(loads.map((load) => load.source)).toEqual(["B"]);

    setSource("C");
    await flush();
    expect(loads[0]!.signal.aborted).toBe(true);
    expect(loads.map((load) => load.source)).toEqual(["B", "C"]);
    loads[0]!.result.resolve({ source: "B", value: "late-B" });
    await flush();
    expect(dom.root.textContent).toBe("guarded");
    loads[1]!.result.resolve({ source: "C", value: "current-C" });
    await flush();
    expect(dom.root.textContent).toBe("current-C");

    setSource("D");
    await flush();
    const active = loads.at(-1)!;
    dispose();
    expect(active.signal.aborted).toBe(true);
    disposeQuery();
    dom.cleanup();
  });

  test("orders invalidation coverage and advances a live cursor only after the covering follow-up", async () => {
    const dom = createDomTestHarness();
    const requests: Array<ReturnType<typeof deferred<string>>> = [];
    const acknowledgements: string[] = [];
    const dispose = render(() => {
      query.create<string, string, { cursor: string | null }>({
        source: () => "workspace",
        initial: { source: "workspace", data: "initial" },
        load: () => {
          const request = deferred<string>();
          requests.push(request);
          return request.promise;
        },
        subscribe: ({ invalidate }) => subscribeToSpacesDataInvalidation(["view"], invalidate),
      });
      return dom.document.createTextNode("");
    }, dom.root);

    const first = invalidateSpacesData(["view"], "1-0").then(() => acknowledgements.push("1-0"));
    await flush();
    expect(requests).toHaveLength(1);
    const second = invalidateSpacesData(["view"], "2-0").then(() => acknowledgements.push("2-0"));
    await flush();
    requests[0]!.resolve("after-first");
    await first;
    expect(acknowledgements).toEqual(["1-0"]);
    await flush();
    expect(requests).toHaveLength(2);
    requests[1]!.resolve("after-second");
    await second;
    expect(acknowledgements).toEqual(["1-0", "2-0"]);

    dispose();
    dom.cleanup();
  });

  test("shares load-more and lets canonical invalidation supersede it atomically", async () => {
    const dom = createDomTestHarness();
    type Page = { page: number; items: string[]; totalPages: number };
    const requests: Array<{ page: number; signal: AbortSignal; result: ReturnType<typeof deferred<Page>> }> = [];
    let controls!: ReturnType<typeof query.createInfinite<string, Page, number, { cursor: string | null }>>;
    const dispose = render(() => {
      controls = query.createInfinite<string, Page, number, { cursor: string | null }>({
        source: () => "kanban:todo",
        initial: { source: "kanban:todo", pages: [{ page: 1, items: ["initial"], totalPages: 2 }] },
        loadPage: (_source, { cursor, abortSignal }) => {
          const page = cursor ?? 1;
          const result = deferred<Page>();
          requests.push({ page, signal: abortSignal, result });
          return result.promise.then((loaded) => {
            if (loaded.page !== page) throw new Error("invalid repeated page");
            return loaded;
          });
        },
        getNextCursor: (page) => (page.page < page.totalPages ? page.page + 1 : null),
        subscribe: ({ invalidate }) => subscribeToSpacesDataInvalidation(["view"], invalidate),
      });
      return dom.document.createTextNode("");
    }, dom.root);

    const loadMoreA = controls.loadMore();
    const loadMoreB = controls.loadMore();
    expect(loadMoreA).toBe(loadMoreB);
    await flush();
    expect(requests.map((request) => request.page)).toEqual([2]);

    const coverage = invalidateSpacesData(["view"], "3-0");
    await flush();
    expect(requests[0]!.signal.aborted).toBe(true);
    expect(requests.map((request) => request.page)).toEqual([2, 1]);
    requests[0]!.result.resolve({ page: 2, items: ["stale"], totalPages: 2 });
    requests[1]!.result.resolve({ page: 1, items: ["fresh"], totalPages: 1 });
    await coverage;
    expect(controls.pages()).toEqual([{ page: 1, items: ["fresh"], totalPages: 1 }]);
    expect(controls.hasMore()).toBe(false);

    dispose();
    dom.cleanup();
  });

  test("retries one immutable mutation intent without rerunning intent capture", async () => {
    const payload = { itemId: "item-1", idempotencyKey: "stable-key", title: "Frozen" };
    const calls: Array<{ vars: typeof payload; correlationId: string }> = [];
    let captures = 0;
    const save = mutation.create<void, typeof payload, { correlationId: string }>({
      onBefore: () => ({ correlationId: `correlation-${++captures}` }),
      mutation: async (vars, context) => {
        calls.push({ vars, correlationId: context.correlationId });
        if (calls.length === 1) throw new Error("temporary");
      },
    });

    await save.mutate(payload);
    await save.retry();
    expect(captures).toBe(1);
    expect(calls).toEqual([
      { vars: payload, correlationId: "correlation-1" },
      { vars: payload, correlationId: "correlation-1" },
    ]);

    const pending = deferred<void>();
    let guardedCalls = 0;
    const guardedMutation = mutation.create<void, typeof payload>({
      mutation: async () => {
        guardedCalls += 1;
        await pending.promise;
      },
    });
    let submitting = false;
    const submit = async () => {
      if (submitting || guardedMutation.loading()) return;
      submitting = true;
      try {
        await guardedMutation.mutate(payload);
      } finally {
        submitting = false;
      }
    };
    const first = submit();
    const second = submit();
    expect(guardedCalls).toBe(1);
    pending.resolve();
    await Promise.all([first, second]);
  });

  test("keeps a successful write distinct from failed read reconciliation", async () => {
    const dom = createDomTestHarness();
    const failures: string[] = [];
    const stop = subscribeToSpacesDataInvalidation(["view"], async () => {
      throw new Error("refresh unavailable");
    });
    const save = mutation.create<void, { title: string }>({
      mutation: async () => undefined,
      onSuccess: () => {
        void invalidateSpacesData(["view"]).catch((error) => failures.push(error.message));
      },
    });

    await save.mutate({ title: "saved once" });
    await flush();
    expect(save.error()).toBeNull();
    expect(failures).toEqual(["refresh unavailable"]);

    stop();
    dom.cleanup();
  });
});
