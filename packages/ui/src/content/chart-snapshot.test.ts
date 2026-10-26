import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import type { ChartRenderOptions } from "./Chart";

const root = mkdtempSync(resolve(tmpdir(), "cloud-chart-snapshot-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { prepareChartSnapshot } = await import("./chart-snapshot");

const series = [
  {
    label: "Latency",
    data: [
      { x: 1, y: 12 },
      { x: 2, y: 24 },
      { x: 8, y: 18 },
    ],
  },
];
const fixtures = {
  bar: {
    kind: "bar",
    title: "Jobs",
    data: [
      { label: "Imports", value: 42 },
      { label: "Exports", value: 28 },
    ],
  },
  line: { kind: "line", series },
  lineWithGap: { kind: "line", series, maxGap: 3 },
  stateTimeline: {
    kind: "stateTimeline",
    domain: [0, 10],
    rows: [
      {
        label: "Worker",
        intervals: [
          { from: 1, to: 4, state: "ok" },
          { from: 4, to: 9, state: "busy" },
        ],
      },
    ],
  },
  map: { kind: "map", series: [{ label: "Visits", data: [{ latitude: 52.52, longitude: 13.405, label: "Berlin" }] }] },
  heatmap: {
    kind: "heatmap",
    data: [
      { x: "Mon", y: "AM", value: 12 },
      { x: "Tue", y: "AM", value: 24 },
    ],
  },
  stat: { kind: "stat", label: "Requests", value: 42, delta: 3, sparkline: [12, 24, 18] },
  sparkline: { kind: "sparkline", data: [12, 24, 18], showLast: true, showMinMax: true },
} satisfies Record<string, ChartRenderOptions>;

// SHA-256 of JSON.stringify(prepareChartSnapshot(...)), captured from origin/main
// (6c7205814c51a932a1c0f5a1ac09318986699729), before changing Chart's default inspection. Fixed numeric inputs, no clock or random data.
const baseline: Record<string, string> = {
  // Bar charts draw with @k2b/ui's own renderer since every category keeps its label and printed value.
  bar: "7ea94046d06595a7c9e61c27a4f75298b71f3b6cfce6e11f67754c4039b423cb",
  line: "e189323e0c3c48cc5a49be8fb797a6e50b8b3ab51f490c33d4d6b10f995a7047",
  lineWithGap: "613b883fc561e8dd0e80f5a77e864d0665abaf40eb1f9833372f7b0b0a447ce3",
  stateTimeline: "0f488aed673002ebaf4584d8ed3bdd1d86dc150578786e9a0f90ecf6b9d3627d",
  map: "b96c033465c52175be2931f841db4651607c22dcaf5cf8b7a49e52cd15cab3d7",
  heatmap: "906ba7ad5595af0e22eb493bba013e616223615bc245c8dc37820943fb2801c8",
  stat: "65dc9c0738e3d14ca9ec4077743d01205c7118035ec26cb65c9b9e7f792b8b04",
  sparkline: "f0841c367e659af9447ce146c82be8eb7341ec5739b8e174c4b661ef18ca924e",
};

describe("prepareChartSnapshot byte compatibility", () => {
  for (const [name, options] of Object.entries(fixtures)) {
    test(name, () => {
      const snapshot = prepareChartSnapshot(options, {
        key: ({ datum }) => `${datum.role}:${datum.seriesIndex ?? 0}:${datum.index}`,
        tooltip: ({ datum }) => ({
          title: datum.label,
          rows: datum.values.map(({ key, value }) => ({ label: key, value: String(value) })),
        }),
      });
      const digest = createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
      const expected = baseline[name];
      if (!expected) throw new Error(`Missing origin/main snapshot baseline for ${name}`);
      expect(digest).toBe(expected);
    });
  }
});
