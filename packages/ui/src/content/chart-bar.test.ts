import { describe, expect, test } from "bun:test";
import { type BarChartOptions, barChartLayout, chartTextWidth, renderBarChartSvg } from "./chart-bar";

const draw = (options: BarChartOptions) => {
  const { layout, height } = barChartLayout(options);
  return { layout, height, svg: renderBarChartSvg({ ...options, width: 480, height, inspect: true }) };
};
const texts = (svg: string, name: string) =>
  [...svg.matchAll(new RegExp(`class="[^"]*${name}[^"]*"[^>]*>(?:<title>[^<]*</title>)?([^<]*)<`, "g"))].map((match) => match[1]);
const euro = new Intl.NumberFormat("de", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });

const fruits = ["Äpfel", "Birnen", "Kirschen", "Pflaumen", "Aprikosen", "Pfirsiche", "Erdbeeren", "Himbeeren", "Brombeeren"];

describe("bar chart labels", () => {
  test("few short labels stand below columns, each with its value", () => {
    const { layout, height, svg } = draw({
      data: [
        { label: "Bio", value: 42 },
        { label: "Demeter", value: 17 },
        { label: "Sonst", value: 9 },
      ],
    });
    expect(layout).toBe("columns");
    expect(height).toBe(280);
    expect(svg).toContain('data-bar-layout="columns"');
    expect(texts(svg, "stdlib-chart-category-label")).toEqual(["Bio", "Demeter", "Sonst"]);
    expect(texts(svg, "stdlib-chart-bar-value")).toEqual(["42", "17", "9"]);
  });

  test("labels that do not fit below columns become rows: every category keeps its label and value", () => {
    const data = [...fruits, ...fruits.map((label) => `${label} spät`)].map((label, index) => ({ label, value: (index + 1) * 1000 }));
    const { layout, height, svg } = draw({ data, valueFormat: (value) => euro.format(value) });
    expect(layout).toBe("rows");
    expect(texts(svg, "stdlib-chart-category-label")).toEqual(data.map((item) => item.label));
    expect(texts(svg, "stdlib-chart-bar-value")).toEqual(data.map((item) => euro.format(item.value)));
    // 18 rows of at least 22 units do not fit the usual 280: the drawing grows instead of dropping labels.
    expect(height).toBeGreaterThan(280);
    expect(svg).toContain(`viewBox="0 0 480 ${height}"`);
  });

  test("a 30-category chart labels all 30 and every bar stays inspectable", () => {
    const data = Array.from({ length: 30 }, (_, index) => ({ label: `Parzelle ${index + 1}`, value: index + 1 }));
    const { svg } = draw({ data });
    expect(texts(svg, "stdlib-chart-category-label")).toHaveLength(30);
    expect(svg.match(/data-chart-datum=/g)).toHaveLength(30);
  });

  test("ordered categories stay columns and label every n-th day, as a time axis does", () => {
    const data = Array.from({ length: 30 }, (_, index) => ({ label: `${index + 1}. Okt.`, value: (index * 7) % 11 }));
    expect(draw({ data }).layout).toBe("rows");
    const { layout, height, svg } = draw({ data, xAxis: { ordered: true } });
    expect(layout).toBe("columns");
    expect(height).toBe(280);
    const labels = texts(svg, "stdlib-chart-category-label");
    expect(labels[0]).toBe("1. Okt.");
    expect(labels.length).toBeGreaterThan(2);
    expect(labels.length).toBeLessThan(30);
    // Evenly spaced: the shown labels are every n-th day.
    const step = data.findIndex((item) => item.label === labels[1]);
    expect(labels).toEqual(data.filter((_, index) => index % step === 0).map((item) => item.label));
    // Neighboring labels never overlap on the narrowest chart, and every day stays inspectable.
    const xs = [...svg.matchAll(/stdlib-chart-category-label" x="([\d.]+)"/g)].map((match) => Number(match[1]));
    expect(chartTextWidth("30. Okt.") + 6).toBeLessThanOrEqual((xs[1]! - xs[0]!) / (480 / 296));
    expect(svg.match(/data-chart-datum=/g)).toHaveLength(30);
    // A label wider than the room left of its column starts the sequence at the next column that keeps it whole.
    const stamps = Array.from({ length: 30 }, (_, index) => ({ label: `2026-10-${String(index + 1).padStart(2, "0")} 12:00`, value: 1 }));
    const drawn = draw({ data: stamps, xAxis: { ordered: true } }).svg;
    const positions = [...drawn.matchAll(/stdlib-chart-category-label" x="([\d.]+)"/g)].map((match) => Number(match[1]));
    const half = (chartTextWidth("2026-10-01 12:00") / 2) * (480 / 296);
    expect(positions.length).toBeGreaterThan(1);
    for (const x of positions) {
      expect(x - half).toBeGreaterThanOrEqual(0);
      expect(x + half).toBeLessThanOrEqual(480);
    }
    // A few ordered columns that fit keep every label.
    expect(texts(draw({ data: data.slice(0, 3), xAxis: { ordered: true } }).svg, "stdlib-chart-category-label")).toHaveLength(3);
  });

  test("long labels wrap to two lines and keep their full text when shortened", () => {
    const long = "Genossenschaft der Obstbauern im nordwestlichen Küstenvorland";
    const { svg } = draw({
      data: [
        { label: "Nordwestliche Küstenregion", value: 184 },
        { label: long, value: 12 },
      ],
    });
    const lines = texts(svg, "stdlib-chart-category-label");
    expect(lines.slice(0, 2).join(" ")).toBe("Nordwestliche Küstenregion");
    expect(lines.at(-1)?.endsWith("…")).toBe(true);
    expect(svg).toContain(`<title>${long}</title>`);
    // Each line fits the label column of a phone-wide chart.
    for (const line of lines) expect(chartTextWidth(line ?? "")).toBeLessThanOrEqual(296 * 0.4);
  });

  test("negative values grow left of the zero line with their value at the bar's end", () => {
    const { svg } = draw({
      data: [
        { label: "Januar", value: -4200 },
        { label: "Februar", value: 800 },
        { label: "März", value: 5400 },
        { label: "April", value: 9800 },
        { label: "Mai", value: -1200 },
        { label: "Juni", value: 14200 },
        { label: "Juli", value: 16900 },
      ],
      valueFormat: (value) => euro.format(value),
    });
    expect(svg).toContain('data-bar-layout="rows"');
    expect(svg).toMatch(new RegExp(`text-anchor="end">${euro.format(-4200)}<`));
    expect(svg).toMatch(new RegExp(`text-anchor="start">${euro.format(800)}<`));
  });

  test("axis titles name the categories and the value", () => {
    const { svg } = draw({
      data: fruits.map((label, value) => ({ label, value })),
      xAxis: { label: "Sorte" },
      yAxis: { label: "Umsatz (€)" },
    });
    expect(texts(svg, "stdlib-chart-axis-label")).toEqual(["Sorte", "Umsatz (€)"]);
    const columns = draw({ data: [{ label: "A", value: 1 }], xAxis: { label: "Sorte" }, yAxis: { label: "Kisten" } }).svg;
    expect(texts(columns, "stdlib-chart-axis-label").sort()).toEqual(["Kisten", "Sorte"]);
  });

  test("showValues false keeps a value axis instead", () => {
    const { svg } = draw({ data: fruits.map((label, value) => ({ label, value: value * 10 })), showValues: false });
    expect(texts(svg, "stdlib-chart-bar-value")).toEqual([]);
    expect(svg.match(/class="stdlib-chart-tick-label"/g)?.length).toBeGreaterThan(1);
  });

  test("a single bar and an empty chart", () => {
    expect(draw({ data: [{ label: "Äpfel", value: 128 }] }).layout).toBe("columns");
    const empty = draw({ data: [{ label: "Äpfel", value: Number.NaN }] });
    expect(empty.height).toBe(280);
    expect(empty.svg).toContain("stdlib-chart-empty-text");
  });

  test("values too wide for the rows give way to a value axis instead of reversing the bars", () => {
    const usd = new Intl.NumberFormat("en", { style: "currency", currency: "USD" });
    const { svg } = draw({
      data: [
        { label: "Northwestern coastal region", value: 1_234_567_890.12 },
        { label: "Eastern uplands", value: -1_234_567_890.12 },
      ],
      valueFormat: (value) => `${usd.format(value)} gross`,
    });
    expect(texts(svg, "stdlib-chart-bar-value")).toEqual([]);
    expect(svg.match(/class="stdlib-chart-tick-label"/g)?.length).toBeGreaterThan(1);
    const bars = [...svg.matchAll(/class="stdlib-chart-bar[^"]*" x="([\d.]+)" y="[\d.]+" width="([\d.]+)"/g)].map((match) => ({
      x: Number(match[1]),
      width: Number(match[2]),
    }));
    const zero = Number(/class="stdlib-chart-axis" x1="([\d.]+)"/.exec(svg)?.[1]);
    expect(bars[0]?.x).toBeCloseTo(zero, 1);
    expect((bars[1]?.x ?? 0) + (bars[1]?.width ?? 0)).toBeCloseTo(zero, 1);
    expect(bars.every((bar) => bar.width > 40)).toBe(true);
  });

  test("printed negative column values stay above the category labels", () => {
    const { layout, svg } = draw({
      data: [
        { label: "A", value: -10 },
        { label: "B", value: -5 },
      ],
    });
    expect(layout).toBe("columns");
    const baseline = (name: string) =>
      [...svg.matchAll(new RegExp(`class="[^"]*${name}[^"]*" x="[\\d.]+" y="([\\d.]+)"(?: dy="([\\d.]+)")?`, "g"))].map(
        (match) => Number(match[1]) + Number(match[2] ?? 0),
      );
    const values = baseline("stdlib-chart-bar-value");
    expect(values).toHaveLength(2);
    // 11px text: a value's baseline sits a full line above the top of the category labels.
    for (const value of values) expect(value).toBeLessThanOrEqual(Math.min(...baseline("stdlib-chart-category-label")) - 11);
  });

  test("an explicit linear domain must contain the zero line, like every value", () => {
    expect(() => draw({ data: [{ label: "A", value: 10 }], yAxis: { domain: [5, 15] } })).toThrow(RangeError);
    expect(() => draw({ data: [{ label: "A", value: 10 }], yAxis: { domain: [0, 15] } })).not.toThrow();
  });

  test("a measured host lays labels out for its own width", () => {
    const data = Array.from({ length: 6 }, (_, index) => ({ label: `Region ${index}`, value: index }));
    expect(barChartLayout({ data }).layout).toBe("rows");
    expect(barChartLayout({ data, displayWidth: 640 }).layout).toBe("columns");
  });
});
