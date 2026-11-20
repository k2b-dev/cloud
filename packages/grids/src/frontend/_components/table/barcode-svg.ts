import { barcodeSvgForCell } from "../../../barcode-rendering";
import type { BarcodeFormat } from "../../../barcode-values";
import { type BarcodeSize, barcodeSvgForDisplay } from "./BarcodeRendering";

/**
 * The sized SVG markup of a barcode cell, or `null` when the value cannot be drawn. The server draws synchronously;
 * the browser variant (`barcode-svg.browser.ts`) loads the drawing code on demand and answers `undefined` meanwhile.
 */
export const barcodeMarkup = (value: unknown, format: BarcodeFormat, size: BarcodeSize): string | null | undefined => {
  const svg = barcodeSvgForCell(value, format);
  return svg ? barcodeSvgForDisplay(svg, format, size) : null;
};

/** Starts loading the drawing code in the browser; the server has it already. */
export const preloadBarcodes = (): void => {};
