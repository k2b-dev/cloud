import { describe, expect, test } from "bun:test";
import { BARCODE_GROUPS, barcodeGroups, searchBarcodeOptions } from "./barcode-options";

describe("barcode option groups", () => {
  test("uses the complete barcode taxonomy", () => {
    expect(BARCODE_GROUPS.map((group) => group.label)).toEqual([
      "Recommended",
      "Linear",
      "2D",
      "GS1 & retail",
      "Postal",
      "Healthcare",
      "Publishing",
    ]);
  });

  test("supports overlapping code families", () => {
    expect(barcodeGroups("isbn")).toEqual(["recommended", "linear", "gs1-retail", "publishing"]);
    expect(barcodeGroups("gs1datamatrix")).toEqual(["recommended", "2d", "gs1-retail"]);
    expect(barcodeGroups("hibcqrcode")).toEqual(["2d", "healthcare"]);
  });

  test("combines group filters with search", () => {
    expect(searchBarcodeOptions("qr").map((option) => option.id)).toEqual(["qrcode", "microqrcode"]);
    expect(searchBarcodeOptions("qr", "healthcare").map((option) => option.id)).toEqual(["hibcqrcode"]);
    expect(searchBarcodeOptions("", "postal").map((option) => option.id)).toContain("royalmail");
    expect(searchBarcodeOptions("", null).length).toBe(60);
  });
});
