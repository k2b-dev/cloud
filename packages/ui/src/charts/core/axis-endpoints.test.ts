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
