import { describe, expect, test } from "bun:test";
import { formatCell, progressRatio } from "./format-cell";

describe("formatCell", () => {
  test("renders percentage scales without changing their stored values", () => {
    expect(formatCell(25.125, "percent", {})).toBe("25.125%");
    expect(formatCell(0.25125, "percent", { range: "fraction" })).toBe("25.125%");
    expect(formatCell(0, "percent", { range: "fraction" })).toBe("0%");
  });
  test("a date reads short and numeric in the reader's locale, its day never shifted by a time zone", () => {
    expect(formatCell("2026-05-14T00:00:00+00:00", "date", {}, undefined, undefined, "de")).toBe("14.05.2026");
    expect(formatCell("2026-05-14", "date", {}, undefined, { timeZone: "America/Los_Angeles" }, "en")).toBe("05/14/2026");
    expect(formatCell("not a date", "date", {}, undefined, undefined, "de")).toBe("not a date");
  });

  test("renders date-time instants in the configured timezone and the reader's locale", () => {
    const berlin = { timeZone: "Europe/Berlin" };
    expect(formatCell("2026-05-14T08:30:00.000Z", "date", { includeTime: true }, undefined, berlin, "de")).toBe("14.05.2026, 10:30");
    expect(formatCell("2026-05-14T08:30:00.000Z", "date", { includeTime: true }, undefined, berlin, "en")).toBe("05/14/2026, 10:30");
  });

  test("an explicit ISO date format stays ISO", () => {
    expect(formatCell("2026-05-14", "date", {}, { kind: "date", format: "iso" }, undefined, "de")).toBe("2026-05-14");
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

  test("renders exact numeric values with configured precision, locale and unit", () => {
    expect(formatCell("12.3400", "number", { unit: "kg" })).toBe("12.34 kg");
    expect(formatCell("12400", "number", { decimalPlaces: 1, unit: "kg" }, undefined, undefined, "de")).toBe("12.400,0 kg");
    expect(formatCell("1.0000", "number", { integerOnly: true }, undefined, undefined, "de")).toBe("1");
    expect(formatCell("9007199254740993.2500", "number", { decimalPlaces: 2 }, undefined, undefined, "de")).toBe(
      "9.007.199.254.740.993,25",
    );
    expect(formatCell("10.0000", "number", { unit: "EUR", decimalPlaces: 4 }, { kind: "decimal" }, undefined, "de")).toBe("10 EUR");
  });

  test("an amount in a currency reads with its sign and thousands in the reader's locale", () => {
    const eur = { decimalPlaces: 2, unit: "EUR", unitPosition: "suffix" };
    expect(formatCell("12400", "number", eur, undefined, undefined, "de")).toBe("12.400,00\u00a0€");
    expect(formatCell("12400", "number", eur, undefined, undefined, "en")).toBe("€12,400.00");
    expect(formatCell("-987654321.5", "number", eur, undefined, undefined, "de")).toBe("-987.654.321,50\u00a0€");
    expect(formatCell("22.6", "number", { decimalPlaces: 2, unit: "EUR" }, undefined, undefined, "de")).toBe("22,60\u00a0€");
    expect(formatCell("12.3400", "number", { unit: "EUR", unitPosition: "prefix" }, undefined, undefined, "en")).toBe("€12.34");
    // more digits than the currency keeps, or other decimal places, keep the field's digits and its unit as written
    expect(formatCell("1.2345", "number", { unit: "EUR" }, undefined, undefined, "de")).toBe("1,2345 EUR");
    expect(formatCell("12400", "number", { decimalPlaces: 0, unit: "EUR" }, undefined, undefined, "de")).toBe("12.400 EUR");
    // a unit that is no currency code stays a unit
    expect(formatCell("12400", "number", { decimalPlaces: 2, unit: "€" }, undefined, undefined, "de")).toBe("12.400,00 €");
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
