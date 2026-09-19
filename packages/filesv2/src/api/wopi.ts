import { type AuthContext, auth, middleware, rateLimit } from "@k2b/cloud/server";
import { FilegateError } from "@k2b/filegate";
import type { Context } from "hono";
import { Hono } from "hono";
import { EDITOR_DOCUMENT_LIMIT, FilesError, filesService } from "../service";

/**
 * WOPI host for Collabora Online. Collabora authenticates with the editor token from the `access_token`
 * query parameter, never with a Cloud session, and reads or writes whole documents through these routes.
 */
const token = (c: Context<AuthContext>) => c.req.query("access_token") ?? "";
const wopiRoute = (summary: string) => middleware.openapi({ summary: `${summary} (Collabora WOPI, editor token in access_token)`, security: [] });
export const wopiApi = new Hono<AuthContext>()
  .use("*", rateLimit({ keyBy: "ip", limitPerSecond: 20, windowSecs: 60 }))
  .use("*", auth.requireRole("*"))
  .onError((error, c) => {
    if (error instanceof FilesError) return c.json({ code: error.code }, error.status);
    if (error instanceof FilegateError && error.status === 404) return c.json({ code: "not_found" }, 404);
    return c.json({ code: "unavailable" }, 503);
  })
  .get("/files/:id", wopiRoute("Describe the file and the user's rights"), async (c) =>
    c.json(await filesService.editorFileInfo(token(c), c.req.param("id") ?? "")),
  )
  .get("/files/:id/contents", wopiRoute("Read the current document bytes"), async (c) => {
    const upstream = await filesService.editorContent(token(c), c.req.param("id") ?? "");
    const headers = new Headers({ "content-type": "application/octet-stream", "cache-control": "no-store" });
    const length = upstream.headers.get("content-length");
    if (length) headers.set("content-length", length);
    return new Response(upstream.body, { headers });
  })
  .post("/files/:id/contents", wopiRoute("Store the document bytes Collabora saved"), async (c) => {
    const declared = c.req.header("content-length");
    if (!declared || !/^\d+$/.test(declared)) return c.json({ code: "length_required" }, 411);
    if (Number(declared) > EDITOR_DOCUMENT_LIMIT) return c.json({ code: "too_large" }, 413);
    const result = await filesService.editorSave(token(c), c.req.param("id") ?? "", {
      read: async () => {
        const body = await c.req.blob();
        if (body.size > EDITOR_DOCUMENT_LIMIT) throw new FilesError("too_large", 400);
        return body;
      },
      timestamp: c.req.header("x-cool-wopi-timestamp") ?? null,
    });
    // Collabora shows its own "document changed" dialog for this status and code.
    if ("conflict" in result) return c.json({ COOLStatusCode: 1010 }, 409);
    return c.json({ LastModifiedTime: result.modified });
  });
export type WopiApiType = typeof wopiApi;
