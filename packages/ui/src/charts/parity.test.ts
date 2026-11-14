import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import multiSeriesSvg from "../../test/charts/legacy-line-multi-series.json";
import legacySvg from "../../test/charts/legacy-svg.json";
import { lineCompatibilitySpecs } from "../../test/charts/line-compatibility-specs";
import { chartRenderHeight, charts, layout, lineBase, prepareChartSnapshot, renderChartSvg, toSvg } from "./core";
import { chartParity, chartParityMarkdown } from "./parity";

const root = resolve(import.meta.dir, "../../../..");
// Immutable output captured before changing UI adapters. No production rendering module computes the oracle.
const legacy: { cases: Record<string, { ui: string; raw: string; height: number }>; drawings: Record<string, string> } = legacySvg;
/** Only renderer-generated IDs and their references vary between otherwise identical renders. */
const stableIds = (svg: string) => svg.replace(/stdlib-spark-grad-\d+/g, "stdlib-spark-grad-ID");

test("every parity row names an existing test or live demo", () => {
  const ids = new Set<string>();
  for (const row of chartParity) {
    expect(ids.has(row.id)).toBe(false);
    ids.add(row.id);
    const proof = readFileSync(resolve(root, row.proof.file), "utf8");
    expect(proof.includes(row.proof.test), `${row.id}: missing named proof ${row.proof.file}: ${row.proof.test}`).toBe(true);
    if (row.proof.kind !== "demo") expect(row.proof.file).toMatch(/\.test\.tsx?$/);
  }
  for (const kind of Object.keys(charts)) expect(ids.has(`kind-${kind}`)).toBe(true);
});

test("every parity spec preserves legacy SVG output", () => {
  for (const row of chartParity) {
    const spec = row.legacySpec ?? row.spec;
    const expected = legacy.cases[row.legacyId ?? row.id];
    if (!expected) throw new Error(`Missing frozen pre-port SVG: ${row.id}`);
    const height = chartRenderHeight(spec);
    expect(height, row.id).toBe(expected.height);
    expect(stableIds(renderChartSvg(spec, 480, height)), row.id).toBe(legacy.drawings[expected.ui]!);
    const raw = charts[spec.kind] as (spec: unknown) => string;
    expect(stableIds(raw({ ...spec, width: 480, height, inspect: true })), `${row.id}: raw renderer`).toBe(legacy.drawings[expected.raw]!);
  }
});

test("snapshots and scenes use the same pure SVG renderer", () => {
  for (const row of chartParity) {
    const size = { width: 480, height: chartRenderHeight(row.spec) };
    expect(stableIds(toSvg(layout(row.spec, size)))).toBe(stableIds(renderChartSvg(row.spec, size.width, size.height)));
    const snapshot = prepareChartSnapshot(row.spec, {
      key: ({ datum }) => `${datum.role}:${datum.seriesIndex ?? 0}:${datum.index}`,
      tooltip: ({ datum }) => ({ rows: datum.values.map((value) => ({ label: value.key, value: String(value.value) })) }),
    });
    expect(snapshot.width).toBe(480);
    expect(snapshot.height).toBe(size.height);
  }
});

test("the parity catalog has no open rows", () => {
  expect(chartParity.filter((row) => row.gap)).toEqual([]);
});

test("published parity table is generated from the registry", () => {
  const doc = readFileSync(resolve(root, "docs-site/docs/en/contributing/chart-renderer-parity.md"), "utf8");
  expect(doc).toContain(chartParityMarkdown());
});

// Additional, immutable oracle captured from origin/main at 73c8c2b83e; original fixtures remain untouched.
test("legacy three- and five-series legends and drawings stay byte-identical to main", () => {
  for (const [index, spec] of lineCompatibilitySpecs.entries()) {
    const expected = multiSeriesSvg[index]!;
    expect(charts.line(spec)).toBe(expected.raw);
    expect(lineBase(spec)).toBe(expected.raw);
    expect(renderChartSvg({ kind: "line", ...spec }, 480, 280)).toBe(expected.ui);
    expect(charts.line(spec)).not.toContain("data-chart-legend-value");
  }
});
