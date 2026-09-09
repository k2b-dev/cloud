import "pdfjs-dist/build/pdf.worker.mjs";
import { getDocument } from "pdfjs-dist";
import { LIMITS } from "../contracts";

/** Text-only PDF.js extraction inside the existing terminable Kit worker. */
export async function pdfText(file: Blob, options: { onProgress?: (page: number, total: number) => void } = {}) {
  if (!(file instanceof Blob) || file.size > LIMITS.rpcBytes) throw new Error("PDF must be a local file of at most 16 MiB.");
  const task = getDocument({
    data: new Uint8Array(await file.arrayBuffer()),
    disableFontFace: true,
    useSystemFonts: false,
    useWorkerFetch: false,
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
    useWasm: false,
    verbosity: 0,
  });
  try {
    const doc = await task.promise;
    if (doc.numPages > LIMITS.rows) throw new Error("PDF exceeds 1000 pages.");
    const pages: { page: number; text: string }[] = [];
    let size = 0;
    for (let number = 1; number <= doc.numPages; number++) {
      const page = await doc.getPage(number);
      const content = await page.getTextContent();
      const text = content.items.map((item) => ("str" in item ? item.str + (item.hasEOL ? "\n" : " ") : "")).join("");
      size += text.length * 2;
      if (size > LIMITS.rpcBytes) throw new Error("PDF text exceeds 16 MiB.");
      pages.push({ page: number, text });
      page.cleanup();
      options.onProgress?.(number, doc.numPages);
    }
    return pages;
  } finally {
    await task.destroy();
  }
}
