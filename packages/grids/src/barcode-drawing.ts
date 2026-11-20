/**
 * Barcode drawing as the server uses it: synchronous and always there. The browser resolves `#barcode-drawing` to
 * `barcode-drawing.browser.ts`, which loads the drawing code (about 200 KB Brotli) only when a barcode is drawn.
 */
export { barcodeDataUrl, barcodeSvgForCell } from "./barcode-rendering";

/** Whether the drawing functions can run now; in the browser it turns true, reactively, once the code has loaded. */
export const barcodesReady = (): boolean => true;

/** Starts loading the drawing code; the server has it already. */
export const preloadBarcodes = (): void => {};
