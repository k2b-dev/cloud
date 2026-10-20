import { expect, test } from "bun:test";
import { charts } from "@k2b/stdlib";
import { sqlResultChart } from "./sql-result-chart";

test("explains absent time/numeric columns and empty results", () => {
  expect(sqlResultChart({ columns: [], rows: [] })).toEqual({ kind: "none", reason: "no-rows" });
  expect(sqlResultChart({ columns: [{ name: "a", type: "UInt64" }], rows: [[1]] })).toEqual({ kind: "none", reason: "no-time-column" });
  expect(
    sqlResultChart({
      columns: [
        { name: "t", type: "Date" },
        { name: "label", type: "String" },
      ],
      rows: [["2026-10-20", "A"]],
    }),
  ).toEqual({ kind: "none", reason: "no-numeric-column" });
});
test("adapts the first time column and numeric/Nullable series to Chart line props", () => {
  const types = ["Int8", "UInt64", "Float32", "Decimal(18, 2)", "Nullable(Decimal64(3))"];
  for (const dateType of ["Date", "DateTime", "DateTime64(3, 'UTC')", "Nullable(DateTime)"]) {
    const result = sqlResultChart({
      columns: [
        { name: "t", type: dateType },
        { name: "later", type: "DateTime" },
        ...types.map((type) => ({ name: type, type })),
        { name: "skip", type: "String" },
      ],
      rows: [["2026-10-20 12:00:00", "2026-10-19", -2, "42", 0.5, "2.5", null, "4"]],
    });
    expect(result.kind).toBe("chart");
    if (result.kind !== "chart") return;
    expect(result.xColumn).toBe("t");
    expect(result.chart.kind).toBe("line");
    expect(result.chart.series).toHaveLength(5);
    expect(result.chart.series[0]).toEqual({ label: "Int8", data: [{ x: Date.parse("2026-10-20T12:00:00Z"), y: -2 }] });
    expect(result.chart.series[1]?.data[0]?.y).toBe(42);
    expect(result.chart.series[4]?.data).toEqual([]); // null never becomes zero.
    expect(result.truncated).toBe(false);
  }
});
test("caps 8 series / first 480 returned points without sorting or mutating", () => {
  const columns = [{ name: "t", type: "DateTime" }, ...Array.from({ length: 10 }, (_, index) => ({ name: `v${index}`, type: "Float64" }))];
  const rows = Array.from({ length: 600 }, (_, index) => [600 - index, ...Array.from({ length: 10 }, () => index)]);
  const result = sqlResultChart({ columns, rows });
  if (result.kind !== "chart") throw new Error("Missing chart");
  expect(result.cut).toEqual({ seriesShown: 8, seriesTotal: 10, pointsShown: 480, pointsTotal: 600 });
  expect(result.truncated).toBe(true);
  expect(result.chart.series[0]?.data[0]?.x).toBe(600000);
  expect(result.chart.series[0]?.data.at(-1)?.x).toBe(121000);
  expect(rows).toHaveLength(600);
});

test("DateTime column timezone and explicit offsets map to the correct instant", () => {
  for (const value of ["2026-10-20 12:00:00", "2026-10-20T12:00:00+02:00"]) {
    const result = sqlResultChart({
      columns: [
        { name: "t", type: "DateTime64(3, 'Europe/Berlin')" },
        { name: "v", type: "Float64" },
      ],
      rows: [[value, 1]],
    });
    if (result.kind !== "chart") throw new Error("Missing chart");
    expect(result.chart.series[0]?.data).toEqual([{ x: Date.parse("2026-10-20T10:00:00Z"), y: 1 }]);
  }
});

// Regression from actual mobile screenshots: timestamps must be readable and zone-bound.
test("time-axis labels honor the result timezone and inherited locale across years", () => {
  for (const locale of ["de", "en"]) {
    const result = sqlResultChart(
      {
        columns: [
          { name: "t", type: "DateTime64(3, 'Europe/Berlin')" },
          { name: "v", type: "Float64" },
        ],
        rows: [
          ["2026-12-31 23:00:00", 1],
          ["2027-01-01 01:00:00", 2],
        ],
      },
      locale,
    );
    if (result.kind !== "chart") throw new Error("Missing chart");
    const axis = result.chart.xAxis!;
    expect(axis.label).toContain("Europe/Berlin");
    const before = axis.format!(Date.parse("2026-12-31T22:00:00Z"));
    const after = axis.format!(Date.parse("2027-01-01T00:00:00Z"));
    expect(before).toContain("2026");
    expect(after).toContain("2027");
    expect(before).toContain("26");
    expect(after).toContain("27");
    expect(before).not.toContain("179");
    expect(axis.ticks).toBe(2);
    if (locale === "de") expect(before).toStartWith("31.12.2026");
    else expect(before).toStartWith("12/31/2026");
  }
});
test("date-only axes display calendar dates rather than invented clock times", () => {
  const result = sqlResultChart(
    {
      columns: [
        { name: "day", type: "Nullable(Date)" },
        { name: "v", type: "UInt64" },
      ],
      rows: [["2026-10-20", 1]],
    },
    "de",
  );
  if (result.kind !== "chart") throw new Error("Missing chart");
  expect(result.chart.xAxis!.format!(Date.parse("2026-10-20T00:00:00Z"))).toBe("20.10.2026");
});

const chartTitle = (chart: Extract<ReturnType<typeof sqlResultChart>, { kind: "chart" }>["chart"], time: string) =>
  chart.tooltip!({
    kind: "line",
    datum: {
      index: 0,
      role: "point",
      anchor: [0, 0],
      label: "v",
      values: [
        { key: "x", value: Date.parse(time) },
        { key: "y", value: 1 },
      ],
    },
  }).title;
