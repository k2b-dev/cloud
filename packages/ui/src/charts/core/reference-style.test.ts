import { expect, test } from "bun:test";
import { renderBarChartSvg } from "./bar-render";
import { type ChartDrawingOptions, renderChartSvg } from "./render";
import { line, type ReferenceLine, referenceLineAttributes } from "./svg";

const series = [
  {
    data: [
      { x: 1, y: 1 },
      { x: 5, y: 5 },
    ],
  },
];

test("reference lines have independent solid, dashed and dotted styles and semantic tones", () => {
  const references: ReferenceLine[] = [
    { value: 2, label: "Target & <minimum>", style: "solid", tone: "success" },
    { value: 3, axis: "x", label: "Forecast", style: "dashed", tone: "info" },
    { value: 4, label: "Limit", style: "dotted", tone: "danger" },
  ];
  const svg = line({ series, references });
  const marks = [...svg.matchAll(/<line class="stdlib-chart-reference"([^>]+)>/g)].map((match) => match[1]);
  expect(marks).toHaveLength(3);
  expect(marks[0]).toContain('style="stroke-dasharray:none;color:var(--k2b-success-text,#047857)"');
  expect(marks[1]).toContain('style="stroke-dasharray:4 4;color:var(--k2b-info-text,#1d4ed8)"');
  expect(marks[2]).toContain('style="stroke-dasharray:1 3;stroke-linecap:round;color:var(--k2b-danger-text,#b91c1c)"');
  expect(svg).toContain('class="stdlib-chart-reference-label" style="color:var(--k2b-success-text,#047857)"');
  expect(svg).toContain("Target &amp; &lt;minimum&gt;");
  expect(referenceLineAttributes({ value: 2 })).toBe("");
  expect(line({ series, references: [{ value: 2, style: undefined, tone: undefined }] })).toBe(
    line({ series, references: [{ value: 2 }] }),
  );
});

test("reference styles reach all cartesian renderers and both UI bar layouts", () => {
  const references: ReferenceLine[] = [{ value: 3, style: "dotted", tone: "warning" }];
  const specs: ChartDrawingOptions[] = [
    { kind: "line", series, references },
    { kind: "scatter", series, references },
    { kind: "bar", data: [{ label: "A", value: 5 }], references },
    { kind: "histogram", data: [1, 2, 3, 4, 5], references: [{ ...references[0]!, axis: "x" }] },
    { kind: "boxplot", groups: [{ label: "A", values: [1, 2, 3, 4, 5] }], references },
  ];
  for (const spec of specs)
    expect(renderChartSvg(spec, 480, 280), spec.kind).toContain(
      'style="stroke-dasharray:1 3;stroke-linecap:round;color:var(--k2b-warning-text,#92400e)"',
    );
  const svg = renderBarChartSvg({
    width: 480,
    height: 640,
    data: Array.from({ length: 16 }, (_, index) => ({ label: `Long category ${index}`, value: 5 })),
    references,
  });
  expect(svg).toContain('data-bar-layout="rows"');
  expect(svg).toContain('style="stroke-dasharray:1 3;stroke-linecap:round;color:var(--k2b-warning-text,#92400e)"');
});

test("reference style attributes reject unknown runtime tokens", () => {
  for (const token of ["unexpected", "__proto__", 'red" onload="alert(1)']) {
    expect(() => referenceLineAttributes(JSON.parse(JSON.stringify({ value: 2, style: token })))).toThrow(RangeError);
    expect(() => referenceLineAttributes(JSON.parse(JSON.stringify({ value: 2, tone: token })))).toThrow(RangeError);
  }
});
