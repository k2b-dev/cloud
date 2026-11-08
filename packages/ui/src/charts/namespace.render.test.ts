import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent, type JSX } from "solid-js";
import { renderToString } from "solid-js/web";
import { chartFixtures } from "../../test/charts/fixtures";
import type { ChartKindProps } from "../content/Chart";
// Load this leaf before the SVG namespace: a map re-export must work in either import order.
import { map } from "./core/map";
import { chartKinds } from "./core/registry";
import { charts } from "./core/svg";

const root = mkdtempSync(resolve(tmpdir(), "cloud-chart-namespace-"));
Bun.plugin(createConfig({ dev: true, rootDir: root }).plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: Chart } = await import("../content/Chart");
const { default: OldChart } = await import("../content/Chart");

describe("Chart namespace", () => {
  for (const [name, kind] of Object.entries(chartKinds)) {
    test(`${name} renders exactly the same markup as kind=${kind}`, () => {
      const spec = chartFixtures[kind];
      const { kind: _kind, ...props } = spec;
      const direct = renderToString(() => createComponent(Chart, spec));
      const named = renderToString(() =>
        createComponent(Chart[name as keyof typeof chartKinds] as (input: typeof props) => JSX.Element, props),
      );
      expect(named).toBe(direct);
      expect(OldChart).toBe(Chart);
    });
  }
});

/** Typechecked without invoking hooks outside a Solid owner. */
function namespaceTypes() {
  Chart.Funnel({ data: [{ label: "Visit", value: 42 }] });
  Chart.Hbar({ series: ["Visits"], rows: [{ label: "Mail", values: [42] }] });
  Chart.Pie({ data: [{ label: "Queue", value: 4 }] });
  Chart.Line({ series: [{ data: [{ x: 1, y: 2 }] }] });
  // @ts-expect-error Pie takes slices, not Cartesian series.
  Chart.Pie({ series: [] });
  // @ts-expect-error Named components fix their kind.
  Chart.Bar({ kind: "pie", data: [] });
  const props: ChartKindProps<"gauge"> = { value: 42 };
  Chart.Gauge(props);
}
test("namespace props stay narrowed", () => expect(typeof namespaceTypes).toBe("function"));

test("Calendar is the named calendar heatmap component", () => {
  const props = { scale: "sequential" as const, data: [["2026-11-02", 5]] as [string, number][] };
  expect(renderToString(() => createComponent(Chart.Calendar, props))).toBe(
    renderToString(() => createComponent(Chart, { kind: "heatmap", layout: "calendar", ...props })),
  );
});

test("the map leaf and existing SVG namespace share the same renderer", () => {
  expect(charts.map).toBe(map);
});
