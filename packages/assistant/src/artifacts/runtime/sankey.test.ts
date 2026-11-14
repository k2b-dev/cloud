import { expect, test } from "bun:test";
import { chart, chartOptions, chartSvg } from "./lib";

const spec = {
  kind: "sankey",
  title: "Paths after the click",
  subtitle: "Fictional newsletter",
  nodes: [
    { id: "a", label: "Clicked" },
    { id: "b", label: "Read" },
  ],
  links: [{ source: "a", target: "b", value: 1200 }],
};
test("cloud.chart preserves one header, source-first scrolling, width and locale validation", () => {
  const markup = String(chart(spec, "en"));
  expect(markup).toContain('class="stdlib-chart-title"');
  expect(markup).toContain("Fictional newsletter");
  expect(markup).not.toContain("direction:rtl");
  expect(markup).not.toContain('data-chart-scroll="end"');
  expect(() => chart({ ...spec, locale: "de_DE" }, "en")).toThrow();
  const id = [...chartOptions.keys()].at(-1)!;
  expect(chartSvg(chartOptions.get(id)!, "en", 900, 280)).toContain('viewBox="0 0 900 280"');
});
