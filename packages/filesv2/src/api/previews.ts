import { type AuthContext, auth, getLocale, middleware, requiresAuth, respond, v } from "@k2b/cloud/server";
import { ok } from "@k2b/stdlib";
import { Hono } from "hono";
import { z } from "zod";
import { DownloadInputSchema } from "../contracts";
import { requestCall } from "../files-call";
import { filesService } from "../service";
import { errorMessage } from "./messages";

const PreviewQuery = DownloadInputSchema.extend({ rev: z.string().min(1).max(256), size: z.enum(["small", "large", "pdf", "text"]) });
export const previewApi = new Hono<AuthContext>()
  .get(
    "/bases/:baseId/preview",
    middleware.openapi({
      summary: "Read a file preview",
      ...requiresAuth,
      responses: {
        200: { description: "Private preview bytes" },
        202: { description: "Preview pending; retry after Retry-After seconds" },
        404: { description: "Preview failed, unsupported or too large" },
      },
    }),
    v("query", PreviewQuery),
    async (c) => {
      c.header("Cache-Control", "no-store");
      const { result, immutable } = await filesService.preview(
        requestCall(c),
        { baseId: c.req.param("baseId") ?? "", ...c.req.valid("query") },
        c.req.raw.signal,
      );
      if (result.state === "pending") {
        c.header("Retry-After", String(result.retryAfter));
        return respond(c, ok({ state: "pending" as const }), 202);
      }
      if (result.state !== "ready") {
        const code = `preview_${result.state}`;
        return respond(c, { ok: false, error: errorMessage(code, getLocale(c)), status: 404, code });
      }
      const headers = new Headers({
        "Content-Type": result.type,
        "Content-Length": String(result.bytes),
        "Cache-Control": immutable ? "private, max-age=31536000, immutable" : "no-store",
        "X-Content-Type-Options": "nosniff",
        "Cross-Origin-Resource-Policy": "same-origin",
      });
      if (result.type === "application/pdf") {
        headers.set("Content-Disposition", "inline");
        headers.set("Content-Security-Policy", "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'");
      }
      return new Response(result.body, { headers });
    },
  )
  .post(
    "/bases/:baseId/preview/retry",
    auth.readOnly,
    middleware.openapi({ summary: "Retry a failed file preview", ...requiresAuth }),
    v("json", DownloadInputSchema),
    async (c) => {
      c.header("Cache-Control", "no-store");
      return respond(
        c,
        ok(await filesService.retryPreview(requestCall(c), { baseId: c.req.param("baseId") ?? "", ...c.req.valid("json") })),
      );
    },
  );
