import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { charts as legacyCharts } from "@k2b/stdlib";
import { renderLegacyChartSvg } from "../../test/charts/legacy-render";
import { chartKinds, chartRenderHeight, charts, layout, prepareChartSnapshot, renderChartSvg, toSvg } from "./core";
import { chartParity, chartParityMarkdown } from "./parity";

const root = resolve(import.meta.dir, "../../../..");
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
  for (const kind of Object.values(chartKinds)) expect(ids.has(`kind-${kind}`)).toBe(true);
});

test("every parity spec preserves legacy SVG output", () => {
  for (const row of chartParity) {
    const height = chartRenderHeight(row.spec);
    const oldSvg = renderLegacyChartSvg(row.spec, 480, height);
    const newSvg = renderChartSvg(row.spec, 480, height);
    expect(stableIds(newSvg), row.id).toBe(stableIds(oldSvg));
    // Also compare the unadapted renderer: custom bars/timelines otherwise share numeric helpers with UI.
    const rawOld = legacyCharts[row.spec.kind] as (spec: unknown) => string;
    const rawNew = charts[row.spec.kind] as (spec: unknown) => string;
    expect(stableIds(rawNew({ ...row.spec, width: 480, height, inspect: true })), `${row.id}: raw renderer`).toBe(
      stableIds(rawOld({ ...row.spec, width: 480, height, inspect: true })),
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

test("documents the per-reference styling gap without claiming parity", () => {
  const gaps = chartParity.filter((row) => row.gap);
  expect(gaps.map((row) => row.id)).toEqual(["line-reference-style"]);
  expect(gaps[0]!.gap).toContain("No existing stdlib/UI ReferenceLine style option");
});

test("published parity table is generated from the registry", () => {
  const doc = readFileSync(resolve(root, "docs-site/src/ui/context/content/charts.md"), "utf8");
  expect(doc).toContain(chartParityMarkdown());
});
