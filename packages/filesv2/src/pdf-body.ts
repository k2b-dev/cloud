import { FilesError } from "./service/errors";

/** Browser viewers look for the signature in the first 1024 bytes, as pdf.js and PDFium do, not only at the start. */
const SIGNATURE = "%PDF-";
const HEADER_WINDOW = 1024;

/** Files keeps no media type besides the name; a PDF is a `.pdf` file, as in the preview. */
export const isPdfName = (name: string) => name.toLowerCase().endsWith(".pdf");

/**
 * The body of a stored PDF, only if the PDF signature is where a viewer looks for it, so a
 * renamed file never reaches a browser viewer. Only the first bytes are read here; the rest
 * streams through untouched, and cancelling the result cancels the storage read.
 */
export async function pdfBody(response: Response): Promise<ReadableStream<Uint8Array>> {
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new FilesError("unavailable", 503);
  }
  const reader = response.body.getReader();
  const head: Uint8Array[] = [];
  let size = 0;
  while (size < HEADER_WINDOW) {
    const part = await reader.read();
    if (part.done) break;
    head.push(part.value);
    size += part.value.byteLength;
  }
  const prefix = Buffer.concat(head);
  if (!prefix.subarray(0, HEADER_WINDOW).includes(SIGNATURE)) {
    await reader.cancel();
    throw new FilesError("not_pdf");
  }
  return new ReadableStream<Uint8Array>({
    start: (controller) => controller.enqueue(prefix),
    pull: async (controller) => {
      const part = await reader.read();
      if (part.done) controller.close();
      else controller.enqueue(part.value);
    },
    cancel: (reason) => reader.cancel(reason),
  });
}
