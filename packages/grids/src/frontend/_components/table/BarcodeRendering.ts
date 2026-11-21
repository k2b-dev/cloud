import type { BarcodeFormat } from "../../../barcode-values";

export { barcodeUrl, barcodeValueText, canRenderBarcode } from "../../../barcode-values";

export type BarcodeSize = "table" | "detail";

export const barcodeSvgForDisplay = (svg: string, format: BarcodeFormat, size: BarcodeSize) => {
  const isQr = format.bcid === "qrcode";
  const svgStyle =
    size === "detail"
      ? isQr
        ? "display:block;width:min(18rem,70vw);height:min(18rem,70vw);"
        : "display:block;width:min(100%,28rem);height:auto;max-height:8rem;"
      : isQr
        ? "display:block;width:2rem;height:2rem;"
        : "display:block;height:2.25rem;width:auto;max-width:10rem;";
  return svg.replace("<svg ", `<svg style="${svgStyle}" `);
};

/** Names one drawing in the server markup, so the browser can show it again before its drawing code has loaded. */
export const barcodeKey = (text: string, format: BarcodeFormat, size: BarcodeSize) =>
  `${size}:${format.bcid}:${format.showText ? 1 : 0}:${text}`;
