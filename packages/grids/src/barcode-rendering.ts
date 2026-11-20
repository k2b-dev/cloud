import { toSVG } from "@bwip-js/generic";
import { qr } from "@k2b/stdlib/qr";
import { type BarcodeFormat, barcodeValueText } from "./barcode-values";

const BARCODE_BCID_RE = /^[a-z0-9]+$/;
const DEFAULT_PRINT_COLOR = "#0f172a";

export class BarcodeRenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BarcodeRenderError";
  }
}

const validateBcid = (bcid: string): string => {
  const normalized = bcid.trim();
  if (!BARCODE_BCID_RE.test(normalized) || normalized.length > 80) {
    throw new BarcodeRenderError(`invalid barcode type "${bcid}"`);
  }
  return normalized;
};

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const svgToBase64 = (svg: string): string => {
  if (typeof Buffer !== "undefined") return Buffer.from(svg, "utf8").toString("base64");
  const bytes = new TextEncoder().encode(svg);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

export const renderBarcodeSvg = (value: unknown, format: BarcodeFormat, options: { color?: string } = {}): string | null => {
  const text = barcodeValueText(value).trim();
  if (!text) return null;

  const bcid = validateBcid(format.bcid);
  const color = options.color ?? "currentColor";

  try {
    if (bcid === "qrcode") return qr.toSvg(text, { on: color, off: "transparent", correctionLevel: "M" });
    return toSVG({
      bcid,
      text,
      scale: 2,
      height: 12,
      includetext: Boolean(format.showText),
      textsize: 8,
    }).replaceAll("#000000", color);
  } catch (error) {
    throw new BarcodeRenderError(`could not render ${bcid} barcode: ${errorMessage(error)}`);
  }
};

export const barcodeSvgForCell = (value: unknown, format: BarcodeFormat): string | null => {
  try {
    return renderBarcodeSvg(value, format, { color: "currentColor" });
  } catch {
    return null;
  }
};

export const barcodeDataUrl = (value: unknown, format: BarcodeFormat, options: { color?: string } = {}): string => {
  const svg = renderBarcodeSvg(value, format, { color: options.color ?? DEFAULT_PRINT_COLOR });
  return svg ? `data:image/svg+xml;base64,${svgToBase64(svg)}` : "";
};
