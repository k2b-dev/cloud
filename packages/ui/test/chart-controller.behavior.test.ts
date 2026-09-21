import { describe, expect, test } from "bun:test";
import { createRoot, createSignal } from "solid-js";
import { isServer } from "solid-js/web";
import { type ChartExplorerRequest, createChartExplorer } from "../src/content/chart-explorer";

const make = (request: ChartExplorerRequest = {}, keys = ["a", "b"]) => ({
  request,
  charts: {
    latency: {
      rows: keys.map((key) => ({ key, ms: 42 })),
      chart: {
        kind: "scatter" as const,
        svg: "<svg/>",
        width: 480,
        height: 280,
        stretch: true,
        marks: keys.flatMap((rowKey, index) =>
          ["current", "reference"].map((phase, offset) => ({
            key: `${rowKey}:${phase}`,
            rowKey,
            datum: { role: "point" as const, index: index * 2 + offset, anchor: [0, 0] as [number, number], values: [] },
            tooltip: { rows: [] },
          })),
        ),
      },
    },
    traffic: {
      rows: keys.map((key) => ({ key, requests: 100 })),
      chart: { kind: "bar" as const, svg: "<svg/>", width: 480, height: 280, stretch: true, marks: [] },
    },
  },
});
type Snapshot = ReturnType<typeof make>;
const tick = async () => {
  await Promise.resolve();
  await Promise.resolve();
};
describe("chart controller", () => {
  if (isServer) {
    test.skip("requires browser conditions", () => {});
    return;
  }
  test("one request owner preserves concrete chart and row types, supports no slider and synchronous refresh", async () => {
    let calls = 0;
    const owner = createRoot((dispose) => ({
      dispose,
      explorer: createChartExplorer({
        snapshot: () => make(),
        load: (request) => {
          calls++;
          return make(request);
        },
      }),
    }));
    const e = owner.explorer;
    expect(e.snapshot().charts.latency.rows[0]!.ms).toBe(42);
    expect(e.snapshot().charts.traffic.rows[0]!.requests).toBe(100);
    e.setRequest({});
    await tick();
    expect(calls).toBe(0);
    await e.refresh();
    await e.refresh();
    expect(calls).toBe(2);
    e.select("a");
    expect(e.selectedKey()).toBe("a");
    expect(calls).toBe(2);
    e.pinReference();
    expect(calls).toBe(2);
    owner.dispose();
    await e.refresh();
    expect(calls).toBe(2);
  });
  test("latest complete response wins and superseded requests are aborted", async () => {
    const pending: { request: ChartExplorerRequest; signal: AbortSignal; resolve: (s: Snapshot) => void }[] = [];
    const owner = createRoot((dispose) => ({
      dispose,
      explorer: createChartExplorer({
        snapshot: () => make({ step: "08" }),
        load: (request, signal) => new Promise<Snapshot>((resolve) => pending.push({ request, signal, resolve })),
      }),
    }));
    const e = owner.explorer;
    e.setRequest({ step: "10" });
    e.setRequest({ step: "11" });
    expect(pending[0]!.signal.aborted).toBe(true);
    expect(e.snapshot().request.step).toBe("08");
    pending[1]!.resolve(make({ step: "11" }));
    await tick();
    pending[0]!.resolve(make({ step: "10" }));
    await tick();
    expect(e.snapshot().request.step).toBe("11");
    expect(e.loading()).toBe(false);
    owner.dispose();
  });
  test("errors retain their cause and every chart; retry is a forced fresh request", async () => {
    const failure = new Error("network offline");
    let fails = true;
    const owner = createRoot((dispose) => ({
      dispose,
      explorer: createChartExplorer({
        snapshot: () => make(),
        load: (request) => {
          if (fails) throw failure;
          return make(request);
        },
      }),
    }));
    const e = owner.explorer;
    await e.refresh();
    expect(e.error()).toBe(failure);
    expect(e.snapshot().charts.latency.rows).toHaveLength(2);
    fails = false;
    await e.retry();
    expect(e.error()).toBeNull();
    owner.dispose();
  });
  test("mismatched filters, partial charts and orphan row mappings never replace visible data", async () => {
    let result = make({ step: "wrong" });
    const owner = createRoot((dispose) => ({ dispose, explorer: createChartExplorer({ snapshot: () => make(), load: () => result }) }));
    const e = owner.explorer;
    e.setRequest({ step: "10" });
    await tick();
    expect(e.error()?.message).toContain("filters");
    result = make({ step: "10" });
    delete (result.charts as Partial<Snapshot["charts"]>).traffic;
    await e.retry();
    expect(e.error()?.message).toContain("every configured");
    result = make({ step: "10" });
    result.charts.latency.chart.marks[0]!.rowKey = "orphan";
    await e.retry();
    expect(e.error()?.message).toContain("mark.rowKey");
    expect(e.snapshot().request).toEqual({});
    owner.dispose();
  });
  test("controlled filters and selection wait for their owner; replacements cancel and reload the desired filters", async () => {
    const [request, setRequest] = createSignal<ChartExplorerRequest>({ step: "08" });
    const [key, setKey] = createSignal<string | null>(null);
    const changes: ChartExplorerRequest[] = [];
    let calls = 0;
    const owner = createRoot((dispose) => ({
      dispose,
      explorer: createChartExplorer({
        snapshot: () => make({ step: "08" }),
        request,
        onRequestChange: (next) => changes.push(next),
        selectedKey: key,
        onSelectedKeyChange: setKey,
        load: (next) => {
          calls++;
          return make(next);
        },
      }),
    }));
    const e = owner.explorer;
    e.setRequest({ step: "09" });
    await tick();
    expect(calls).toBe(0);
    expect(changes).toHaveLength(1);
    setRequest(changes[0]!);
    await tick();
    expect(e.snapshot().request.step).toBe("09");
    e.select("a");
    expect(key()).toBe("a");
    owner.dispose();
  });
  test("replacement cancels pending work and selection survives only while a row exists somewhere", async () => {
    const [source, setSource] = createSignal(make({ step: "08" }));
    let signal: AbortSignal | undefined;
    const owner = createRoot((dispose) => ({
      dispose,
      explorer: createChartExplorer({
        snapshot: source,
        load: (_r, s) => {
          signal = s;
          return new Promise<Snapshot>(() => {});
        },
      }),
    }));
    const e = owner.explorer;
    e.select("a");
    e.setRequest({ step: "10" });
    const replacement = make({ step: "09" });
    replacement.charts.latency.rows = [];
    replacement.charts.latency.chart.marks = [];
    setSource(replacement);
    await tick();
    expect(signal?.aborted).toBe(true);
    expect(e.selectedKey()).toBe("a");
    setSource(make({ step: "09" }, ["b"]));
    await tick();
    expect(e.selectedKey()).toBeNull();
    owner.dispose();
  });
  test("pinning captures displayed time, series filters apply to both periods and empty differs from omitted", async () => {
    const owner = createRoot((dispose) => ({
      dispose,
      explorer: createChartExplorer({ snapshot: () => make({ step: "08" }), load: (request) => make(request) }),
    }));
    const e = owner.explorer;
    e.pinReference();
    await tick();
    expect(e.snapshot().request.referenceStep).toBe("08");
    e.setRequest({ ...e.desired(), step: "20", visibleKeys: [] });
    await tick();
    expect(e.snapshot().request).toEqual({ step: "20", referenceStep: "08", visibleKeys: [] });
    e.clearReference();
    await tick();
    expect(e.snapshot().request.referenceStep).toBeUndefined();
    e.setRequest({ step: "20" });
    await tick();
    expect(e.snapshot().request.visibleKeys).toBeUndefined();
    owner.dispose();
  });
});
