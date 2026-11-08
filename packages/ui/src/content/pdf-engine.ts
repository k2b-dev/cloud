import { GlobalWorkerOptions, getDocument, TextLayer } from "pdfjs-dist/legacy/build/pdf.mjs";
import { PDF_LIMITS, type PdfDocumentHandle, type PdfPageImage, type PdfPageSize, pdfTooLarge } from "./pdf-limits";

/**
 * The PDF engine: pdf.js and the glue `PdfViewer` needs. The @k2b/ui build bundles this module on its own into
 * `pdf-viewer-engine.js`; `openPdfDocument` loads it by address, so a host's bundle never contains pdf.js. The legacy
 * build also runs on older Safari on iPad. Parsing never runs code from the document: there is no scripting, XFA stays
 * off, and pdf.js loads nothing beyond the given bytes. `workerUrl` is resolved against this module, next to which the
 * host's bundler put the worker file.
 */
export async function openPdf(data: ArrayBuffer, signal: AbortSignal, workerUrl: string): Promise<PdfDocumentHandle | null> {
  GlobalWorkerOptions.workerSrc = new URL(workerUrl, import.meta.url).href;
  const task = getDocument({
    data: new Uint8Array(data),
    verbosity: 0,
    stopAtErrors: true,
    enableXfa: false,
    // Bounds decoded source images as well as the canvas each page is drawn on.
    maxImageSize: PDF_LIMITS.maxCanvasPixels,
    canvasMaxAreaInBytes: PDF_LIMITS.maxCanvasPixels * 4,
  });
  const stop = () => void task.destroy();
  signal.addEventListener("abort", stop, { once: true });
  const close = async () => {
    signal.removeEventListener("abort", stop);
    await task.destroy();
  };
  try {
    const pdf = await task.promise;
    if (pdf.numPages > PDF_LIMITS.maxPages) throw pdfTooLarge(`PDF has more than ${PDF_LIMITS.maxPages} pages`);
    const pages: PdfPageSize[] = [];
    for (let number = 1; number <= pdf.numPages; number++) {
      const { width, height } = (await pdf.getPage(number)).getViewport({ scale: 1 });
      if (signal.aborted) {
        await close();
        return null;
      }
      pages.push({ width, height });
    }

    const draw = async (index: number, widthPx: number, abort: AbortSignal): Promise<PdfPageImage | null> => {
      const page = await pdf.getPage(index + 1);
      if (abort.aborted) return null;
      const viewport = page.getViewport({ scale: widthPx / page.getViewport({ scale: 1 }).width });
      const canvas = document.createElement("canvas");
      try {
        canvas.width = Math.round(viewport.width);
        canvas.height = Math.round(viewport.height);
        const rendering = page.render({ canvas, viewport });
        const cancel = () => rendering.cancel();
        abort.addEventListener("abort", cancel, { once: true });
        try {
          await rendering.promise;
        } finally {
          abort.removeEventListener("abort", cancel);
        }
        const blob = await new Promise<Blob>((resolve, reject) =>
          canvas.toBlob((result) => (result ? resolve(result) : reject(new Error("The page could not be drawn"))), "image/png"),
        );
        if (abort.aborted) return null;
        return { url: URL.createObjectURL(blob), width: canvas.width, height: canvas.height };
      } finally {
        // Release the canvas right away, so a long document on an iPad keeps only the packed images.
        canvas.width = 0;
        canvas.height = 0;
        page.cleanup();
      }
    };

    const textLayer = async (index: number, container: HTMLElement, abort: AbortSignal): Promise<void> => {
      const page = await pdf.getPage(index + 1);
      if (abort.aborted) return;
      const viewport = page.getViewport({ scale: 1 });
      const layer = new TextLayer({ textContentSource: page.streamTextContent(), container, viewport });
      // pdf.js sizes the layer through its own rounded variables; zoom works through `--total-scale-factor` instead.
      const [x1 = 0, y1 = 0, x2 = 0, y2 = 0] = viewport.viewBox;
      container.style.width = `calc(var(--total-scale-factor) * ${x2 - x1}px)`;
      container.style.height = `calc(var(--total-scale-factor) * ${y2 - y1}px)`;
      const cancel = () => layer.cancel();
      abort.addEventListener("abort", cancel, { once: true });
      try {
        await layer.render();
      } finally {
        abort.removeEventListener("abort", cancel);
      }
    };

    return { pages, draw, textLayer, close };
  } catch (error) {
    await close();
    if (signal.aborted) return null;
    throw error;
  }
}
