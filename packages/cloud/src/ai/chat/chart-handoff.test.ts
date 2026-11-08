import { expect, test } from "bun:test";
import { createDomTestHarness } from "../../../../ui/test/dom";
import { chartHandoff, drawingKey } from "./chart-handoff";

test("handoff keys stay short for a full chart and stable across property order", () => {
  const data = Array.from({ length: 3840 }, (_, index) => ({ x: index, y: index * 13 }));
  const args = { kind: "line", title: "Daily orders 📈", series: [{ data }] };
  const key = drawingKey("Block", { args, completed: true });
  expect(key).toMatch(/^[0-9a-f]{16}$/);
  expect(drawingKey("Block", { completed: true, args: { series: [{ data }], title: args.title, kind: "line" } })).toBe(key);
  expect(drawingKey("Block", { args: { ...args, series: [{ data: [...data, { x: 3840, y: null }] }] }, completed: true })).not.toBe(key);
  expect(drawingKey("View", { args, completed: true })).not.toBe(key);
});

test("server drawing handoff belongs to its document, including a fresh DOM test window", async () => {
  for (let documentIndex = 0; documentIndex < 2; documentIndex++) {
    const dom = createDomTestHarness();
    try {
      const take = chartHandoff();
      expect(chartHandoff()).toBe(take);
      dom.root.innerHTML =
        '<cloud-chart-drawing data-cloud-chart-server data-cloud-chart-key="fixture"><div class="k2b-chart__svg"><svg xmlns="http://www.w3.org/2000/svg"></svg></div></cloud-chart-drawing>';
      const server = dom.root.querySelector<HTMLElement>("cloud-chart-drawing");
      if (!server) throw new Error("Expected the server drawing fixture");
      dom.root.replaceChildren();
      expect(take("fixture")).toBe(server);
      expect(take("fixture")).toBeUndefined();
      // A claimed node may be reinserted and disposed, but must never be handed to another chart.
      dom.root.append(server);
      dom.root.replaceChildren();
      expect(take("fixture")).toBeUndefined();
      dom.root.innerHTML =
        '<cloud-chart-drawing data-cloud-chart-server data-cloud-chart-key="unclaimed"><div class="k2b-chart__svg"><svg xmlns="http://www.w3.org/2000/svg"></svg></div></cloud-chart-drawing>';
      dom.root.replaceChildren();
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      expect(take("unclaimed")).toBeUndefined();
    } finally {
      dom.cleanup();
    }
  }
});
