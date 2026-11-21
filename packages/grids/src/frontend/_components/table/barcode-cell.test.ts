import { describe, expect, test } from "bun:test";
import { barcodeSvgForCell } from "../../../barcode-rendering";
import { barcodeSvgForDisplay, canRenderBarcode } from "./BarcodeRendering";

const qrFormat = { kind: "barcode", bcid: "qrcode" } as const;
const code128Format = { kind: "barcode", bcid: "code128", showText: true } as const;
const isbnFormat = { kind: "barcode", bcid: "isbn", showText: true } as const;

describe("BarcodeCell", () => {
  test("renders QR SVGs for text values", () => {
    const svg = barcodeSvgForCell("https://bookshop.example", qrFormat);

    expect(svg).toContain("<svg");
    expect(svg).toContain("currentColor");
  });

  test("normalizes single lookup arrays before rendering", () => {
    const svg = barcodeSvgForCell(["https://bookshop.example"], qrFormat);

    expect(svg).toContain("<svg");
    expect(svg).toContain("currentColor");
  });

  test("allows barcode formats on lookup display values", () => {
    expect(canRenderBarcode("lookup")).toBe(true);
  });

  test("renders inventory-style generated ids as Code 128", () => {
    const svg = barcodeSvgForCell("ITEM-0001", code128Format);

    expect(svg).toContain("<svg");
    expect(svg).toContain("<path");
  });

  test("normalizes bwip black strokes to currentColor for theme-aware display", () => {
    const svg = barcodeSvgForCell("ITEM-0001", code128Format);

    expect(svg).toContain("currentColor");
    expect(svg).not.toContain("#000000");
  });

  test("renders hyphenated ISBN values", () => {
    const svg = barcodeSvgForCell("978-0-547-92822-7", isbnFormat);

    expect(svg).toContain("<svg");
    expect(svg).toContain("<path");
  });

  test("sizes linear SVGs explicitly so viewBox-only barcodes do not collapse", () => {
    const raw = barcodeSvgForCell("ITEM-0001", code128Format);
    const html = barcodeSvgForDisplay(raw!, code128Format, "table");

    expect(html).toContain("height:2.25rem");
  });

  test("sizes detail QR codes prominently", () => {
    const raw = barcodeSvgForCell("https://bookshop.example", qrFormat);
    const html = barcodeSvgForDisplay(raw!, qrFormat, "detail");

    expect(html).toContain("width:min(18rem,70vw)");
  });
});
