import { type AuthContext, getLocale } from "@k2b/cloud/server";
import type { Context } from "hono";
import { fileResponse } from "../../../../api/download-response";
import { documentMediaTypeAllowsPublicLinks } from "../../../../document-sharing";
import { gridsService } from "../../../../service";
import { resolveGridsMessages } from "../../../messages";

/**
 * Serves the stored primary artifact behind a public bearer link. The token is
 * the only credential: no session, no permission grant, no other document. The
 * link resolver already limits links to supported formats; the stored bytes'
 * media type is checked again here so a link never serves anything outside the
 * allow-list, and every response is an attachment with `nosniff`, so browsers
 * never render the file inline.
 */
export const publicDocumentLinkDownload = async (
  c: Context<AuthContext>,
  audit: { ip?: string | null; userAgent?: string | null },
): Promise<Response> => {
  const locale = getLocale(c);
  const { t } = resolveGridsMessages(locale);
  const resolved = await gridsService.document.resolveDocumentLinkDownload(c.req.param("token") ?? "");
  if (!resolved.ok) return c.json({ message: t.documentLinkNotFound }, 404);
  const { document, link } = resolved.data;
  const artifact = await gridsService.document.getPrimaryArtifact(document, locale);
  if (!artifact.ok) return c.json({ message: artifact.error.message }, artifact.error.status);
  if (!documentMediaTypeAllowsPublicLinks(artifact.data.mimeType)) return c.json({ message: t.documentLinkNotFound }, 404);
  const access = await gridsService.document.recordDocumentLinkAccess(link.id, audit);
  if (!access.ok) return c.json({ message: t.documentLinkNotFound }, 404);
  return fileResponse(artifact.data.bytes, artifact.data.filename, artifact.data.mimeType, {
    "X-Grids-Document-Id": document.shortId,
    "X-Grids-Document-Link-Id": link.shortId,
    "X-Grids-Document-Artifact": document.primaryArtifactKey,
  });
};
