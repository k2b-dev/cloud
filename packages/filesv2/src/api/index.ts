import {
  type AuthContext,
  auth,
  getLocale,
  jsonResponse,
  middleware,
  rateLimit,
  requiresAdmin,
  requiresAuth,
  respond,
  v,
} from "@k2b/cloud/server";
import { AccountIdentityError } from "@k2b/cloud/services";
import { FilegateError } from "@k2b/filegate";
import { ok } from "@k2b/stdlib";
import { Hono } from "hono";
import { z } from "zod";
import {
  AdminBrowseSchema,
  AdminDeleteSchema,
  AdminLocatorSchema,
  AdminQuerySchema,
  AdoptInputSchema,
  ArchiveInputSchema,
  ArchiveQuerySchema,
  BrowseQuerySchema,
  ConfigurationInputSchema,
  ConfirmPathSchema,
  DeleteDirectorySchema,
  DirectoryIdentitySchema,
  DirectoryInputSchema,
  DirectoryTargetSchema,
  DownloadInputSchema,
  EntryQuerySchema,
  ErrorSchema,
  RootActionSchema,
  SearchQuerySchema,
  ThumbnailInputSchema,
} from "../contracts";
import { FilesError, filesService } from "../service";
import { errorMessage } from "./messages";

const api = new Hono<AuthContext>()
  .use(rateLimit())
  .use("*", auth.requireRole("user"))
  .onError((error, c) => {
    const known = error instanceof FilesError || error instanceof AccountIdentityError;
    const code = known
      ? error.code
      : error instanceof FilegateError && error.status === 404
        ? "not_found"
        : error instanceof FilegateError && error.status === 409
          ? "path_conflict"
          : "unavailable";
    const status = known ? error.status : code === "not_found" ? 404 : code === "path_conflict" ? 409 : 503;
    return respond(c, { ok: false, error: errorMessage(code, getLocale(c)), status, code });
  })
  .get("/bases", middleware.openapi({ summary: "List accessible file bases", ...requiresAuth }), async (c) =>
    respond(c, ok(await filesService.bases(c.get("actor")))),
  )
  .get(
    "/bases/:baseId/entries",
    middleware.openapi({ summary: "List current filesystem entries", ...requiresAuth }),
    v("query", BrowseQuerySchema),
    async (c) => respond(c, ok(await filesService.list(c.get("actor"), { baseId: c.req.param("baseId") ?? "", ...c.req.valid("query") }))),
  )
  .post(
    "/bases/:baseId/download",
    middleware.openapi({
      summary: "Issue a single-file download lease",
      ...requiresAuth,
      responses: {
        200: jsonResponse(z.object({ url: z.string(), method: z.literal("GET"), expires: z.string() }), "Download lease"),
        403: jsonResponse(ErrorSchema, "Denied"),
      },
    }),
    v("json", DownloadInputSchema),
    async (c) =>
      respond(c, ok(await filesService.download(c.get("actor"), { baseId: c.req.param("baseId") ?? "", ...c.req.valid("json") }))),
  )
  .get(
    "/bases/:baseId/entry",
    middleware.openapi({ summary: "Read authorized current file or folder metadata", ...requiresAuth }),
    v("query", EntryQuerySchema),
    async (c) => respond(c, ok(await filesService.entry(c.get("actor"), { baseId: c.req.param("baseId") ?? "", ...c.req.valid("query") }))),
  )
  .get(
    "/bases/:baseId/search",
    middleware.openapi({ summary: "Search names below an authorized folder", ...requiresAuth }),
    v("query", SearchQuerySchema),
    async (c) => respond(c, ok(await filesService.search(c.get("actor"), { baseId: c.req.param("baseId") ?? "", ...c.req.valid("query") }))),
  )
  .post(
    "/bases/:baseId/directories",
    middleware.openapi({ summary: "Create a folder", ...requiresAuth }),
    v("json", DirectoryInputSchema),
    async (c) => respond(c, ok(await filesService.mkdir(c.get("actor"), { baseId: c.req.param("baseId") ?? "", ...c.req.valid("json") }))),
  )
  .post(
    "/bases/:baseId/thumbnail",
    middleware.openapi({ summary: "Issue a direct thumbnail lease", ...requiresAuth }),
    v("json", ThumbnailInputSchema),
    async (c) =>
      respond(c, ok(await filesService.thumbnail(c.get("actor"), { baseId: c.req.param("baseId") ?? "", ...c.req.valid("json") }))),
  )
  .use("/admin/*", auth.requireRole("admin"))
  .get(
    "/admin",
    auth.requireRole("admin"),
    middleware.openapi({ summary: "Read configuration and filesystem inventory", ...requiresAdmin }),
    v("query", AdminQuerySchema),
    async (c) => respond(c, ok(await filesService.admin(c.get("actor"), c.req.valid("query")))),
  )
  .put(
    "/admin/configuration",
    middleware.openapi({ summary: "Save Files v2 configuration", ...requiresAdmin }),
    v("json", ConfigurationInputSchema),
    async (c) => {
      await filesService.saveConfiguration(c.get("actor"), c.req.valid("json"));
      return respond(c, ok({ saved: true }));
    },
  )
  .post(
    "/admin/adopt",
    middleware.openapi({ summary: "Bind an existing directory to its current identity", ...requiresAdmin }),
    v("json", AdoptInputSchema),
    async (c) => respond(c, ok(await filesService.adopt(c.get("actor"), c.req.valid("json")))),
  )
  .post(
    "/admin/directories/create",
    middleware.openapi({ summary: "Create a missing identity directory", ...requiresAdmin }),
    v("json", DirectoryIdentitySchema),
    async (c) => respond(c, ok(await filesService.provision(c.get("actor"), c.req.valid("json")))),
  )
  .post(
    "/admin/directories/archive",
    middleware.openapi({ summary: "Archive a directory without overwriting", ...requiresAdmin }),
    v("json", ArchiveInputSchema),
    async (c) => respond(c, ok(await filesService.archive(c.get("actor"), c.req.valid("json")))),
  )
  .post(
    "/admin/directories/retire",
    middleware.openapi({ summary: "Retire a directory binding", ...requiresAdmin }),
    v("json", DirectoryTargetSchema),
    async (c) => respond(c, ok(await filesService.retire(c.get("actor"), c.req.valid("json")))),
  )
  .post(
    "/admin/directories/delete",
    middleware.openapi({ summary: "Permanently delete an explicitly confirmed directory", ...requiresAdmin }),
    v("json", DeleteDirectorySchema),
    async (c) => respond(c, ok(await filesService.deleteDirectory(c.get("actor"), c.req.valid("json")))),
  )
  .get(
    "/admin/archives",
    middleware.openapi({ summary: "List archived directories", ...requiresAdmin }),
    v("query", ArchiveQuerySchema),
    async (c) => respond(c, ok(await filesService.archives(c.get("actor"), c.req.valid("query")))),
  )
  .post(
    "/admin/archives/:id/restore",
    middleware.openapi({ summary: "Restore an archive to its original path", ...requiresAdmin }),
    v("param", z.object({ id: z.string().uuid() })),
    v("json", ConfirmPathSchema),
    async (c) => respond(c, ok(await filesService.restore(c.get("actor"), c.req.valid("param").id, c.req.valid("json")))),
  )
  .delete(
    "/admin/archives/:id",
    middleware.openapi({ summary: "Permanently delete a confirmed archive", ...requiresAdmin }),
    v("param", z.object({ id: z.string().uuid() })),
    v("json", ConfirmPathSchema),
    async (c) => respond(c, ok(await filesService.deleteArchive(c.get("actor"), c.req.valid("param").id, c.req.valid("json")))),
  )
  .get(
    "/admin/entries",
    middleware.openapi({ summary: "Browse managed directories including trash and archives", ...requiresAdmin }),
    v("query", AdminBrowseSchema),
    async (c) => respond(c, ok(await filesService.adminList(c.get("actor"), c.req.valid("query")))),
  )
  .post(
    "/admin/download",
    middleware.openapi({ summary: "Issue an administrative single-file lease", ...requiresAdmin }),
    v("json", AdminLocatorSchema),
    async (c) => respond(c, ok(await filesService.adminDownload(c.get("actor"), c.req.valid("json")))),
  )
  .delete(
    "/admin/entries",
    middleware.openapi({ summary: "Permanently delete a confirmed file or folder", ...requiresAdmin }),
    v("json", AdminDeleteSchema),
    async (c) => respond(c, ok(await filesService.adminDelete(c.get("actor"), c.req.valid("json")))),
  )
  .post(
    "/admin/root/refresh",
    middleware.openapi({ summary: "Refresh statistics for the entire Filegate root", ...requiresAdmin }),
    v("json", RootActionSchema),
    async (c) => respond(c, ok(await filesService.refreshRoot(c.get("actor"), c.req.valid("json").area))),
  )
  .post(
    "/admin/root/rebuild",
    middleware.openapi({ summary: "Rebuild the entire Filegate root index", ...requiresAdmin }),
    v("json", RootActionSchema),
    async (c) => respond(c, ok(await filesService.rebuildRoot(c.get("actor"), c.req.valid("json").area))),
  )
  .post(
    "/admin/operations/:id/retry",
    middleware.openapi({ summary: "Retry a pending directory operation after fresh checks", ...requiresAdmin }),
    v("param", z.object({ id: z.string().uuid() })),
    async (c) => respond(c, ok(await filesService.retry(c.get("actor"), c.req.valid("param").id))),
  );
export default api;
export type ApiType = typeof api;
