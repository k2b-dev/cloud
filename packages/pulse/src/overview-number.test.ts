import { expect, test } from "bun:test";
import { readOverviewNumber } from "./overview-number";
import { overviewParameters } from "./service/overview-queries";

const columns = [
  { name: "time", type: "DateTime64(3, 'Europe/Berlin')" },
  { name: "value", type: "Float64" },
  { name: "unit", type: "Nullable(String)" },
  { name: "detail", type: "String" },
  { name: "detailTone", type: "String" },
];
test("key numbers preserve SQL row order, last-row semantics, timezone and literal metadata", () => {
  const result = readOverviewNumber({
    columns,
    rows: [
      ["2026-10-20 12:05:00", 5, "ms", "old", "danger"],
      ["2026-10-20 12:00:00", 2, "ms", "<script>text</script>", "success"],
    ],
    truncated: true,
  });
  expect(result).toEqual({
    ok: true,
    data: {
      value: 2,
      valueAt: "2026-10-20T10:00:00.000Z",
      unit: "ms",
      detail: "<script>text</script>",
      detailTone: "success",
      points: [
        { x: Date.parse("2026-10-20T10:05:00Z"), y: 5 },
        { x: Date.parse("2026-10-20T10:00:00Z"), y: 2 },
      ],
      truncated: true,
    },
  });
});
test("optional metadata cannot discard valid numbers and trends or introduce styling from data", () => {
  for (const metadata of [
    [null, null, null],
    [42, false, "background:red"],
    [[], {}, "unknown"],
  ]) {
    const result = readOverviewNumber({ columns, rows: [["2026-10-20 12:00:00", 2, ...metadata]], truncated: false });
    expect(result).toMatchObject({ ok: true, data: { value: 2, unit: "", detail: "", detailTone: "neutral", points: [{ y: 2 }] } });
  }
  for (const tone of ["neutral", "success", "warning", "danger"]) {
    expect(readOverviewNumber({ columns, rows: [["2026-10-20 12:00:00", 2, "€", "Detail", tone]], truncated: false })).toMatchObject({
      ok: true,
      data: { detailTone: tone },
    });
  }
  expect(
    readOverviewNumber({
      columns: [
        { name: "value", type: "UInt64" },
        { name: "unit", type: "Float64" },
      ],
      rows: [["42", 8]],
      truncated: false,
    }),
  ).toMatchObject({ ok: true, data: { value: 42, valueAt: null, unit: "", points: [] } });
});
test("empty and invalid final values are never replaced with a previous good value", () => {
  expect(readOverviewNumber({ columns, rows: [], truncated: false })).toEqual({ ok: false, code: "NO_DATA" });
  for (const value of [null, "", true, "NaN", Infinity]) {
    expect(
      readOverviewNumber({
        columns,
        rows: [
          ["2026-10-20 12:00:00", 2],
          ["2026-10-20 12:05:00", value],
        ],
        truncated: false,
      }),
    ).toEqual({ ok: false, code: "INVALID_VALUE" });
  }
  expect(readOverviewNumber({ columns: [{ name: "value", type: "UInt64" }], rows: [["9007199254740993"]], truncated: false })).toEqual({
    ok: false,
    code: "INVALID_VALUE",
  });
});
test("automatic overview bindings replace only referenced window parameters", () => {
  const slot = new Date("2026-10-20T12:00:00Z");
  expect(overviewParameters({ sql: "SELECT 1", params: {} }, slot)).toEqual({});
  expect(overviewParameters({ sql: "SELECT :from,:to,:bucket,:other,:base_tz", params: { from: "old", other: "kept" } }, slot)).toEqual({
    from: "2026-10-19T12:00:00.000Z",
    to: "2026-10-20T12:00:00.000Z",
    bucket: "5m",
    other: "kept",
  });
});
