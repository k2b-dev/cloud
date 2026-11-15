import { expect, test } from "bun:test";
import { prepareChartSnapshot, renderChartSvg } from "../charts/core";
import { stretchedTickRoomsSvg, tickRooms } from "./chart-tick-room";

test("every second date gives way first, then every fourth; the first always stays", () => {
  // Eight dates 60 px apart on a 480 px drawing, each label about 7 characters.
  const rooms = tickRooms(
    Array.from({ length: 8 }, (_, index) => 40 + index * 60),
    Array.from({ length: 8 }, () => "21. Juni"),
    480,
  );
  expect(rooms[0]).toBe(0);
  // Odd places need the most room, places 2 and 6 half of it, place 4 a quarter.
  expect(rooms[1]).toBe(rooms[3]);
  expect(rooms[2]).toBe(rooms[6]);
  expect(rooms[2]!).toBeLessThan(rooms[1]!);
  expect(rooms[4]!).toBeLessThan(rooms[2]!);
  // At the drawing width these labels fit with room to spare, so none gives way there.
  expect(Math.max(...rooms)).toBeLessThanOrEqual(480);
});

test("one label, no width or no spacing needs no room", () => {
  expect(tickRooms([10], ["Mai"], 480)).toEqual([0]);
  expect(tickRooms([10, 20], ["a", "b"], 0)).toEqual([0, 0]);
  expect(tickRooms([10, 10], ["a", "b"], 480)).toEqual([0, 0]);
});

test("only the bottom row of tick labels carries the room marks; the drawing stays otherwise", () => {
  const svg =
    '<svg viewBox="0 0 480 260"><text class="stdlib-chart-tick-label" x="30" y="40" text-anchor="end">20</text>' +
    '<text class="stdlib-chart-tick-label" x="30" y="120" text-anchor="end">10</text>' +
    '<text class="stdlib-chart-tick-label" x="60" y="250" text-anchor="middle">1. Juni</text>' +
    '<text class="stdlib-chart-tick-label" x="120" y="250" text-anchor="middle">8. Juni</text>' +
    '<text class="stdlib-chart-tick-label" x="180" y="250" text-anchor="middle">15. Juni</text></svg>';
  const marked = stretchedTickRoomsSvg(svg);
  expect(marked.match(/data-time-tick/g)).toHaveLength(3);
  expect(marked).toContain('y="40" text-anchor="end">20<');
  expect(marked).toContain('<text data-time-tick class="stdlib-chart-tick-label" x="60"');
  expect(marked).toMatch(/x="120" y="250" text-anchor="middle" style="--k2b-tick-room:\d+px">8\. Juni</);
  expect(marked.replace(/ data-time-tick| style="[^"]*"/g, "")).toBe(svg);
  // A responsive drawing's own label style keeps one attribute; the room joins it.
  const styled = stretchedTickRoomsSvg(svg.replaceAll('text-anchor="middle"', 'text-anchor="middle" style="transform-origin:0 0"'));
  expect(styled).toMatch(/style="transform-origin:0 0;--k2b-tick-room:\d+px">8\. Juni</);
  expect(styled).not.toMatch(/style="[^"]*" style=/);
  expect(stretchedTickRoomsSvg("<svg></svg>")).toBe("<svg></svg>");
});

test("a snapshot of a time line marks its dates; the renderer's own drawing and other lines stay as they were", () => {
  const series = [
    { label: "Saldo", data: Array.from({ length: 28 }, (_, week) => ({ x: Date.UTC(2026, 4, 25) + week * 604_800_000, y: week % 5 })) },
  ];
  const tooltip = () => ({ rows: [] });
  const key = ({ datum }: { datum: { role: string; seriesIndex?: number; index: number } }) =>
    `${datum.role}:${datum.seriesIndex ?? 0}:${datum.index}`;
  const timed = prepareChartSnapshot({ kind: "line", timeAxis: { timeZone: "UTC", locale: "de" }, series }, { key, tooltip });
  expect(timed.svg).toContain("data-time-tick");
  expect(renderChartSvg({ kind: "line", timeAxis: { timeZone: "UTC", locale: "de" }, series }, 480, 260)).not.toContain("data-time-tick");
  const plain = prepareChartSnapshot(
    {
      kind: "line",
      series: [
        {
          label: "A",
          data: [
            { x: 1, y: 2 },
            { x: 2, y: 3 },
            { x: 3, y: 1 },
          ],
        },
      ],
    },
    { key, tooltip },
  );
  expect(plain.svg).not.toContain("data-time-tick");
});
