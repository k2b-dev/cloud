import { expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../../ui/test/dom";

(isServer ? test.skip : test)("vital charts synchronize inspection and leave missing metrics empty", async () => {
  const dom = createDomTestHarness();
  const { buildVitalCharts } = await import("./charts");
  const { default: VitalCharts } = await import("./VitalCharts.island");
  const charts = buildVitalCharts(
    {
      summary: [],
      routes: [],
      totalRoutes: 0,
      page: 1,
      perPage: 50,
      series: [
        { name: "LCP", bucket: 1700000000000, p75: 125, count: 2 },
        { name: "INP", bucket: 1700000000000, p75: 20, count: 3 },
        { name: "CLS", bucket: 1699999700000, p75: 0, count: 1 },
      ],
    },
    "en",
    "1h",
    1700002000000,
  );
  for (const item of charts) item.data.chart.svg = item.data.chart.svg.replace(/<style>[\s\S]*?<\/style>/g, "");
  const dispose = render(() => createComponent(VitalCharts, { charts }), dom.root);
  try {
    await Promise.resolve();
    const targets = dom.root.querySelectorAll('.k2b-chart[tabindex="0"]');
    expect(targets).toHaveLength(3);
    targets[0]!.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    await Promise.resolve();
    // Each chart also has action tooltips such as "Copy data"; read the chart's own inspection tooltip.
    const tips = Array.from(targets, (target) => target.querySelector('[role="tooltip"]'));
    expect(tips[0]!.textContent).toContain("125 ms");
    expect(tips[1]!.textContent).toContain("20 ms");
    expect(tips[2]!.textContent).not.toContain("p75");
    targets[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await Promise.resolve();
    expect(targets[1]!.hasAttribute("aria-describedby")).toBe(false);
  } finally {
    dispose();
    dom.cleanup();
  }
});
