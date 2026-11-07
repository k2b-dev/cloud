import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import legacySvg from "../../test/charts/legacy-svg.json";
import { chartRenderHeight, charts, layout, prepareChartSnapshot, renderChartSvg, toSvg } from "./core";
import { chartParity, chartParityMarkdown } from "./parity";

const root = resolve(import.meta.dir, "../../../..");
// Immutable output captured before changing UI adapters. No production rendering module computes the oracle.
const legacy: { cases: Record<string, { ui: string; raw: string; height: number }>; drawings: Record<string, string> } = legacySvg;
/** Only renderer-generated IDs and their references vary between otherwise identical renders. */
const stableIds = (svg: string) => svg.replace(/stdlib-spark-grad-\d+/g, "stdlib-spark-grad-ID");

/** G3 intentionally adds portable paint, puts inspection points above fills, and gives legends values.
 * Compare every legacy axis, path and datum unchanged; new paint and legend behavior have focused guards.
 * Frozen SVG fixtures remain untouched. */
const legacyLineGeometry = (svg: string) => {
  const points: string[] = [];
  const geometry = svg
    .replace(/<g data-chart-role="point" data-chart-datum="[^"]*">[\s\S]*?<\/g>/g, (point) => {
      points.push(point.replace(/var\((--stdlib-chart-c\d), #[a-f\d]+\)/g, "var($1)"));
      return "";
    })
    .replace(/<g class="stdlib-chart-legend">[\s\S]*?<\/g><\/g>/g, "")
    .replace(/<g class="stdlib-chart-legend-item">[\s\S]*?<\/g>/g, "")
    .replace(/<path class="stdlib-chart-(?:line|area|error-band) [^"]*"[^>]*\/>/g, (path) =>
      path.replace(/ (?:fill|stroke|stroke-width|fill-opacity)="[^"]*"/g, "").replace(/ d="([^"]*)"/, (_, d: string) => ` d="${d.trim()}"`),
    );
  return geometry.replace(/<\/svg>$/, `${points.join("")}</svg>`);
};

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
    const stable = (svg: string) => stableIds(spec.kind === "line" ? legacyLineGeometry(svg) : svg);
    expect(stable(renderChartSvg(spec, 480, height)), row.id).toBe(stable(legacy.drawings[expected.ui]!));
    const raw = charts[spec.kind] as (spec: unknown) => string;
    // maxGap used to be UI-only; its new raw-core behavior is guarded in chart-line-gaps.test.ts.
    const rawSpec = row.id === "line-maxGap" && spec.kind === "line" ? { ...spec, maxGap: undefined } : spec;
    expect(stable(raw({ ...rawSpec, width: 480, height, inspect: true })), `${row.id}: raw renderer`).toBe(
      stable(legacy.drawings[expected.raw]!),
    );
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
