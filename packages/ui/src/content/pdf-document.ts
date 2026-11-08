/**
 * Loads the PDF engine behind `PdfViewer`. The engine is pdf.js with a little glue, bundled once by the @k2b/ui build
 * into its own module next to the pdf.js worker. A host's bundler copies both as files and never bundles pdf.js
 * itself, so no page or script carries it until a document opens.
 */
/// <reference path="./pdf-worker.d.ts" />
// The build points these at its prebuilt `pdf-viewer-engine.js` and the worker copy `pdf-viewer-worker.js`.
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs" with { type: "file" };
// @ts-expect-error TypeScript reads a `type: "file"` import as a module import; the engine module has no default export.
import engineUrl from "./pdf-engine.ts" with { type: "file" };
import { PDF_LIMITS, type PdfDocumentHandle, pdfTooLarge } from "./pdf-limits";

export type { PdfDocumentHandle, PdfPageImage, PdfPageSize } from "./pdf-limits";
export { PDF_LIMITS, PDF_TOO_LARGE, pageImageWidth } from "./pdf-limits";

type PdfEngine = {
  openPdf: (data: ArrayBuffer, signal: AbortSignal, workerUrl: string) => Promise<PdfDocumentHandle | null>;
};

const isEngine = (value: unknown): value is PdfEngine =>
  typeof value === "object" && value !== null && typeof Reflect.get(value, "openPdf") === "function";

/** Opens a PDF; `null` after an abort. Throws `PDF_TOO_LARGE` past `PDF_LIMITS`, or pdf.js's error for a broken file. */
export const openPdfDocument = async (data: Blob | ArrayBuffer, signal: AbortSignal): Promise<PdfDocumentHandle | null> => {
  const size = data instanceof Blob ? data.size : data.byteLength;
  if (size > PDF_LIMITS.maxBytes) throw pdfTooLarge(`PDF is larger than ${PDF_LIMITS.maxBytes} bytes`);
  const bytes = data instanceof Blob ? await data.arrayBuffer() : data;
  if (signal.aborted) return null;
  // A relative address resolves against this module, where the bundler put the engine file.
  const engine: unknown = await import(/* @vite-ignore */ engineUrl);
  if (!isEngine(engine)) throw new Error("The PDF engine could not be loaded");
  return engine.openPdf(bytes, signal, workerUrl);
};
