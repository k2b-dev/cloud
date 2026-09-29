import { FilesError } from "./service/errors";

const SIGNATURE = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"

/** Files keeps no media type besides the name; a PDF is a `.pdf` file, as in the preview. */
export const isPdfName = (name: string) => name.toLowerCase().endsWith(".pdf");

/**
 * The body of a stored PDF, only if its bytes start with the PDF signature, so a renamed
 * file never reaches a browser viewer. Only the first bytes are read here; the rest streams
 * through untouched, and cancelling the result cancels the storage read.
 */
export async function pdfBody(response: Response): Promise<ReadableStream<Uint8Array>> {
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new FilesError("unavailable", 503);
  }
  const reader = response.body.getReader();
  const head: Uint8Array[] = [];
  let size = 0;
  while (size < SIGNATURE.length) {
    const part = await reader.read();
    if (part.done) break;
    head.push(part.value);
    size += part.value.byteLength;
  }
  const prefix = new Uint8Array(size);
  head.reduce((offset, part) => (prefix.set(part, offset), offset + part.byteLength), 0);
  if (!SIGNATURE.every((byte, index) => prefix[index] === byte)) {
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
