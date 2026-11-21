import { describe, expect, test } from "bun:test";
import { barcodeDataUrl, renderBarcodeSvg } from "./barcode-rendering";
import { BarcodeRenderError } from "./barcode-values";

const code128Format = { kind: "barcode", bcid: "code128", showText: true } as const;
const qrFormat = { kind: "barcode", bcid: "qrcode" } as const;

describe("barcode rendering", () => {
  test("renders Code 128 SVGs for print output", () => {
    const svg = renderBarcodeSvg("ITEM-0001", code128Format, { color: "#111827" });

    expect(svg).toContain("<svg");
    expect(svg).toContain("#111827");
    expect(svg).toContain("<path");
  });

  test("renders QR SVGs for print output", () => {
    const svg = renderBarcodeSvg("https://example.test/item/1", qrFormat, { color: "#111827" });

    expect(svg).toContain("<svg");
    expect(svg).toContain("#111827");
  });

  test("returns an empty data URL value for empty barcode input", () => {
    expect(barcodeDataUrl("", code128Format)).toBe("");
    expect(barcodeDataUrl(null, qrFormat)).toBe("");
  });

  test("returns SVG data URLs for Liquid-safe PDF template attributes", () => {
    const dataUrl = barcodeDataUrl("ITEM-0001", code128Format);

    expect(dataUrl).toStartWith("data:image/svg+xml;base64,");
  });

  test("fails clearly for invalid barcode types", () => {
    expect(() => barcodeDataUrl("ITEM-0001", { kind: "barcode", bcid: "Code 128" })).toThrow(BarcodeRenderError);
  });
});
