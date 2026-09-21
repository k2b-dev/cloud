import { expect, test } from "bun:test";
import { createAnalyticsUi } from "./analytics-ui";
import { validateTree } from "./host";
import { RuntimeEvent, UiNode, WorkerMessage } from "./protocol";

test("UI transport accepts only the current node and event contracts", () => {
  expect(WorkerMessage.safeParse({ type: "ui", nodes: [{ id: "text", kind: "text", label: "Old" }] }).success).toBe(false);
  expect(RuntimeEvent.safeParse({ id: "input", value: "old" }).success).toBe(false);
  expect(RuntimeEvent.safeParse({ id: "list", action: "delete", item: "one" }).success).toBe(false);
  expect(RuntimeEvent.parse({ id: "input", event: { type: "change", value: 7 } }).event).toEqual({ type: "change", value: 7 });
  const runtime = createAnalyticsUi(() => {});
  expect("list" in runtime.ui).toBe(false);
  expect("workbench" in runtime.ui).toBe(false);
  expect(() => new Function("ui", 'ui.text("Old")')(runtime.ui)).toThrow();
  expect(() => new Function("ui", 'ui.button("Old", () => {})')(runtime.ui)).toThrow();
  const text = runtime.ui.text({ value: "Current" });
  expect("set" in text).toBe(false);
  expect("upsert" in text).toBe(false);
  expect(UiNode.parse(runtime.snapshot()[0]).type).toBe("text");
});

test("host validates ownership and cycles directly on UI layout nodes", () => {
  const text = UiNode.parse({ type: "text", id: "text", value: "Example" });
  const layout = (id: string, children: string[]) => UiNode.parse({ type: "layout", id, layout: "column", children });
  expect(() => validateTree([text, layout("root", [text.id])])).not.toThrow();
  expect(() => validateTree([text, layout("one", [text.id]), layout("two", [text.id])])).toThrow("multiply owned");
  expect(() => validateTree([layout("one", ["two"]), layout("two", ["one"])])).toThrow("Cyclic");
  expect(() => validateTree([layout("root", ["missing"])])).toThrow("Missing");
});
