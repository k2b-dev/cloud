import { expect, test } from "bun:test";
import chartReference from "../../skills/assistant-code-mode/references/charts.md" with { type: "text" };
import { chart, chartRendererKind } from "./lib";

test("cloud.chart preserves nested dot counts and grey capacity in Code scripts", () => {
  const markup = String(
    chart(
      {
        kind: "bar",
        title: "Campaign",
        marks: "dots",
        layout: "nested",
        total: 100,
        dots: 20,
        x: ["A"],
        series: [
          { label: "Opened", data: [80] },
          { label: "Clicked", data: [30] },
        ],
      },
      "de-DE",
    ),
  );
  expect(markup.match(/class="k2b-chart-dot"/g)).toHaveLength(20);
  expect(markup).toContain('data-dot-series="remainder"');
  expect(markup).toContain("Gesamt");
  expect(markup).not.toContain("<style>");
});

test("only dot matrices load the dots part while ordinary bars retain the immediate renderer", () => {
  expect(chartRendererKind({ kind: "bar", title: "Counts", marks: "dots", layout: "nested", data: [] })).toBe("dots");
  expect(chartRendererKind({ kind: "bar", title: "Counts", data: [] })).toBe("bar");
  expect(chartRendererKind({ kind: "histogram", title: "Counts", data: [1, 2] })).toBe("histogram");
});

test("Code script share legends keep the latest month instead of summing percentages", () => {
  const markup = String(
    chart(
      {
        kind: "bar",
        title: "Newsletter",
        marks: "dots",
        layout: "nested",
        total: 1,
        dots: 20,
        x: ["Jan", "Feb", "Mar"],
        format: { style: "percent" },
        series: [
          { label: "Opened", data: [0.5, 0.6, 0.7] },
          { label: "Clicked", data: [0.2, 0.3, 0.4] },
        ],
      },
      "en",
    ),
  );
  expect(markup).toContain('data-default="70%"');
  expect(markup).toContain('data-default="40%"');
  expect(markup).not.toContain('data-default="180%"');
});

test("the retained chart reference's nested dots example renders exact counts", () => {
  const example = [...chartReference.matchAll(/```js\n([\s\S]*?)\n```/g)]
    .map((match) => match[1]!)
    .find((code) => code.includes('marks: "dots"'));
  expect(example).toBeDefined();
  const markup = String(
    new Function("cloud", `${example!}; return engagement;`)({ chart: (options: Parameters<typeof chart>[0]) => chart(options, "en-US") }),
  );
  expect(markup.match(/class="k2b-chart-dot"/g)).toHaveLength(40);
  expect(markup).toContain('data-dot-series="remainder"');
  expect(markup).toContain("Opened");
  expect(markup).toContain("Clicked");
});
