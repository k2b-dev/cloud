import { expect, test } from "bun:test";
import { line } from "./svg";

test("exact linear domains keep their endpoints without crowding them with round ticks", () => {
  for (const [bounds, expected] of [
    [
      [0, 10.1],
      [0, 2, 4, 6, 8, 10.1],
    ],
    [
      [1.9, 10.1],
      [1.9, 4, 6, 8, 10.1],
    ],
    [
      [-10.1, -1.9],
      [-10.1, -8, -6, -4, -1.9],
    ],
    [
      [0, 10],
      [0, 2, 4, 6, 8, 10],
    ],
  ] satisfies [[number, number], number[]][]) {
    for (const axis of ["xAxis", "yAxis"] as const) {
      const svg = line({
        series: [
          {
            data: [
              { x: bounds[0], y: bounds[0] },
              { x: bounds[1], y: bounds[1] },
            ],
          },
        ],
        [axis]: { domain: bounds, format: (value: number) => `endpoint:${value}` },
      });
      const ticks = [...svg.matchAll(/>endpoint:([^<]+)</g)].map((match) => Number(match[1]));
      expect(ticks).toEqual(expected);
    }
  }
});

test("explicit numeric X bounds point labels inward and leave room for endpoint units", () => {
  const svg = line({
    series: [
      {
        data: [
          { x: 0, y: 1 },
          { x: 11.2, y: 2 },
        ],
      },
    ],
    xAxis: { domain: [0, 11.2], format: (value) => `${value} s` },
  });
  const ticks = [...svg.matchAll(/<text class="stdlib-chart-tick-label"[^>]*text-anchor="([^"]+)"[^>]*>([^<]+ s)<\/text>/g)].map(
    (match) => ({ anchor: match[1], text: match[2] }),
  );
  expect(ticks).toEqual([
    { anchor: "start", text: "0 s" },
    { anchor: "middle", text: "2 s" },
    { anchor: "middle", text: "4 s" },
    { anchor: "middle", text: "6 s" },
    { anchor: "middle", text: "8 s" },
    { anchor: "end", text: "11.2 s" },
  ]);
});
