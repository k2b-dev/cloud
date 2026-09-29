import { FilesError } from "./service/errors";

const SIGNATURE = new TextEncoder().encode("%PDF-");
/** Browser viewers look for the signature in the first 1024 bytes, as pdf.js and PDFium do, not only at the start. */
export const PDF_HEADER_WINDOW = 1024;

/** Whether a viewer would open these leading bytes as a PDF; shared by the server route and the preview. */
export function hasPdfSignature(head: Uint8Array) {
  const last = Math.min(head.byteLength, PDF_HEADER_WINDOW) - SIGNATURE.byteLength;
  for (let start = 0; start <= last; start++) if (SIGNATURE.every((byte, index) => head[start + index] === byte)) return true;
  return false;
}

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
  while (size < PDF_HEADER_WINDOW) {
    const part = await reader.read();
    if (part.done) break;
    head.push(part.value);
    size += part.value.byteLength;
  }
  const prefix = Buffer.concat(head);
  if (!hasPdfSignature(prefix)) {
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
