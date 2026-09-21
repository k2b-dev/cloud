import { expect, test } from "bun:test";
import { AnalyticsNode, ExplorerData, type ExplorerSnapshot, Format, formatValue, SourceContext } from "./analytics-contracts";
import { createAnalyticsUi } from "./analytics-ui";

const data = (value = 3): ExplorerData =>
  ExplorerData.parse({ rowKey: "id", rows: [{ id: "a", name: "A", value }], chart: { kind: "bar", category: "name", value: "value" } });
const snapshot = (step: string, value = 3): ExplorerSnapshot => ({
  request: { step },
  charts: { first: data(value), second: data(value * 2) },
});
test("typed controls validate changes and retain typed values without callback on setter", async () => {
  const runtime = createAnalyticsUi(() => {});
  const changes: number[] = [];
  const slider = runtime.ui.slider({
    id: "slider",
    label: "Range",
    value: 2,
    min: 0,
    max: 10,
    onChange: (value) => {
      changes.push(value);
    },
  });
  slider.setValue(4);
  expect(slider.getValue()).toBe(4);
  expect(changes).toEqual([]);
  await runtime.event("slider", { type: "change", value: 6 });
  expect(changes).toEqual([6]);
  await expect(runtime.event("slider", { type: "change", value: 11 })).rejects.toThrow();
  expect(slider.getValue()).toBe(6);
  const select = runtime.ui.multiSelect({ value: ["one"], options: [{ value: "one", label: "One" }] });
  expect(() => select.setValue(["two"])).toThrow();
  const text = runtime.ui.text({ value: "Hello" });
  expect("upsert" in text).toBe(false);
  runtime.ui.grid({ children: [text, slider] });
  expect(() => runtime.ui.column({ children: [text] })).toThrow();
});
test("explorer replaces charts atomically, ignores obsolete loads and preserves valid shared selection", async () => {
  const history: AnalyticsNode[][] = [];
  const runtime = createAnalyticsUi((nodes) => history.push(structuredClone(nodes)));
  const loads = new Map<string, { resolve: (value: ExplorerSnapshot) => void; signal: AbortSignal }>();
  const group = runtime.ui.explorer({
    id: "group",
    snapshot: snapshot("a"),
    load: (request, { signal }) => new Promise((resolve) => loads.set(request.step!, { resolve, signal })),
  });
  group.chart("first", { id: "first", label: "First", columns: [{ key: "value", label: "Value" }] });
  group.chart("second", { id: "second", label: "Second", columns: [{ key: "value", label: "Value" }] });
  group.select("a");
  const slow = group.setRequest({ step: "slow" });
  const fast = group.setRequest({ step: "fast" });
  expect(loads.get("slow")?.signal.aborted).toBe(true);
  loads.get("fast")!.resolve(snapshot("fast", 9));
  await fast;
  loads.get("slow")!.resolve(snapshot("slow", 1));
  await slow;
  const views = runtime.snapshot().filter((node) => node.type === "explorer");
  expect(views.map((view) => view.data.rows[0]?.value)).toEqual([9, 18]);
  expect(views.map((view) => view.selectedKey)).toEqual(["a", "a"]);
  for (const published of history) {
    const views = published.filter((node) => node.type === "explorer");
    if (views.length === 2) expect(Number(views[1]!.data.rows[0]?.value)).toBe(Number(views[0]!.data.rows[0]?.value) * 2);
  }
  const failed = group.setRequest({ step: "bad" });
  loads.get("bad")!.resolve(snapshot("wrong"));
  await failed;
  expect(runtime.snapshot().find((node) => node.type === "group")?.error).toContain("filters");
  expect(runtime.snapshot().find((node) => node.type === "explorer")?.data.rows[0]?.value).toBe(9);
});
test("formats keep units and time interpretation explicit", () => {
  expect(formatValue(0.125, Format.parse({ type: "percent", input: "fraction", maximumFractionDigits: 1 }), "en-US")).toBe("12.5%");
  expect(formatValue(12.5, Format.parse({ type: "percent", input: "percent", maximumFractionDigits: 1 }), "en-US")).toBe("12.5%");
  expect(formatValue(10, Format.parse({ type: "currency", currency: "EUR" }), "en-US")).toBe("€10.00");
  expect(() => formatValue("2026-01-01", Format.parse({ type: "date", timeZone: "UTC" }), "en")).toThrow("epoch");
  expect(Format.safeParse({ type: "date", timeZone: "invalid" }).success).toBe(false);
  expect(formatValue(null, undefined, "de")).toBe("—");
});
test("source context and derived marks reject ambiguous or untrusted input", () => {
  expect(
    SourceContext.safeParse({ mode: "snapshot", asOf: new Date().toISOString(), status: "partial", sources: [{ label: "CSV" }] }).success,
  ).toBe(false);
  expect(
    SourceContext.safeParse({
      mode: "snapshot",
      asOf: new Date().toISOString(),
      sources: [{ label: "API", href: "https://user:password@example.com" }],
    }).success,
  ).toBe(false);
  expect(ExplorerData.safeParse({ ...data(), chart: { options: { kind: "histogram", data: [1, 2] } } }).success).toBe(false);
  expect(ExplorerData.safeParse({ ...data(), rows: [{ id: "a" }, { id: "a" }] }).success).toBe(false);
  expect(
    AnalyticsNode.safeParse({ id: "chart", type: "chart", data: { options: { kind: "bar", data: [] }, svg: "<script>" } }).success,
  ).toBe(false);
});

