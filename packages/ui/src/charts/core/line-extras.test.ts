import { expect, test } from "bun:test";
import { lineScaleTones } from "./line-extras";
import { renderChartSvg } from "./render";

// A day of weather as Weather draws it (W8): the temperature as a line whose colour follows its value, the chance of
// rain as bars in a track of their own under it (never a second Y axis over the line), and the night hours as quiet
// bands behind both. Drawn on the server, as `Chart.Line` draws it.

const hour = 3_600_000;
const start = Date.UTC(2026, 10, 27, 0);
const hours = Array.from({ length: 24 }, (_, index) => start + index * hour);
const temperature = hours.map((x, index) => ({ x, y: -2 + index * 0.75 }));
const rain = hours.map((x, index) => ({ x, y: index >= 18 ? 80 : index * 2 }));
const day = {
  kind: "line" as const,
  timeAxis: { timeZone: "UTC" },
  series: [
    {
      label: "Temperatur",
      data: temperature,
      colorScale: [
        { value: 0, tone: "blue" as const },
        { value: 10, tone: "amber" as const },
        { value: 20, tone: "red" as const },
      ],
    },
  ],
  bands: [
    { from: start, to: start + 7 * hour, label: "Nacht" },
    { from: start + 20 * hour, to: start + 26 * hour, label: "Nacht" },
  ],
  track: { label: "Regen", data: rain, format: (value: number) => `${value} %` },
  yAxis: { format: (value: number) => `${value}°` },
};
const svg = renderChartSvg(day, 480, 240);

const numbers = (tag: string, names: string[]) =>
  Object.fromEntries(names.map((name) => [name, Number(tag.match(new RegExp(`\\b${name}="([^"]+)"`))?.[1])]));

test("bands lie behind the data, from their X to their X, clipped to the plot, named by their label", () => {
  const bands = [...svg.matchAll(/<rect class="k2b-line-band"[^>]*>(?:<title>([^<]*)<\/title>)?/g)];
  expect(bands.map((band) => band[1])).toEqual(["Nacht", "Nacht"]);
  const [night, evening] = bands.map((band) => numbers(band[0], ["x", "y", "width", "height"]));
  // the first starts at the plot's start; the second runs past the last hour and stops at the plot's end
  const gridline = svg.match(/<line class="stdlib-chart-grid" x1="([^"]+)"[^>]*x2="([^"]+)"/)!;
  expect(night!.x).toBe(Number(gridline[1]));
  expect(evening!.x! + evening!.width!).toBeCloseTo(Number(gridline[2]), 1);
  // behind everything that is data: before the first bar and the first line in the drawing order
  expect(svg.indexOf('<rect class="k2b-line-band')).toBeLessThan(svg.indexOf('<rect class="k2b-line-bar'));
  expect(svg.indexOf('<rect class="k2b-line-bar')).toBeLessThan(svg.indexOf('<path class="stdlib-chart-line'));
});

