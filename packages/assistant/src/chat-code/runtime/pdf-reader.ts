import { getDocument } from "pdfjs-dist";
import { guarded } from "./errors";
import "pdfjs-dist/build/pdf.worker.mjs";
// Parsing expands compressed data into XML/text and object graphs. This is a
// per-document working-set budget, never a limit on the selected folder.
export const DOCUMENT_BYTES = 64 * 1024 * 1024;
function checkFile(file: Blob) {
  if (!(file instanceof Blob)) throw new Error("Expected a local File or Blob");
  if (file.size > DOCUMENT_BYTES)
    throw new Error("Document exceeds the 64 MiB per-file parsing budget. Split this document; other files can still be processed.");
}

export const pdf = {
  async open(file: Blob) {
    checkFile(file);
    const task = getDocument({
      verbosity: 0,
      data: new Uint8Array(await file.arrayBuffer()),
      useSystemFonts: false,
      disableFontFace: true,
      useWorkerFetch: false,
      isOffscreenCanvasSupported: false,
      isImageDecoderSupported: false,
      stopAtErrors: true,
    });
    try {
      const document = await task.promise;
      let closed = false;
      return {
        pageCount: document.numPages,
        async readPage(number: number) {
          if (closed) throw new Error("PDF is closed");
          if (!Number.isInteger(number) || number < 1 || number > document.numPages)
            throw new Error("PDF page number is out of range (pages start at 1)");
          const page = await document.getPage(number);
          try {
            const content = await page.getTextContent();
            const viewport = page.getViewport({ scale: 1 });
            const items = content.items.flatMap((item) =>
              "str" in item
                ? [
                    {
                      text: item.str,
                      transform: item.transform,
                      width: item.width,
                      height: item.height,
                      direction: item.dir,
                      endOfLine: item.hasEOL,
                    },
                  ]
                : [],
            );
            return {
              page: number,
              width: viewport.width,
              height: viewport.height,
              text: items.map((item) => item.text + (item.endOfLine ? "\n" : " ")).join(""),
              items,
            };
          } finally {
            page.cleanup();
          }
        },
        async close() {
          closed = true;
          await task.destroy();
        },
      };
    } catch (error) {
      await task.destroy();
      throw error;
    }
  },
};

export async function read(file: Blob) {
  const doc = await pdf.open(file);
  return { pageCount: doc.pageCount, page: guarded(doc.readPage), close: guarded(doc.close) };
}
