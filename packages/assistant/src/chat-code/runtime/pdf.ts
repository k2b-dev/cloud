import { checkPdfBytes, type PdfAttachInput, type PdfFacturXInput, type PdfRenderInput, PdfRequest } from "../../chat-code/pdf-contracts";
import { type Html, html as markup, resolveChartHtml } from "./lib";

export function createPdf(rpc: (method: string, args: unknown[], signal?: AbortSignal) => Promise<unknown>, locale = "en-US") {
  const call = async (input: unknown, options: { signal?: AbortSignal } = {}): Promise<Blob> => {
    options.signal?.throwIfAborted();
    const request = PdfRequest.parse(input);
    checkPdfBytes(request);
    const result = await rpc("pdf", [request], options.signal);
    if (!(result instanceof Blob)) throw new Error("PDF service returned an invalid file");
    return result;
  };
  return {
    render: async (
      input: Omit<PdfRenderInput, "html"> & {
        html: string | Html;
        title?: string;
        facturX?: { xml: string; profile?: PdfFacturXInput["profile"] };
      },
      options?: { signal?: AbortSignal },
    ) => {
      options?.signal?.throwIfAborted();
      const { title, facturX, ...html } = input;
      const rawContent = html.html instanceof String ? String(html.html) : html.html;
      const content = typeof rawContent === "string" ? await resolveChartHtml(rawContent, locale) : rawContent;
      if (title !== undefined && typeof title !== "string") throw new TypeError("PDF title must be a string.");
      return call(
        {
          ...html,
          html: title !== undefined && typeof content === "string" ? String(markup`<title>${title}</title>`) + content : content,
          ...(facturX ? { operation: "facturX", ...facturX, profile: facturX.profile ?? "EN 16931" } : { operation: "render" }),
        },
        options,
      );
    },
    attach: (input: PdfAttachInput, options?: { signal?: AbortSignal }) => call({ ...input, operation: "attach" }, options),
  };
}