test("a colour scale paints the line with a gradient over the plot, whose stops stand at the values' heights", () => {
  const line = svg.match(/<path class="stdlib-chart-line[^"]*k2b-line-scaled"[^>]*stroke="url\(#([^)]+)\)"/);
  expect(line).not.toBeNull();
  const gradient = svg.match(new RegExp(`<linearGradient id="${line![1]}"[^>]*>(.*?)</linearGradient>`))!;
  expect(gradient[0]).toContain('gradientUnits="userSpaceOnUse"');
  const stops = [...gradient[1]!.matchAll(/<stop offset="([^"]+)" stop-color="([^"]+)"/g)].map((stop) => [Number(stop[1]), stop[2]]);
  // 0°, 10° and 20° are evenly apart on a linear axis
  expect(stops).toEqual([
    [0, lineScaleTones.blue],
    [0.5, lineScaleTones.amber],
    [1, lineScaleTones.red],
  ]);
  // the same description draws the same id on the server and in the browser
  expect(renderChartSvg(day, 480, 240)).toBe(svg);
});

test("the track reads as a scale of its own: its label above it, its lowest and highest value at its start", () => {
  const track = svg.match(/<g class="k2b-line-track">(.*?)<\/g>/)![1]!;
  expect(track.match(/class="k2b-line-track-label"[^>]*>([^<]*)</)?.[1]).toBe("Regen");
  const ticks = [...track.matchAll(/class="stdlib-chart-tick-label k2b-line-track-tick"[^>]*>([^<]*)</g)].map((tick) => tick[1]);
  // from 0 to a round value at or above the rainiest hour (80 %)
  expect(ticks.length).toBe(2);
  expect(ticks[0]).toBe("0 %");
  expect(Number.parseFloat(ticks[1]!)).toBeGreaterThanOrEqual(80);
  // the line's own axis keeps the temperatures, and no second axis stands at the plot's end
  expect(svg).toContain(">10°<");
  const ends = [...svg.matchAll(/<text class="stdlib-chart-tick-label[^"]*" x="([^"]+)"[^>]*text-anchor="start"/g)].map((tick) =>
    Number(tick[1]),
  );
  const plotEnd = Number(svg.match(/<line class="stdlib-chart-grid"[^>]*x2="([^"]+)"/)![1]);
  expect(ends.filter((x) => x > plotEnd)).toEqual([]);
});

test("a bar stands under its hour: the track shares the line's X axis", () => {
  const bars = [...svg.matchAll(/<rect class="k2b-line-bar"[^>]*>/g)].map((bar) => numbers(bar[0], ["x", "width"]));
  // hour 0 has no rain: no bar; every other hour has one
  expect(bars.length).toBe(23);
  // the X of each hour, from the line's points as the inspection draws them
  const inspected = renderChartSvg({ ...day, inspect: true } as typeof day, 480, 240);
  const xs = [...inspected.matchAll(/class="stdlib-chart-inspection-point"[^>]*cx="([^"]+)"/g)].map((point) => Number(point[1]));
  expect(xs.length).toBe(24);
  // each bar is centred on its hour; at the plot's end the last is cut to the half inside it, and still holds its hour
  for (const [index, bar] of bars.slice(0, -1).entries()) expect(bar.x! + bar.width! / 2).toBeCloseTo(xs[index + 1]!, 1);
  const last = bars.at(-1)!;
  expect(last.x! + last.width!).toBeCloseTo(xs.at(-1)!, 1);
  expect(last.width).toBeCloseTo(bars[0]!.width! / 2, 1);
});

test("the track lies under the plot: no bar reaches the line's area, and the line stays above the track", () => {
  const bars = [...svg.matchAll(/<rect class="k2b-line-bar"[^>]*>/g)].map((bar) => numbers(bar[0], ["y", "height"]));
  const label = numbers(svg.match(/<text class="k2b-line-track-label"[^>]*>/)![0], ["y"]);
  // the plot ends at its lowest grid line; the track's label and its bars come after it
  const grid = [...svg.matchAll(/<line class="stdlib-chart-grid"[^>]*y1="([^"]+)"/g)].map((line) => Number(line[1]));
  const plotBottom = Math.max(...grid);
  expect(label.y! - 11).toBeGreaterThan(plotBottom);
  expect(Math.min(...bars.map((bar) => bar.y!))).toBeGreaterThan(label.y!);
  // the line's path never goes below the plot
  const path = svg.match(/<path class="stdlib-chart-line[^"]*" d="([^"]+)"/)![1]!;
  const ys = [...path.matchAll(/-?\d+(?:\.\d+)?[ ,](-?\d+(?:\.\d+)?)/g)].map((pair) => Number(pair[1]));
  expect(Math.max(...ys)).toBeLessThanOrEqual(plotBottom + 0.5);
  // the X axis's labels stand under the track
  const hoursLabel = Math.min(
    ...[...svg.matchAll(/class="stdlib-chart-tick-label k2b-line-time-tick" x="[^"]+" y="([^"]+)"/g)].map((tick) => Number(tick[1])),
  );
  expect(hoursLabel).toBeGreaterThan(Math.max(...bars.map((bar) => bar.y! + bar.height!)));
});

test("every tone of a colour scale stands at least 3:1 apart from a light and a dark surface", () => {
  const luminance = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((at) => {
      const channel = Number.parseInt(hex.slice(at, at + 2), 16) / 255;
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  };
  const contrast = (a: string, b: string) => {
    const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (high! + 0.05) / (low! + 0.05);
  };
  for (const [tone, colour] of Object.entries(lineScaleTones)) {
    expect([tone, contrast(colour, "#ffffff") >= 3]).toEqual([tone, true]);
    expect([tone, contrast(colour, "#18181b") >= 3]).toEqual([tone, true]);
  }
});

test("a colour scale needs rising stops of known tones; a band needs from below to; a track needs a label", () => {
  const draw = (change: object) => () => renderChartSvg({ ...day, ...change }, 480, 240);
  expect(
    draw({
      series: [
        {
          data: temperature,
          colorScale: [
            { value: 10, tone: "red" },
            { value: 0, tone: "blue" },
          ],
        },
      ],
    }),
  ).toThrow(RangeError);
  expect(draw({ series: [{ data: temperature, colorScale: [{ value: 0, tone: "blue" }] }] })).toThrow(RangeError);
  expect(draw({ bands: [{ from: start + hour, to: start }] })).toThrow(RangeError);
  expect(draw({ track: { label: " ", data: rain } })).toThrow(RangeError);
  // a tone is one of the scale's own, never a name every object has
  for (const tone of ["toString", "constructor", "__proto__"])
    expect(
      draw({
        series: [
          {
            data: temperature,
            colorScale: [
              { value: 0, tone },
              { value: 10, tone: "red" },
            ],
          },
        ],
      }),
    ).toThrow(RangeError);
  // on a log axis a stop at or below 0 has no place, as a threshold or a marker there
  expect(
    draw({
      yAxis: { scale: "log" },
      series: [
        {
          data: temperature.map((p) => ({ ...p, y: p.y + 10 })),
          colorScale: [
            { value: 0, tone: "blue" },
            { value: 20, tone: "red" },
          ],
        },
      ],
    }),
  ).toThrow(RangeError);
});

test("a dry day keeps the track's scale at 0 to 1, never around 0", () => {
  const dry = renderChartSvg(
    { ...day, track: { label: "Regen", data: rain.map((p) => ({ ...p, y: 0 })), format: (v: number) => `${v} %` } },
    480,
    240,
  );
  const ticks = [...dry.matchAll(/class="stdlib-chart-tick-label k2b-line-track-tick"[^>]*>([^<]*)</g)].map((tick) => tick[1]);
  expect(ticks).toEqual(["0 %", "1 %"]);
  expect(dry).not.toContain('<rect class="k2b-line-bar"');
});

test("a track never squeezes the line: a chart too low for both draws the line alone and says the track is omitted", () => {
  // a small widget or a narrow pane: no error, the line over the whole plot, no track
  const low = renderChartSvg(day, 480, 120);
  expect(low).toContain('data-track="omitted"');
  expect(low).not.toContain('class="k2b-line-track"');
  expect(low).toContain('<path class="stdlib-chart-line');
  // tall enough: the track is there, and nothing says it is omitted
  const tall = renderChartSvg(day, 480, 240);
  expect(tall).toContain('class="k2b-line-track"');
  expect(tall).not.toContain("data-track=");
});

test("a line chart without the extras draws as before", () => {
  const plain = { kind: "line" as const, series: [{ label: "Temperatur", data: temperature }] };
  const before = renderChartSvg(plain, 480, 240);
  expect(before).not.toContain("k2b-line-band");
  expect(before).not.toContain("linearGradient");
  expect(before).not.toContain("k2b-line-bar");
});
