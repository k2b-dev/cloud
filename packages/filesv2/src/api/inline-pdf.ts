import { type AuthContext, middleware, requiresAuth, v } from "@k2b/cloud/server";
import { Hono } from "hono";
import { z } from "zod";
import { DownloadInputSchema } from "../contracts";
import { filesService } from "../service";

/** The browser's viewer shows the PDF; nothing from the response may load, submit, or be framed. */
const POLICY = "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/** RFC 6266 with an RFC 5987 UTF-8 name and an ASCII fallback for older clients. */
const inlineDisposition = (name: string) => {
  const fallback = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `inline; filename="${fallback}"; filename*=UTF-8''${encoded}`;
};

/**
 * A stable same-origin address for a stored PDF in the browser's viewer. The file name
 * is the last path segment, which viewers show as the title; each request is authorized
 * with the session, so a reload reads the current file with current rights.
 */
export const inlinePdfApi = new Hono<AuthContext>().get(
  "/bases/:baseId/pdf/:path{.+}",
  middleware.openapi({ summary: "Open a stored PDF in the browser's PDF viewer", ...requiresAuth }),
  v("param", z.object({ baseId: z.string().min(1), path: DownloadInputSchema.shape.path })),
  async (c) => {
    const pdf = await filesService.inlinePdf(c.get("actor"), c.req.valid("param"), c.req.raw.signal);
    const headers = new Headers({
      "Content-Type": "application/pdf",
      "Content-Disposition": inlineDisposition(pdf.name),
      "Content-Security-Policy": POLICY,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
      "Cross-Origin-Resource-Policy": "same-origin",
    });
    if (pdf.length) headers.set("Content-Length", pdf.length);
    return new Response(pdf.body, { headers });
  },
);