test("compact same-day ticks retain date context and precise point inspection", () => {
  for (const type of ["DateTime", "DateTime64(3, 'UTC')"]) {
    const result = sqlResultChart(
      {
        columns: [
          { name: "t", type },
          { name: "v", type: "Float64" },
        ],
        rows: [
          ["2026-10-20T12:00:01.001Z", 1],
          ["2026-10-20T12:00:59.002Z", 2],
        ],
      },
      "de",
    );
    if (result.kind !== "chart") throw new Error("Missing chart");
    const f = result.chart.xAxis!.format!;
    expect(result.chart.xAxis!.label).toContain("20.10.2026");
    expect(f(Date.parse("2026-10-20T12:00:01Z"))).not.toBe(f(Date.parse("2026-10-20T12:00:59Z")));
    expect(chartTitle(result.chart, "1970-01-01T00:00:00Z")).not.toBe(chartTitle(result.chart, "2070-01-01T00:00:00Z"));
    if (type.startsWith("DateTime64"))
      expect(chartTitle(result.chart, "2026-10-20T12:00:01.001Z")).not.toBe(chartTitle(result.chart, "2026-10-20T12:00:01.002Z"));
  }
});
test("point inspection disambiguates repeated DST hours", () => {
  const result = sqlResultChart(
    {
      columns: [
        { name: "t", type: "DateTime('Europe/Berlin')" },
        { name: "v", type: "Float64" },
      ],
      rows: [
        ["2026-10-25T02:30:00+02:00", 1],
        ["2026-10-25T02:30:00+01:00", 2],
      ],
    },
    "de",
  );
  if (result.kind !== "chart") throw new Error("Missing chart");
  expect(chartTitle(result.chart, "2026-10-25T00:30:00Z")).not.toBe(chartTitle(result.chart, "2026-10-25T01:30:00Z"));
});

test("outward-rounded axis ticks retain their actual calendar date", () => {
  const result = sqlResultChart(
    {
      columns: [
        { name: "t", type: "DateTime('UTC')" },
        { name: "v", type: "UInt64" },
      ],
      rows: [
        ["1970-01-01 00:00:01", 1],
        ["1970-01-01 23:59:59", 2],
      ],
    },
    "de",
  );
  if (result.kind !== "chart") throw new Error("Missing chart");
  const text = result.chart.xAxis!.format!(100_000_000);
  expect(text).toBe("2.1.1970");
  const point = result.chart.tooltip!({
    kind: "line",
    datum: {
      index: 0,
      role: "point",
      anchor: [0, 0],
      label: "v",
      values: [
        { key: "x", value: 1000 },
        { key: "y", value: 1234.5 },
      ],
    },
  });
  expect(point.rows[0]?.value).toBe("1.234,5");
});

test("point inspection preserves the shared chart's small-decimal precision", () => {
  const result = sqlResultChart(
    {
      columns: [
        { name: "t", type: "DateTime" },
        { name: "v", type: "Float64" },
      ],
      rows: [["2026-10-20 00:00:00", 0.0001]],
    },
    "de",
  );
  if (result.kind !== "chart") throw new Error("Missing chart");
  const point = result.chart.tooltip!({
    kind: "line",
    datum: {
      index: 0,
      role: "point",
      anchor: [0, 0],
      label: "v",
      values: [
        { key: "x", value: 1000 },
        { key: "y", value: 0.0001 },
      ],
    },
  });
  expect(point.rows[0]?.value).toBe("0,0001");
});

test("DateTime64 chart labels only the two domain endpoints at full precision", () => {
  const result = sqlResultChart(
    {
      columns: [
        { name: "time", type: "DateTime64(3, 'UTC')" },
        { name: "v", type: "Float64" },
      ],
      rows: [
        ["2026-10-20 08:00:00.001", 1],
        ["2026-10-20 11:48:00.002", 2],
      ],
    },
    "de",
  );
  if (result.kind !== "chart") throw new Error("Missing chart");
  const svg = charts.line({ width: 480, height: 280, series: result.chart.series, xAxis: result.chart.xAxis });
  const labels = [...svg.matchAll(/<text class="stdlib-chart-tick-label"[^>]*text-anchor="middle">([^<]*)<\/text>/g)]
    .map((match) => match[1])
    .filter(Boolean);
  expect(labels).toEqual(["08:00:00,001", "11:48:00,002"]);
});

test("single-instant charts label the real timestamp without a spurious previous date", () => {
  for (const type of ["Date", "DateTime", "DateTime64(3, 'UTC')"]) {
    const value = type === "Date" ? "2026-10-20" : "2026-10-20 00:00:00";
    const result = sqlResultChart(
      {
        columns: [
          { name: "t", type },
          { name: "v", type: "UInt64" },
        ],
        rows: [[value, 1]],
      },
      "de",
    );
    if (result.kind !== "chart") throw new Error("Missing chart");
    const svg = charts.line({ width: 480, height: 280, series: result.chart.series, xAxis: result.chart.xAxis });
    const labels = [...svg.matchAll(/<text class="stdlib-chart-tick-label"[^>]*text-anchor="middle">([^<]*)<\/text>/g)]
      .map((match) => match[1])
      .filter(Boolean);
    expect(labels).toEqual([type === "Date" ? "20.10.2026" : type === "DateTime" ? "00:00:00" : "00:00:00,000"]);
  }
});
