import { type AuthContext, auth, getLocale, rateLimit, respond, v } from "@k2b/cloud/server";
import { FilegateError } from "@k2b/filegate";
import { ok } from "@k2b/stdlib";
import { Hono } from "hono";
import { errorMessage } from "./api/messages";
import { EntryQuerySchema, PublicBrowseQuerySchema, PublicUploadInputSchema, UploadIdSchema } from "./contracts";
import { FilesError, filesService } from "./service";

/** Token-only JSON routes behind public share pages; every call re-resolves the share. */
export const publicApi = new Hono<AuthContext>()
  .use("*", rateLimit({ keyBy: "ip", limitPerSecond: 10, windowSecs: 60 }))
  .use("*", auth.requireRole("*"))
  .onError((error, c) => {
    const known = error instanceof FilesError;
    const code = known ? error.code : error instanceof FilegateError && error.code === "cursor_invalid" ? "cursor_invalid" : error instanceof FilegateError && error.status === 404 ? "not_found" : "unavailable";
    return respond(c, { ok: false, error: errorMessage(code, getLocale(c)), status: known ? error.status : code === "cursor_invalid" ? 409 : code === "not_found" ? 404 : 503, code });
  })
  .get("/s/:token/api", v("query", PublicBrowseQuerySchema), async (c) => respond(c, ok(await filesService.publicShare((c.req.param("token") ?? ""), "download", c.req.valid("query")))))
  .post("/s/:token/api/download", v("json", EntryQuerySchema), async (c) =>
    respond(c, ok(await filesService.publicShareDownload((c.req.param("token") ?? ""), c.req.valid("json").path))),
  )
  .post("/s/:token/api/archive", async (c) => respond(c, ok(await filesService.publicShareArchive((c.req.param("token") ?? "")))))
  .get("/inbox/:token/api", v("query", PublicBrowseQuerySchema), async (c) => respond(c, ok(await filesService.publicShare((c.req.param("token") ?? ""), "inbox", c.req.valid("query")))))
  .post("/inbox/:token/api/uploads", v("json", PublicUploadInputSchema), async (c) =>
    respond(c, ok(await filesService.publicInboxUpload((c.req.param("token") ?? ""), c.req.valid("json")))),
  )
  .post("/inbox/:token/api/uploads/:id/lease", v("param", UploadIdSchema.extend({ token: UploadIdSchema.shape.id })), async (c) =>
    respond(c, ok(await filesService.publicInboxLease((c.req.param("token") ?? ""), c.req.valid("param").id))),
  )
  .post("/inbox/:token/api/uploads/:id/commit", v("param", UploadIdSchema.extend({ token: UploadIdSchema.shape.id })), async (c) =>
    respond(c, ok(await filesService.publicInboxCommit((c.req.param("token") ?? ""), c.req.valid("param").id))),
  )
  .post("/inbox/:token/api/uploads/:id/abort", v("param", UploadIdSchema.extend({ token: UploadIdSchema.shape.id })), async (c) => {
    await filesService.publicInboxAbort((c.req.param("token") ?? ""), c.req.valid("param").id);
    return respond(c, ok({ aborted: true }));
  });
export type PublicApiType = typeof publicApi;
