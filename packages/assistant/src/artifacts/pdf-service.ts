import { aiConversations, aiProjects } from "@k2b/cloud/ai";
import { GotenbergRenderError, attachPdfFilesWithConfig, getGotenbergConfig, renderHtmlToPdfWithConfig, renderFacturXHtmlToPdfWithConfig, type GotenbergConfig, type RenderHtmlToPdfOptions } from "@k2b/cloud/services";
import { z } from "zod";
import { HttpScope } from "./http-contracts";
import { PdfRequest, checkPdfBytes } from "./pdf-contracts";
import { artifacts, ArtifactError, user, type ArtifactIdentity } from "./service";
import { STORAGE_FILE_MAX_BYTES } from "./storage-contracts";

export async function authorizePdf(input: unknown, identity: ArtifactIdentity) {
  const scope = HttpScope.parse(input);
  const actor = user(identity);
  if (scope.conversationId) {
    const chat = z.uuid().safeParse(scope.conversationId).success
      ? await aiConversations.getConversation({ conversationId: scope.conversationId, ownerUserId: actor.id })
      : await aiConversations.getConversationByShortId({ shortId: scope.conversationId, ownerUserId: actor.id });
    if (!chat || chat.archivedAt || (chat.allowedTools !== null && chat.allowedTools !== undefined)
      || (chat.projectId && !(await aiProjects.get(chat.projectId, identity.accessSubject, "read")))) throw new ArtifactError("ACCESS_DENIED");
    scope.conversationId = chat.id;
  }
  if (scope.resourceId) await artifacts.get(scope.resourceId, { ...identity, conversationId: scope.conversationId });
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
