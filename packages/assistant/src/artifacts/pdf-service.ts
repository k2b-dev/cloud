import {
  attachPdfFilesWithConfig,
  type GotenbergConfig,
  GotenbergRenderError,
  getGotenbergConfig,
  type RenderHtmlToPdfOptions,
  renderFacturXHtmlToPdfWithConfig,
  renderHtmlToPdfWithConfig,
} from "@k2b/cloud/services";
import { checkPdfBytes, PdfRequest } from "./pdf-contracts";
import { authorizeRuntimeScope } from "./runtime-scope";
import type { ArtifactIdentity } from "./service";
import { STORAGE_FILE_MAX_BYTES } from "./storage-contracts";

export async function authorizePdf(input: unknown, identity: ArtifactIdentity): Promise<void> {
  await authorizeRuntimeScope(input, identity);
}

export async function executePdf(input: unknown, config: GotenbergConfig, options: RenderHtmlToPdfOptions = {}) {
  const request = PdfRequest.parse(input);
  const bytes = checkPdfBytes(request);
  const bounded = {
    ...config,
    maxPdfBytes: Math.min(config.maxPdfBytes, STORAGE_FILE_MAX_BYTES),
    maxHtmlBytes: Math.min(config.maxHtmlBytes, STORAGE_FILE_MAX_BYTES),
  };
  if (request.operation !== "attach" && bytes > bounded.maxHtmlBytes)
    throw new GotenbergRenderError("html_too_large", "HTML and assets exceed the configured input budget.");
  if (request.operation === "attach") return attachPdfFilesWithConfig(request, bounded, options);
  // Code Mode documents render in standards mode, with or without their own doctype. The platform
  // renderer applies its offline HTML mode to the document, header and footer.
  const html = `<!doctype html>${request.html}`;
  return request.operation === "facturX"
    ? renderFacturXHtmlToPdfWithConfig({ ...request, html, conformanceLevel: request.profile }, bounded, options)
    : renderHtmlToPdfWithConfig({ ...request, html }, bounded, options);
}

export const studioPdf = {
  authorize: authorizePdf,
  async execute(input: unknown, signal: AbortSignal) {
    return executePdf(input, await getGotenbergConfig(), { signal });
  },
};
