import { GotenbergRenderError, attachPdfFilesWithConfig, getGotenbergConfig, renderHtmlToPdfWithConfig, renderFacturXHtmlToPdfWithConfig, type GotenbergConfig, type RenderHtmlToPdfOptions } from "@k2b/cloud/services";
import { PdfRequest, checkPdfBytes } from "./pdf-contracts";
import { authorizeRuntimeScope } from "./runtime-scope";
import type { ArtifactIdentity } from "./service";
import { STORAGE_FILE_MAX_BYTES } from "./storage-contracts";

export async function authorizePdf(input: unknown, identity: ArtifactIdentity): Promise<void> {
  await authorizeRuntimeScope(input, identity);
}

// Defense in depth alongside Gotenberg's request-directory file isolation.
// No script, frame, redirect or outbound resource can run from supplied HTML.
export async function offlinePdfHtml(html: string): Promise<string> {
  const clean = await new HTMLRewriter()
    .on("script, meta, base, iframe, frame, frameset, object, embed", { element(element) { element.remove(); } })
    .transform(new Response(html)).text();
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' file: data:; img-src file: data:; font-src file: data:; base-uri 'none'; form-action 'none'">${clean}`;
}

export async function executePdf(input: unknown, config: GotenbergConfig, options: RenderHtmlToPdfOptions = {}) {
  const request = PdfRequest.parse(input);
  const bytes = checkPdfBytes(request);
  const bounded = { ...config, maxPdfBytes: Math.min(config.maxPdfBytes, STORAGE_FILE_MAX_BYTES), maxHtmlBytes: Math.min(config.maxHtmlBytes, STORAGE_FILE_MAX_BYTES) };
  if (request.operation !== "attach" && bytes > bounded.maxHtmlBytes)
    throw new GotenbergRenderError("html_too_large", "HTML and assets exceed the configured input budget.");
  if (request.operation === "attach") return attachPdfFilesWithConfig(request, bounded, options);
  const html = {
    ...request,
    html: await offlinePdfHtml(request.html),
    headerHtml: request.headerHtml ? await offlinePdfHtml(request.headerHtml) : undefined,
    footerHtml: request.footerHtml ? await offlinePdfHtml(request.footerHtml) : undefined,
  };
  return request.operation === "facturX"
    ? renderFacturXHtmlToPdfWithConfig({ ...html, xml: request.xml, conformanceLevel: request.profile }, bounded, options)
    : renderHtmlToPdfWithConfig(html, bounded, options);
}

export const studioPdf = {
  authorize: authorizePdf,
  async execute(input: unknown, signal: AbortSignal) {
    return executePdf(input, await getGotenbergConfig(), { signal });
  },
};
