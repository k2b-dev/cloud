import { expect, test } from "bun:test";
import { UiNode } from "../src/runtime/protocol";
import { setUiValue, upsertUiItems, removeUiItems } from "../src/runtime/ui-mutations";
import { ChartOptions } from "../src/runtime/chart-schema";
import { ModalRequest } from "../src/runtime/modal-schema";

test("lists and tables replace, upsert in order, and distinguish empty ids from clear", () => {
  for (const kind of ["list", "table"] as const) {
    const n = UiNode.parse({ id: "collection", kind, rowKey: kind === "table" ? "id" : undefined });
    const value = (id: string, title: string) => ({ id, title });
    setUiValue(n, [value("a", "A"), value("b", "B")]);
    upsertUiItems(n, [value("b", "Updated"), value("c", "C")]);
    const items = () => (n.kind === "list" ? n.items : n.rows);
    expect(items().map((item) => item.id)).toEqual(["a", "b", "c"]);
    expect(items()[1]!.title).toBe("Updated");
    const before = structuredClone(n);
    expect(() => upsertUiItems(n, [value("b", "B"), value("b", "B2")])).toThrow();
    expect(n).toEqual(before);
    removeUiItems(n, []);
    expect(n).toEqual(before);
    removeUiItems(n, ["missing", "b"]);
    expect(items().map((item) => item.id)).toEqual(["a", "c"]);
    removeUiItems(n);
    expect(items()).toEqual([]);
  }
});
test("keyed tables reject missing keys and unkeyed tables can only replace or clear", () => {
  const n = UiNode.parse({ id: "table", kind: "table" });
  setUiValue(n, [{ title: "A" }]);
  removeUiItems(n, []);
  expect(() => upsertUiItems(n, [])).toThrow("rowKey");
  expect(() => removeUiItems(n, ["a"])).toThrow("rowKey");
  removeUiItems(n);
  expect(n.rows).toEqual([]);
  n.rowKey = "id";
  expect(() => setUiValue(n, [{ title: "A" }])).toThrow();
  expect(n.rows).toEqual([]);
});
test("scalar set updates values and enforces control domains", () => {
  const input = UiNode.parse({ id: "input", kind: "input" });
  setUiValue(input, "New");
  expect(input.value).toBe("New");
  const text = UiNode.parse({ id: "text", kind: "text" });
  setUiValue(text, "New");
  expect(text.label).toBe("New");
  const progress = UiNode.parse({ id: "progress", kind: "progress" });
  expect(() => setUiValue(progress, 2)).toThrow();
  expect(() => removeUiItems(input)).toThrow();
});
test("chart transport accepts stdlib shapes and rejects code, resources and unbounded data", () => {
  expect(ChartOptions.parse({ kind: "bar", data: [{ label: "A", value: 3 }] }).kind).toBe("bar");
  expect(() => ChartOptions.parse({ kind: "line", series: [], yAxis: { format: () => "bad" } })).toThrow();
  expect(() => ChartOptions.parse({ kind: "gauge", value: 3, thresholds: [{ value: 1, color: "url(https://example.com)" }] })).toThrow();
  expect(() => ChartOptions.parse({ kind: "line", series: [{ data: Array.from({ length: 1000 }, () => ({ x: 1, y: 2 })) }] })).toThrow();
});
test("modals require visible titles and valid bounded field schemas", () => {
  expect(() => ModalRequest.parse({ kind: "confirm", title: " ", message: "Sure?" })).toThrow();
  expect(() => ModalRequest.parse({ kind: "number", title: "Count", label: "Count", min: 5, max: 2 })).toThrow();
  expect(() =>
    ModalRequest.parse({
      kind: "dialog",
      title: "New",
      fields: { priority: { type: "select", label: "Priority", options: [{ value: "1" }] } },
    }),
  ).toThrow();
  expect(
    ModalRequest.parse({ kind: "dialog", title: "New", fields: { title: { type: "text", label: "Title", required: true } } }).kind,
  ).toBe("dialog");
});
