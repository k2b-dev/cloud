import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { registerSsrTestPlugin } from "../../test/ssr-test-plugin";
import { lineScaleTones } from "../charts/core/line-extras";

// A line with a colour scale through `<Chart>`, on the server: its legend (HTML, above the plot) shows the scale, and
// two charts on one page never share the id of a gradient (a hidden first chart would take the second's colour).

const root = mkdtempSync(resolve(tmpdir(), "k2-chart-line-extras-"));
registerSsrTestPlugin({ dev: true, rootDir: root });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: Chart } = await import("./Chart");

const hour = 3_600_000;
const start = Date.UTC(2026, 10, 27, 0);
const props = {
  kind: "line" as const,
  legend: true,
  timeAxis: { timeZone: "UTC" },
  series: [
    {
      label: "Temperatur",
      data: Array.from({ length: 24 }, (_, index) => ({ x: start + index * hour, y: -2 + index * 0.75 })),
      colorScale: [
        { value: 0, tone: "blue" as const },
        { value: 20, tone: "red" as const },
      ],
    },
    { label: "Gefühlt", data: Array.from({ length: 24 }, (_, index) => ({ x: start + index * hour, y: -4 + index * 0.7 })) },
  ],
};

test("the legend of a scaled line shows its scale, first stop to last; another line keeps its palette colour", () => {
  const html = renderToString(() => createComponent(Chart, props));
  const swatches = [...html.matchAll(/<span class="k2b-chart__legend-item">.*?<\/svg>/g)].map((item) => item[0]);
  expect(swatches.length).toBe(2);
  const [scaled, plain] = swatches;
  const id = scaled!.match(/<linearGradient id="([^"]+)"/)![1];
  expect(scaled).toContain(`fill:url(#${id})`);
  expect([...scaled!.matchAll(/stop-color="([^"]+)"/g)].map((stop) => stop[1])).toEqual([lineScaleTones.blue, lineScaleTones.red]);
  expect(plain).not.toContain("linearGradient");
  expect(plain).not.toContain("fill:url(");
});

test("two charts on one page define no id twice", () => {
  const html = renderToString(() => [createComponent(Chart, props), createComponent(Chart, props)]);
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((id) => id[1]);
  expect(ids.length).toBeGreaterThan(0);
  expect(ids.filter((id, index) => ids.indexOf(id) !== index)).toEqual([]);
  // each chart's line paints with its own gradient
  const paints = [...html.matchAll(/class="stdlib-chart-line[^"]*k2b-line-scaled"[^>]*stroke="url\(#([^)]+)\)"/g)].map((line) => line[1]);
  expect(new Set(paints).size).toBe(2);
});
