import type { FormatSpec } from "./contracts";

/**
 * What a barcode shows and whether a field can show one. Kept apart from the drawing code in `barcode-rendering.ts`,
 * which is large; the browser loads that only when a barcode is drawn.
 */
export type BarcodeFormat = Extract<FormatSpec, { kind: "barcode" }>;

export const barcodeValueText = (value: unknown): string => {
  if (Array.isArray(value)) return barcodeValueText(value[0]);
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
};

export const barcodeUrl = (value: unknown): string | null => {
  const text = barcodeValueText(value).trim();
  if (!text) return null;
  try {
    const url = new URL(text);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
};

export const canRenderBarcode = (type: string): boolean => type === "text" || type === "id" || type === "formula" || type === "lookup";
