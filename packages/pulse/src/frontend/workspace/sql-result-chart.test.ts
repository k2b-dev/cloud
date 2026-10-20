import { expect, test } from "bun:test";
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
