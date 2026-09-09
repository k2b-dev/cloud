import { describe, expect, test } from "bun:test";
import { formatCell, progressRatio } from "./format-cell";

describe("formatCell", () => {
  test("normalizes date timestamps to date-only by default", () => {
    expect(formatCell("2026-05-14T00:00:00+00:00", "date", {})).toBe("2026-05-14");
  });

  test("renders date-time instants in the configured timezone", () => {
    expect(formatCell("2026-05-14T08:30:00.000Z", "date", { includeTime: true }, undefined, { timeZone: "Europe/Berlin" })).toBe(
      "2026-05-14 10:30",
    );
  });

  test("does not timezone-shift date-only formatted values", () => {
    expect(
      formatCell("2026-05-14", "date", {}, { kind: "date", format: "long", includeTime: false }, { timeZone: "America/Los_Angeles" }),
    ).toContain("14");
  });

  test("renders select option labels in stored order", () => {
    expect(
      formatCell(["done", "open"], "select", {
        options: [
          { id: "open", label: "Open" },
          { id: "done", label: "Done" },
        ],
      }),
    ).toBe("Done, Open");
  });

  test("renders number units without changing stored decimal text", () => {
    expect(formatCell("12.3400", "number", { unit: "EUR", unitPosition: "prefix" })).toBe("EUR 12.3400");
    expect(formatCell("12.3400", "number", { unit: "kg" })).toBe("12.3400 kg");
  });

  test("applies decimal format overrides only to numeric/formula values", () => {
    expect(formatCell("1234.5", "number", {}, { kind: "decimal", precision: 2, thousandsSeparator: true })).toBe("1,234.50");
    expect(formatCell("1234.5", "text", {}, { kind: "decimal", precision: 2, thousandsSeparator: true })).toBe("1234.5");
    expect(formatCell("1234.5", "number", {}, { kind: "decimal", precision: 2, thousandsSeparator: true }, undefined, "de")).toBe(
      "1.234,50",
    );
    expect(formatCell("1234.5", "number", {}, { kind: "decimal", precision: 2, thousandsSeparator: true }, undefined, "de-CH")).toBe(
      new Intl.NumberFormat("de-CH", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(1234.5),
    );
  });

  test("localizes boolean labels", () => {
    expect(formatCell(true, "boolean", {}, undefined, undefined, "en")).toBe("Yes");
    expect(formatCell(false, "boolean", {}, undefined, undefined, "de-CH")).toBe("Nein");
  });

  test("renders duration seconds as HH:MM:SS", () => {
    expect(formatCell(3661, "duration", {})).toBe("01:01:01");
  });
});

describe("progressRatio", () => {
  test("normalizes percent fields from 0..100 unless configured as fraction", () => {
    expect(progressRatio(50, "percent", {})).toBe(0.5);
    expect(progressRatio(0.5, "percent", { range: "fraction" })).toBe(0.5);
  });

  test("clamps formula-like values to a safe 0..1 ratio", () => {
    expect(progressRatio(-1, "formula", {})).toBe(0);
    expect(progressRatio(2, "formula", {})).toBe(1);
    expect(progressRatio("not a number", "formula", {})).toBe(0);
  });
});
