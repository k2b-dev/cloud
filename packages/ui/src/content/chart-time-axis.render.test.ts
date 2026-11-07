import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { chartTimeStep, chartTimeTicks } from "./chart-time-axis";

// Chart.tsx is Solid; the SSR plugin compiles it like the other chart render tests.
const root = mkdtempSync(resolve(tmpdir(), "cloud-chart-time-axis-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { renderChartSvg } = await import("./Chart");

const berlin = "Europe/Berlin";
const local = (ticks: number[], timeZone = berlin) =>
  ticks.map((tick) =>
    new Intl.DateTimeFormat("en-CA", { timeZone, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .format(tick)
      .replace(",", ""),
  );

test("the step follows the span: minutes, hours, days, weeks and months", () => {
  const hour = 3_600_000,
    day = 24 * hour;
  expect(chartTimeStep(2 * hour, 5)).toEqual({ unit: "minute", size: 30 });
  expect(chartTimeStep(day, 5)).toEqual({ unit: "hour", size: 6 });
  expect(chartTimeStep(7 * day, 5)).toEqual({ unit: "day", size: 2 });
  expect(chartTimeStep(30 * day, 5)).toEqual({ unit: "week", size: 1 });
  expect(chartTimeStep(90 * day, 5)).toEqual({ unit: "month", size: 1 });
});

test("ticks land on round wall times in the zone, not on decimal millisecond steps", () => {
  const domain = [Date.parse("2026-10-19T14:32:00Z"), Date.parse("2026-10-20T14:32:00Z")] as const;
  expect(local(chartTimeTicks(domain, berlin, { unit: "hour", size: 6 }))).toEqual([
    "10-19 18:00",
    "10-20 00:00",
    "10-20 06:00",
    "10-20 12:00",
  ]);
  expect(local(chartTimeTicks(domain, "America/New_York", { unit: "hour", size: 6 }), "America/New_York")).toEqual([
    "10-19 12:00",
    "10-19 18:00",
    "10-20 00:00",
    "10-20 06:00",
  ]);
  const quarter = [Date.parse("2026-10-20T10:07:00Z"), Date.parse("2026-10-20T11:07:00Z")] as const;
  expect(local(chartTimeTicks(quarter, berlin, { unit: "minute", size: 15 }))).toEqual([
    "10-20 12:15",
    "10-20 12:30",
    "10-20 12:45",
    "10-20 13:00",
  ]);
});

test("day and week ticks stay on local midnight across the end of daylight saving time", () => {
  const domain = [Date.parse("2026-10-22T10:00:00Z"), Date.parse("2026-11-04T10:00:00Z")] as const;
  const days = chartTimeTicks(domain, berlin, { unit: "day", size: 1 });
  expect(local(days).every((tick) => tick.endsWith("00:00"))).toBe(true);
  expect(days.map((tick) => new Date(tick).toISOString().slice(11, 16))).toContain("23:00");
  expect(days.map((tick) => new Date(tick).toISOString().slice(11, 16))).toContain("22:00");
  expect(local(chartTimeTicks(domain, berlin, { unit: "week", size: 1 }))).toEqual(["10-26 00:00", "11-02 00:00"]);
});

test("a line chart with a time axis draws round time labels instead of the renderer's decimal ticks", () => {
  const t0 = Date.parse("2026-10-19T14:32:00Z");
  const series = [{ label: "a", data: [0, 6, 12, 18, 24].map((h, i) => ({ x: t0 + h * 3_600_000, y: i })) }];
  const plain = renderChartSvg({ kind: "line", series, xAxis: { domain: [t0, t0 + 86_400_000], ticks: 3 } }, 480, 280);
  const timed = renderChartSvg(
    { kind: "line", series, xAxis: { domain: [t0, t0 + 86_400_000], ticks: 3 }, timeAxis: { timeZone: berlin, locale: "de" } },
    480,
    280,
  );
  const xLabels = (svg: string) => [...svg.matchAll(/text-anchor="middle"[^>]*>([^<]*)</g)].map((match) => match[1]);
  expect(xLabels(plain).length).toBeGreaterThan(0);
  expect(xLabels(timed)).toEqual(["18:00", "20. Okt.", "06:00", "12:00"]);
  // Every label sits at its instant's position on the 40–464 plot.
  const first = Number(/x="(-?[\d.]+)"[^>]*text-anchor="middle"[^>]*>18:00/.exec(timed)![1]);
  expect(Math.abs(first - (40 + ((Date.parse("2026-10-19T16:00:00Z") - t0) / 86_400_000) * 424))).toBeLessThan(0.01);
});
