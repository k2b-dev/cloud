import { PdfRequest, checkPdfBytes, type PdfRenderInput, type PdfFacturXInput, type PdfAttachInput } from "../pdf-contracts";
import { pdf } from "./documents";

export function createPdf(rpc: (method: string, args: unknown[], signal?: AbortSignal) => Promise<unknown>) {
  const call = async (input: unknown, options: { signal?: AbortSignal } = {}): Promise<Blob> => {
    options.signal?.throwIfAborted();
    const request = PdfRequest.parse(input);
    checkPdfBytes(request);
    const result = await rpc("pdf", [request], options.signal);
    if (!(result instanceof Blob)) throw new Error("PDF service returned an invalid file");
    return result;
  };
  return {
    open: pdf.open,
    render: (input: PdfRenderInput, options?: { signal?: AbortSignal }) => call({ ...input, operation: "render" }, options),
    facturX: (input: PdfFacturXInput, options?: { signal?: AbortSignal }) => call({ ...input, operation: "facturX" }, options),
    attach: (input: PdfAttachInput, options?: { signal?: AbortSignal }) => call({ ...input, operation: "attach" }, options),
  };
}
