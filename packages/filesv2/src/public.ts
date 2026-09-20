import { z } from "zod";
import { bodyLimit } from "hono/body-limit";
import { shareAccessCookie, setShareAccessCookie } from "./share-access-cookie";
import { type AuthContext, auth, getLocale, rateLimit, respond, v } from "@k2b/cloud/server";
import { FilegateError } from "@k2b/filegate";
import { ok } from "@k2b/stdlib";
import { Hono } from "hono";
import { errorMessage } from "./api/messages";
import { EntryQuerySchema, PublicBrowseQuerySchema, PublicUploadInputSchema, UploadIdSchema } from "./contracts";
import { FilesError, filesService } from "./service";

/** Public routes re-resolve the share and enforce its optional password on every call. */
export const publicApi = new Hono<AuthContext>()
  .use("*", rateLimit({ keyBy: "ip", limitPerSecond: 10, windowSecs: 60 }))
  .use("*", auth.requireRole("*"))
  .use("*", async (c, next) => { c.header("Cache-Control", "no-store"); c.header("Referrer-Policy", "no-referrer"); await next(); })
  .onError((error, c) => {
    const known = error instanceof FilesError;
    const code = known ? error.code : error instanceof FilegateError && error.code === "cursor_invalid" ? "cursor_invalid" : error instanceof FilegateError && error.status === 404 ? "not_found" : "unavailable";
    return respond(c, { ok: false, error: errorMessage(code, getLocale(c)), status: known ? error.status : code === "cursor_invalid" ? 409 : code === "not_found" ? 404 : 503, code });
  })
  .post("/:kind/:token/api/unlock", rateLimit({ keyBy: "ip", limitPerSecond: 5, windowSecs: 60 }), bodyLimit({ maxSize: 2048 }), v("json", z.object({ password: z.string().min(1).max(256) }).strict()), async (c) => {
    const kind = c.req.param("kind") === "s" ? "download" : c.req.param("kind") === "inbox" ? "inbox" : null;
    if (!kind) throw new FilesError("not_found", 404);
    const token = c.req.param("token") ?? "";
    const access = await filesService.unlockShare(token, kind, c.req.valid("json").password);
    setShareAccessCookie(c, kind, token, access);
    return respond(c, ok({ unlocked: true }));
  })
  .get("/s/:token/api", v("query", PublicBrowseQuerySchema), async (c) => respond(c, ok(await filesService.publicShare((c.req.param("token") ?? ""), "download", c.req.valid("query"), shareAccessCookie(c)))))
  .post("/s/:token/api/download", v("json", EntryQuerySchema), async (c) =>
    respond(c, ok(await filesService.publicShareDownload((c.req.param("token") ?? ""), c.req.valid("json").path, shareAccessCookie(c)))),
  )
  .post("/s/:token/api/archive", async (c) => respond(c, ok(await filesService.publicShareArchive((c.req.param("token") ?? ""), shareAccessCookie(c)))))
  .get("/inbox/:token/api", v("query", PublicBrowseQuerySchema), async (c) => respond(c, ok(await filesService.publicShare((c.req.param("token") ?? ""), "inbox", c.req.valid("query"), shareAccessCookie(c)))))
  .post("/inbox/:token/api/uploads", v("json", PublicUploadInputSchema), async (c) =>
    respond(c, ok(await filesService.publicInboxUpload((c.req.param("token") ?? ""), c.req.valid("json"), shareAccessCookie(c)))),
  )
  .post("/inbox/:token/api/uploads/:id/lease", v("param", UploadIdSchema.extend({ token: UploadIdSchema.shape.id })), async (c) =>
    respond(c, ok(await filesService.publicInboxLease((c.req.param("token") ?? ""), c.req.valid("param").id, shareAccessCookie(c)))),
  )
  .post("/inbox/:token/api/uploads/:id/commit", v("param", UploadIdSchema.extend({ token: UploadIdSchema.shape.id })), async (c) =>
    respond(c, ok(await filesService.publicInboxCommit((c.req.param("token") ?? ""), c.req.valid("param").id, shareAccessCookie(c)))),
  )
  .post("/inbox/:token/api/uploads/:id/abort", v("param", UploadIdSchema.extend({ token: UploadIdSchema.shape.id })), async (c) => {
    await filesService.publicInboxAbort((c.req.param("token") ?? ""), c.req.valid("param").id, shareAccessCookie(c));
    return respond(c, ok({ aborted: true }));
  });
export type PublicApiType = typeof publicApi;
