import { describe, expect, test } from "bun:test";
import { createSignal } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../ui/test/dom";
import type { ExplorerResultView, QueryHistoryEntry } from "./types";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
};

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("Pulse query controller", () => {
  if (isServer) {
    test.skip("runs with browser export conditions", () => {});
    return;
  }

  test("aborts a stale canonical query read and applies only the latest intent", async () => {
    const dom = createDomTestHarness();
    const { createQueryController } = await import("./query-controller");
    const originalFetch = globalThis.fetch;
    const requests: Array<{ body: string; signal: AbortSignal; response: ReturnType<typeof deferred<Response>> }> = [];
    globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => {
      const response = deferred<Response>();
      requests.push({ body: String(init?.body), signal: init?.signal as AbortSignal, response });
      return response.promise;
    }) as typeof fetch;

    let controller!: ReturnType<typeof createQueryController>;
    const [queryText, setQueryText] = createSignal("");
    const [queryHistory, setQueryHistory] = createSignal<QueryHistoryEntry[]>([]);
    const [resultView, setResultView] = createSignal<ExplorerResultView>("chart");
    const [points, setPoints] = createSignal<Array<{ bucket: string; value: number | null }>>([]);
    const [lastRun, setLastRun] = createSignal("");
    const dispose = render(() => {
      controller = createQueryController({
        selectedBaseId: () => "base-1",
        metrics: () => [],
        queryText,
        setQueryText,
        defaultQueryText: () => "",
        queryHistory,
        setQueryHistory,
        compiledQuery: () => null,
        explorerResultView: resultView,
        setExplorerResultView: setResultView,
        setSelectedMetric: () => "",
        setSelectedAggregation: () => "avg",
        setSelectedBucket: () => "5m",
        setSelectedSince: () => "24h",
        setSelectedQuerySourceId: () => "",
        setPoints,
        setExplorerEvents: () => [],
        setExplorerStates: () => [],
        setQueryDiagnostics: () => null,
        setLastRunQuery: setLastRun,
        setQueryRunning: () => false,
        loading: () => false,
        setLoading: () => false,
        refreshBaseData: () => Promise.resolve(),
        writeBlocked: () => false,
        selectedVisual: () => "line",
        browseSourceId: () => "",
        browseResourceKey: () => "",
        openExplorer: () => undefined,
      });
      return dom.document.createTextNode("");
    }, dom.root);

    try {
      const first = controller.run({ query: "metric first", remember: false });
      await flush();
      expect(requests).toHaveLength(1);

      const second = controller.run({ query: "metric second", remember: false });
      await flush();
      expect(requests).toHaveLength(2);
      expect(requests[0]!.signal.aborted).toBe(true);
      expect(JSON.parse(requests[1]!.body)).toEqual({ baseId: "base-1", query: "metric second" });

      requests[1]!.response.resolve(
        Response.json({
          compiled: { kind: "metric", baseId: "base-1", metric: "second", aggregation: "avg", bucket: "5m", since: "24h" },
          points: [{ bucket: "now", value: 2 }],
          events: [],
          states: [],
        }),
      );
      await second;
      await first;
      expect(lastRun()).toBe("metric second");
      expect(points()).toEqual([{ bucket: "now", value: 2 }]);
    } finally {
      dispose();
      globalThis.fetch = originalFetch;
      dom.cleanup();
    }
  });

  test("does not apply a pending query result after owner disposal", async () => {
    const dom = createDomTestHarness();
    const { createQueryController } = await import("./query-controller");
    const originalFetch = globalThis.fetch;
    const request = deferred<Response>();
    let signal: AbortSignal | undefined;
    globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => {
      signal = init?.signal as AbortSignal;
      return request.promise;
    }) as typeof fetch;

    let controller!: ReturnType<typeof createQueryController>;
    const [queryText, setQueryText] = createSignal("");
    const [lastRun, setLastRun] = createSignal("");
    const dispose = render(() => {
      controller = createQueryController({
        selectedBaseId: () => "base-1",
        metrics: () => [],
        queryText,
        setQueryText,
        defaultQueryText: () => "",
        queryHistory: () => [],
        setQueryHistory: () => [],
        compiledQuery: () => null,
        explorerResultView: () => "chart",
        setExplorerResultView: () => "chart",
        setSelectedMetric: () => "",
        setSelectedAggregation: () => "avg",
        setSelectedBucket: () => "5m",
        setSelectedSince: () => "24h",
        setSelectedQuerySourceId: () => "",
        setPoints: () => [],
        setExplorerEvents: () => [],
        setExplorerStates: () => [],
        setQueryDiagnostics: () => null,
        setLastRunQuery: setLastRun,
        setQueryRunning: () => false,
        loading: () => false,
        setLoading: () => false,
        refreshBaseData: () => Promise.resolve(),
        writeBlocked: () => false,
        selectedVisual: () => "line",
        browseSourceId: () => "",
        browseResourceKey: () => "",
        openExplorer: () => undefined,
      });
      return dom.document.createTextNode("");
    }, dom.root);

    try {
      const running = controller.run({ query: "metric pending", remember: false });
      await flush();
      dispose();
      await running;
      expect(signal?.aborted).toBe(true);
      expect(lastRun()).toBe("");
    } finally {
      globalThis.fetch = originalFetch;
      dom.cleanup();
    }
  });
});