test("standalone explorer emits row selections and view changes", async () => {
  const runtime = createAnalyticsUi(() => {});
  const output = runtime.ui.text({ id: "output", value: "Before" });
  runtime.ui.chartExplorer({
    id: "chart",
    data: data(),
    columns: [{ key: "value", label: "Value" }],
    onSelect: (row) => output.setValue(String(row?.value)),
  });
  await runtime.event("chart", { type: "view", value: "table" });
  await runtime.event("chart", { type: "select", key: "a" });
  expect(runtime.snapshot().find((node) => node.id === "output")).toMatchObject({ value: "3" });
  expect(runtime.snapshot().find((node) => node.id === "chart")).toMatchObject({ view: "table", selectedKey: "a" });
});

test("comparisons are explicit and pending buttons cannot execute twice", async () => {
  const runtime = createAnalyticsUi(() => {});
  let seen: unknown;
  const group = runtime.ui.explorer({
    snapshot: snapshot("a"),
    comparison: true,
    load: (request) => {
      seen = request;
      return { ...snapshot(request.step!), request };
    },
  });
  await group.pinReference();
  expect(seen).toEqual({ step: "a", referenceStep: "a" });
  await group.clearReference();
  expect(seen).toEqual({ step: "a" });
  const disabled = runtime.ui.explorer({ snapshot: snapshot("a"), load: (request) => ({ ...snapshot(request.step!), request }) });
  await expect(disabled.pinReference()).rejects.toThrow("not enabled");
  const gate = Promise.withResolvers<void>();
  let calls = 0;
  const button = runtime.ui.button({
    label: "Send",
    onClick: async () => {
      calls++;
      await gate.promise;
    },
  });
  const first = runtime.event(button.id, { type: "change", value: null });
  await expect(runtime.event(button.id, { type: "change", value: null })).rejects.toThrow();
  gate.resolve();
  await first;
  expect(calls).toBe(1);
});

test("file picker uses the host and returns typed files only to its callback", async () => {
  const file = new File(["hello"], "input.csv");
  let selected: File[] = [];
  const runtime = createAnalyticsUi(
    () => {},
    async () => [file],
  );
  const picker = runtime.ui.filePicker({
    label: "Choose CSV",
    accept: ".csv",
    onChange: (files) => {
      selected = files;
    },
  });
  await runtime.event(picker.id, { type: "change", value: null });
  expect(selected).toEqual([file]);
  expect(runtime.snapshot()[0]).toMatchObject({ type: "filePicker", names: "input.csv", loading: false });
  expect(JSON.stringify(runtime.snapshot())).not.toContain("hello");
});

test("unchanged filters reuse the snapshot while explicit refresh loads again", async () => {
  let loads = 0;
  const runtime = createAnalyticsUi(() => {});
  const group = runtime.ui.explorer({
    snapshot: snapshot("a"),
    load: (request) => {
      loads++;
      return { ...snapshot(request.step!), request };
    },
  });
  await group.setRequest({ step: "a" });
  expect(loads).toBe(0);
  await group.refresh();
  expect(loads).toBe(1);
});

test("KPI handles retain raw numeric values, default to unavailable and reject invalid updates", () => {
  const runtime = createAnalyticsUi(() => {});
  const stat = runtime.ui.stat({ id: "revenue", label: "Revenue", format: { type: "currency", currency: "EUR" } });
  expect(runtime.snapshot()[0]).toMatchObject({ type: "stat", value: null });
  stat.setValue(123.4567);
  expect(runtime.snapshot()[0]).toMatchObject({ value: 123.4567 });
  stat.setOptions({ description: "Validated snapshot", trend: [1, 2, 3] });
  stat.setLoading(true);
  expect(runtime.snapshot()[0]).toMatchObject({ loading: true, description: "Validated snapshot", trend: [1, 2, 3] });
  expect(() => stat.setValue(Number.NaN)).toThrow();
  expect(runtime.snapshot()[0]).toMatchObject({ value: 123.4567 });
  expect(() => runtime.ui.text({ id: "revenue", value: "duplicate" })).toThrow('Duplicate UI id "revenue"');
});

test("inspection reports only supported interactive nodes", async () => {
  const { analyticsInteractions } = await import("./analytics-inspect");
  const chart = { id: "chart", type: "chart", data: { options: { kind: "bar", data: [{ label: "A", value: 3 }] } } };
  expect(analyticsInteractions(AnalyticsNode.parse(chart))).toEqual([]);
  expect(
    analyticsInteractions(
      AnalyticsNode.parse({ ...chart, data: { ...chart.data, marks: [{ role: "item", index: 0, key: "a", rowKey: "a" }] } }),
    ),
  ).toHaveLength(1);
  expect(analyticsInteractions(AnalyticsNode.parse({ id: "stat", type: "stat", label: "Total", value: 3 }))).toEqual([]);
  expect(analyticsInteractions(AnalyticsNode.parse({ id: "pick", type: "filePicker", label: "Choose" }))).toEqual([{ id: "pick" }]);
  expect(analyticsInteractions(AnalyticsNode.parse({ id: "button", type: "button", label: "Refresh", disabled: true }))).toEqual([]);
  expect(
    analyticsInteractions(AnalyticsNode.parse({ id: "slider", type: "slider", label: "Range", min: 0, max: 10, value: 3 })),
  ).toHaveLength(1);
});
