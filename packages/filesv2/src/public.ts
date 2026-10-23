import {
  type AuthContext,
  auth,
  getLocale,
  middleware,
  REQUEST_IDLE_TIMEOUT_MAX_SECONDS,
  REQUEST_IDLE_TIMEOUT_SECONDS,
  rateLimit,
  respond,
  setRequestTimeout,
  v,
} from "@k2b/cloud/server";
import { FilegateError } from "@k2b/filegate";
import { ok } from "@k2b/stdlib";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { publicErrorMessage } from "./api/messages";
import { EntryQuerySchema, PublicBrowseQuerySchema, PublicUploadInputSchema, UploadIdSchema } from "./contracts";
import { publicUploadPath, publicUploadRateLimit } from "./public-upload-rate-limit";
import { FilesError, filesService } from "./service";
import { shareAccessContext } from "./service/share-access-context";
import { setShareAccessCookie, shareAccessCookie } from "./share-access-cookie";

/** Public routes re-resolve the share and enforce its optional password on every call. */
export const publicApi = new Hono<AuthContext>()
  // A share's public note sits next to file names that writers of the shared folder choose without holding the link.
  .use("*", middleware.noTransform())
  .use(
    "*",
    rateLimit({
      keyBy: "ip",
      limitPerSecond: 10,
      windowSecs: 60,
      routes: [{ method: "POST", path: publicUploadPath, disabled: true }],
    }),
  )
  .use("*", publicUploadRateLimit)
  .use("*", auth.requireRole("*"))
  .use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    c.header("Referrer-Policy", "no-referrer");
    await next();
  })
  .onError((error, c) => {
    const known = error instanceof FilesError;
    const code = known
      ? error.code
      : error instanceof FilegateError && error.code === "cursor_invalid"
        ? "cursor_invalid"
        : error instanceof FilegateError && error.status === 404
          ? "not_found"
          : "unavailable";
    return respond(c, {
      ok: false,
      error: publicErrorMessage(code, getLocale(c)),
      status: known ? error.status : code === "cursor_invalid" ? 409 : code === "not_found" ? 404 : 503,
      code,
    });
  })
  .post(
    "/:kind/:token/api/unlock",
    rateLimit({ keyBy: "ip", limitPerSecond: 5, windowSecs: 60 }),
    bodyLimit({ maxSize: 2048 }),
    v("json", z.object({ password: z.string().min(1).max(256) }).strict()),
    async (c) => {
      const kind = c.req.param("kind") === "s" ? "download" : c.req.param("kind") === "inbox" ? "inbox" : null;
      if (!kind) throw new FilesError("not_found", 404);
      const token = c.req.param("token") ?? "";
      const access = await filesService.unlockShare(token, kind, c.req.valid("json").password, shareAccessContext(c));
      setShareAccessCookie(c, kind, token, access);
      return respond(c, ok({ unlocked: true }));
    },
  )
  .get("/s/:token/api", v("query", PublicBrowseQuerySchema), async (c) =>
    respond(
      c,
      ok(
        await filesService.publicShare(
          c.req.param("token") ?? "",
          "download",
          c.req.valid("query"),
          shareAccessCookie(c),
          shareAccessContext(c),
        ),
      ),
    ),
  )
  .post("/s/:token/api/download", v("json", EntryQuerySchema), async (c) =>
    respond(
      c,
      ok(
        await filesService.publicShareDownload(
          c.req.param("token") ?? "",
          c.req.valid("json").path,
          shareAccessCookie(c),
          shareAccessContext(c),
        ),
      ),
    ),
  )
  .post("/s/:token/api/archive", async (c) =>
    respond(c, ok(await filesService.publicShareArchive(c.req.param("token") ?? "", shareAccessCookie(c), shareAccessContext(c)))),
  )
  .get("/inbox/:token/api", v("query", PublicBrowseQuerySchema), async (c) =>
    respond(
      c,
      ok(
        await filesService.publicShare(
          c.req.param("token") ?? "",
          "inbox",
          c.req.valid("query"),
          shareAccessCookie(c),
          shareAccessContext(c),
        ),
      ),
    ),
  )
  .post("/inbox/:token/api/uploads", v("json", PublicUploadInputSchema), async (c) =>
    respond(
      c,
      ok(
        await filesService.publicInboxUpload(
          c.req.param("token") ?? "",
          c.req.valid("json"),
          shareAccessCookie(c),
          c.req.header("x-request-id")?.slice(0, 64) ?? null,
        ),
      ),
    ),
  )
  .post("/inbox/:token/api/uploads/:id/lease", v("param", UploadIdSchema.extend({ token: UploadIdSchema.shape.id })), async (c) =>
    respond(c, ok(await filesService.publicInboxLease(c.req.param("token") ?? "", c.req.valid("param").id, shareAccessCookie(c)))),
  )
  .post("/inbox/:token/api/uploads/:id/commit", v("param", UploadIdSchema.extend({ token: UploadIdSchema.shape.id })), async (c) => {
    setRequestTimeout(c, REQUEST_IDLE_TIMEOUT_MAX_SECONDS);
    try {
      return respond(
        c,
        ok(await filesService.publicInboxCommit(c.req.param("token") ?? "", c.req.valid("param").id, shareAccessCookie(c))),
      );
    } finally {
      setRequestTimeout(c, REQUEST_IDLE_TIMEOUT_SECONDS);
    }
  })
  .post("/inbox/:token/api/uploads/:id/abort", v("param", UploadIdSchema.extend({ token: UploadIdSchema.shape.id })), async (c) => {
    await filesService.publicInboxAbort(c.req.param("token") ?? "", c.req.valid("param").id, shareAccessCookie(c));
    return respond(c, ok({ aborted: true }));
  });
export type PublicApiType = typeof publicApi;
