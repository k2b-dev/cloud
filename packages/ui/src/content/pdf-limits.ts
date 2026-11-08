/** Shapes and bounds shared by `PdfViewer`, its loader, and the pdf.js engine. */

/** A page's size in PDF points at scale 1. */
export type PdfPageSize = { width: number; height: number };

/** One drawn page: an object URL the caller revokes, and its size in pixels. */
export type PdfPageImage = { url: string; width: number; height: number };

export type PdfDocumentHandle = {
  pages: readonly PdfPageSize[];
  /** Draws one page `widthPx` wide; `null` after an abort. The caller revokes the returned URL. */
  draw: (index: number, widthPx: number, signal: AbortSignal) => Promise<PdfPageImage | null>;
  /**
   * Lays the selectable, searchable text of one page into `container`. Positions are relative to the page; the font
   * follows `--total-scale-factor` (CSS pixels per point) on the container or above, so zoom changes only that value.
   */
  textLayer: (index: number, container: HTMLElement, signal: AbortSignal) => Promise<void>;
  close: () => Promise<void>;
};

/**
 * Bounds for one document. Bytes and pages bound parsing work and memory; a larger document falls back to the
 * browser's own viewer. Canvas pixels stay below the size Safari still draws (larger canvases come out blank).
 */
export const PDF_LIMITS = {
  maxBytes: 100 * 1024 * 1024,
  maxPages: 2000,
  maxCanvasPixels: 16_000_000,
  maxImageWidth: 4096,
} as const;

/** The name of the error a document past `PDF_LIMITS` raises; the host shows the browser's viewer instead. */
export const PDF_TOO_LARGE = "PdfTooLargeError";

export const pdfTooLarge = (message: string): Error => Object.assign(new Error(message), { name: PDF_TOO_LARGE });

/**
 * Pixel width for a page image shown `displayWidth` CSS pixels wide: display width times the device pixel ratio
 * (at most 2), at least 400 px, at most `PDF_LIMITS.maxImageWidth`, and small enough that the canvas stays under
 * `PDF_LIMITS.maxCanvasPixels` for the page's height-to-width `ratio`. Very deep zoom turns slightly soft, never blank.
 */
export const pageImageWidth = (displayWidth: number, pixelRatio: number, ratio: number): number =>
  Math.round(
    Math.max(
      400,
      Math.min(
        displayWidth * Math.min(Math.max(pixelRatio, 1), 2),
        PDF_LIMITS.maxImageWidth,
        Math.sqrt(PDF_LIMITS.maxCanvasPixels / Math.max(ratio, 0.1)),
      ),
    ),
  );
