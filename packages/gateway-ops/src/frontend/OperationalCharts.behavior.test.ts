import { expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../ui/test/dom";

(isServer ? test.skip : test)("shared inspection preserves units, missing samples, links and table controls", async () => {
  const dom = createDomTestHarness();
  const { prepareOperationalCharts } = await import("./operational-charts");
  const { default: OperationalCharts } = await import("./OperationalCharts.island");
  const charts = prepareOperationalCharts(
    [
      {
        kind: "line",
        title: "Requests",
        series: [{ label: "Requests", data: [{ x: 0, y: 12345 }] }],
        href: "/admin/observability/logs?window=1h",
        linkLabel: "Open logs",
      },
      { kind: "line", title: "Latency", unit: "ms", series: [{ label: "Average", data: [{ x: 0, y: 125 }] }] },
      { kind: "line", title: "Missing", series: [{ label: "Missing", data: [{ x: 60000, y: 7 }] }] },
    ],
    "en",
  );
  for (const chart of charts) chart.data.chart.svg = chart.data.chart.svg.replace(/<style>[\s\S]*?<\/style>/g, "");
  const dispose = render(() => createComponent(OperationalCharts, { charts, columns: 3 }), dom.root);
  try {
    await Promise.resolve();
    const targets = dom.root.querySelectorAll('.k2b-chart[tabindex="0"]');
    targets[0]!.dispatchEvent(new dom.window.FocusEvent("focusin", { bubbles: true }));
    await Promise.resolve();
    const tips = dom.root.querySelectorAll('.k2b-chart__tooltip[role="tooltip"]');
    expect(tips[0]!.textContent).toContain("12,345");
    expect(tips[1]!.textContent).toContain("125 ms");
    expect(tips[2]!.textContent).not.toContain("7");
    expect(dom.root.querySelector("a")!.getAttribute("href")).toBe("/admin/observability/logs?window=1h");
    targets[0]!.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(targets[1]!.hasAttribute("aria-describedby")).toBe(false);
    expect(dom.root.querySelectorAll('button[aria-label="Chart view"]')).toHaveLength(3);
  } finally {
    dispose();
    dom.cleanup();
  }
});
