import { expect, test } from "bun:test";
import { calendarDay, calendarLayout, calendarWeekStart, renderCalendarSvg, renderHeatmapSvg } from "./calendar";
import { heatmap } from "./svg";

const spec = {
  layout: "calendar" as const,
  locale: "en-GB",
  scale: "diverging" as const,
  data: [
    ["2026-11-02", 100],
    ["2026-11-09", -25],
    ["2026-11-10", 0],
  ] as [string, number][],
};
test("calendar weeks/day geometry, all-data scale and area-free color intensity", () => {
  const s = calendarLayout(spec);
  expect(s.cells.map((c) => [c.week, c.weekday])).toEqual([
    [0, 0],
    [1, 0],
    [1, 1],
  ]);
  expect(s.absMax).toBe(100);
  expect(s.cells[1]!.intensity).toBe(0.25);
  expect(s.cells[0]!.x).toBeLessThan(s.cells[1]!.x);
  expect(s.cells[1]!.y).toBeLessThan(s.cells[2]!.y);
  expect(calendarDay("2024-02-29")).toBe(Date.UTC(2024, 1, 29));
  for (const day of ["2026-02-29", "2026-11-31", "2026-1-01"]) expect(() => calendarDay(day)).toThrow();
  expect(() => calendarLayout({ ...spec, data: [...spec.data, spec.data[0]!] })).toThrow();
});
test("calendar sorted metadata retains input indices, missing days stay absent, grid JSON unchanged", () => {
  const reverse = calendarLayout({ ...spec, data: [...spec.data].reverse() });
  expect(reverse.cells.map((c) => c.index)).toEqual([2, 1, 0]);
  const svg = renderCalendarSvg({ ...spec, inspect: true, locale: "de" });
  expect([...svg.matchAll(/data-chart-datum=/g)]).toHaveLength(3);
  expect(svg).toContain("&quot;grid&quot;:[1,1]");
  expect(svg).toContain("var(--k2b-flow-out-mark,#8b5cf6)");
  expect(svg).not.toMatch(/NaN|Infinity/);
  const old = { data: [{ x: "Mon", y: "Queue", value: 4 }] };
  expect(renderHeatmapSvg(old)).toBe(heatmap(old));
});

test("calendar core headers reserve space without changing observation geometry", () => {
  const s = calendarLayout({ ...spec, title: "Opens", subtitle: "Fictional" });
  expect(s.cells[0]!.y).toBe(s.top);
  expect(s.top).toBeGreaterThan(22);
  const svg = renderCalendarSvg({ ...spec, title: "Opens", subtitle: "Fictional" });
  expect(svg).toContain("stdlib-chart-title");
  expect(svg).toContain("Fictional");
});

test("calendar gaps, square cells, locale weeks, months and complete scale legend", () => {
  const s = calendarLayout({
    ...spec,
    data: [
      ["2026-01-01", null],
      ["2026-02-01", -5],
      ["2026-03-01", 0],
    ],
    scale: "sequential",
  });
  expect(s.cells).toHaveLength(2);
  expect(s.cellWidth).toBe(s.cell);
  expect(s.cells[1]!.intensity).toBeGreaterThan(s.cells[0]!.intensity);
  expect(calendarLayout({ ...spec, locale: "en-US" }).weekStart).toBe(0);
  expect(calendarLayout({ ...spec, locale: "de-DE" }).weekStart).toBe(1);
  const svg = renderCalendarSvg({
    ...spec,
    data: [
      ["2026-01-01", 1],
      ["2026-05-01", 2],
    ],
  });
  for (const month of ["2026", "Jan", "Feb", "Mar", "Apr", "May"]) expect(svg).toContain(month);
  expect(svg).toContain("more out");
  expect(svg).toContain("more in");
  expect(renderCalendarSvg({ ...spec, scale: "sequential" })).toContain("less");
  expect(() =>
    calendarLayout({
      ...spec,
      data: [
        ["2020-01-01", 1],
        ["2026-01-01", 2],
      ],
    }),
  ).toThrow("three years");
});

test("calendar squares fill the panel and reserve a visible weekday rail", () => {
  const s = calendarLayout(spec);
  expect(s.cell).toBeGreaterThan(14);
  expect((s.maxWidth / s.width) * s.cell).toBe(32);
  expect(s.top + 7 * (s.cell + 3) + 12).toBeGreaterThan(s.height - 16);
  expect(s.top + 7 * (s.cell + 3) + 12).toBeLessThanOrEqual(s.height);
  expect(renderCalendarSvg(spec)).toContain('data-calendar-weekdays="true"');
});

