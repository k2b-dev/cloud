import { expect, test } from "bun:test";
import { drawingKey } from "./chart-handoff";

test("handoff keys stay short for a full chart and stable across property order", () => {
  const data = Array.from({ length: 3840 }, (_, index) => ({ x: index, y: index * 13 }));
  const args = { kind: "line", title: "Daily orders 📈", series: [{ data }] };
  const key = drawingKey("Block", { args, completed: true });
  expect(key).toMatch(/^[0-9a-f]{16}$/);
  expect(drawingKey("Block", { completed: true, args: { series: [{ data }], title: args.title, kind: "line" } })).toBe(key);
  expect(drawingKey("Block", { args: { ...args, series: [{ data: [...data, { x: 3840, y: null }] }] }, completed: true })).not.toBe(key);
  expect(drawingKey("View", { args, completed: true })).not.toBe(key);
});
