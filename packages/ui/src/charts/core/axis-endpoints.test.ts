import { expect, test } from "bun:test";
import { line } from "./svg";

test("default exact axes retain their original ticks and centered endpoint labels", () => {
  for (const axis of ["xAxis", "yAxis"] as const) {
    const svg = line({
      series: [
        {
          data: [
            { x: 0, y: 0 },
            { x: 10.1, y: 10.1 },
          ],
        },
      ],
      [axis]: { domain: [0, 10.1], format: (value: number) => `default:${value}` },
    });
    expect([...svg.matchAll(/>default:([^<]+)</g)].map((match) => Number(match[1]))).toEqual([0, 2, 4, 6, 8, 10, 10.1]);
    if (axis === "xAxis") {
      expect(svg).toContain('text-anchor="middle">default:0</text>');
      expect(svg).toContain('text-anchor="middle">default:10.1</text>');
    }
  }
});

test("opted-in exact linear domains keep their endpoints without crowding them with round ticks", () => {
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
        [axis]: { domain: bounds, insetEndpointLabels: true, format: (value: number) => `endpoint:${value}` },
      });
      const ticks = [...svg.matchAll(/>endpoint:([^<]+)</g)].map((match) => Number(match[1]));
      expect(ticks).toEqual(expected);
    }
  }
});

test("opted-in numeric X labels point inward and leave space for endpoint units", () => {
  const svg = line({
    series: [
      {
        data: [
          { x: 0, y: 1 },
          { x: 11.2, y: 2 },
        ],
      },
    ],
    xAxis: { domain: [0, 11.2], insetEndpointLabels: true, format: (value) => `${value} s` },
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

test("one-slot domains retain the whole slot between unlabeled half-slot endpoints", () => {
  const svg = line({
    series: [{ data: [{ x: 1, y: 5 }] }],
    xAxis: { domain: [0.5, 1.5], ticks: 1, format: (value) => (value === 1 ? "Sep 28" : "") },
  });
  expect(svg.match(/>Sep 28<\/text>/g)).toHaveLength(1);
});
