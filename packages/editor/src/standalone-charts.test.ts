import { expect, test } from "bun:test";
import { chartSvgWithUiPalette } from "@k2b/ui/charts/core";
import { chartKinds } from "./charts";
import { renderNotebookChartFigure } from "./markdown/lib/chart-blocks";

test.each(["pie", "donut", "bar", "line"])("%s print SVG uses the UI palette and styled Book drawing stays unchanged", (kind) => {
  const data = Array.from({ length: 8 }, (_, index) => ({ label: `Series ${index + 1}`, value: index + 1 }));
  const input = chartKinds().parse({
    kind,
    title: "Invented values",
    ...(kind === "line"
      ? {
          series: data.map((item) => ({
            name: item.label,
            data: [
              { x: 0, y: item.value },
              { x: 1, y: item.value + 1 },
            ],
          })),
        }
      : { data }),
  });
  const screen = renderNotebookChartFigure(input, "en")!;
  const print = renderNotebookChartFigure(input, "en", { print: true })!;
  const screenSvg = screen.match(/<svg\b[\s\S]*?<\/svg>/)![0];
  const printSvg = print.match(/<svg\b[\s\S]*?<\/svg>/)![0];
  expect(screenSvg).toContain("--stdlib-chart-c4: #ef4444;");
  expect(printSvg).toContain("--stdlib-chart-c4: #8b5cf6;");
  expect(printSvg).toBe(chartSvgWithUiPalette(screenSvg));
  expect(print).toContain('<table class="md-table">');
});