test("month labels retain the month after a partial first month without stretching", () => {
  const svg = renderCalendarSvg({
    ...spec,
    locale: "de-DE",
    data: [
      ["2026-05-29", 1],
      ["2026-07-31", 2],
    ],
  });
  for (const label of ["Mai", "Jun", "Jul", "2026"]) expect(svg).toContain(label);
  expect(svg).not.toMatch(/textLength|lengthAdjust/);
});

test("calendar short months distinguish French June and July", () => {
  const svg = renderCalendarSvg({
    ...spec,
    locale: "fr-FR",
    data: [
      ["2026-06-01", 1],
      ["2026-07-31", 2],
    ],
  });
  for (const month of [5, 6]) {
    const text = new Intl.DateTimeFormat("fr-FR", { month: "short", timeZone: "UTC" }).format(Date.UTC(2026, month, 1));
    expect(svg).toContain(`>${text}</text>`);
  }
  expect(svg).not.toContain(">jui</text>");
});

test("old engines use the explicit US Sunday and other-locale Monday fallback", () => {
  const saved = ["weekInfo", "getWeekInfo"].map((key) => [key, Object.getOwnPropertyDescriptor(Intl.Locale.prototype, key)] as const);
  try {
    for (const [key] of saved) Object.defineProperty(Intl.Locale.prototype, key, { value: undefined, configurable: true });
    expect(calendarWeekStart("en-US")).toBe(0);
    expect(calendarWeekStart("en")).toBe(0);
    expect(calendarWeekStart("en-GB")).toBe(1);
    expect(calendarWeekStart("fr-FR")).toBe(1);
    expect(calendarWeekStart("de-DE")).toBe(1);
  } finally {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(Intl.Locale.prototype, key, descriptor);
      else Reflect.deleteProperty(Intl.Locale.prototype, key);
    }
  }
});

test("calendar bounds and content height depend on weeks, not the old fixed host height", () => {
  const data = Array.from({ length: 182 }, (_, i): [string, number] => [
    new Date(Date.UTC(2026, 4, 11) + i * 86400000).toISOString().slice(0, 10),
    i,
  ]);
  const sizes = [100, 280, 600].map((height) => calendarLayout({ ...spec, data }, { width: 480, height }));
  for (const size of sizes) {
    expect(size.weeks).toBe(26);
    expect(size.minWidth).toBe(478);
    expect(size.height).toBe(169);
    expect(size.maxWidth).toBe((478 * 32) / 14);
    expect(size.cells.at(-1)!.y + size.cell).toBeLessThan(size.height);
  }
  expect(sizes[0]).toEqual(sizes[2]);
});

test("explicit core widths size square cells without a browser, bounded at 32px", () => {
  const data: [string, number][] = [
    ["2026-05-11", 1],
    ["2026-11-08", 2],
  ];
  const normal = calendarLayout({ ...spec, data }, { width: 480, height: 999 });
  const wider = calendarLayout({ ...spec, data }, { width: 900, height: 100 });
  const capped = calendarLayout({ ...spec, data }, { width: 1920, height: 100 });
  expect(normal.cell).toBe(14);
  expect(wider.cell).toBe(30);
  expect(wider.width).toBe(894);
  expect(capped.cell).toBe(32);
  expect(capped.height).toBe(capped.top + 7 * (32 + 3) + 18);
});

test("the final partial week does not invent a month or year beyond the observations", () => {
  const svg = renderCalendarSvg({
    ...spec,
    locale: "en-GB",
    data: [
      ["2025-01-01", 1],
      ["2025-12-31", 2],
    ],
  });
  expect(svg).toContain(">Dec</text>");
  expect(svg).not.toContain(">2026</text>");
  expect(svg.match(/>Jan<\/text>/g)).toHaveLength(1);
});

test("weekday text uses a grid anchor and a fixed pixel gap, independent of glyph bounds", () => {
  const svg = renderCalendarSvg(spec);
  expect(svg).toContain('<g transform="translate(32 ');
  expect(svg.match(/data-calendar-fixed=""><text x="-3" y="0" text-anchor="end"/g)).toHaveLength(3);
});
