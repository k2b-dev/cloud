import {
  type AuthContext,
  auth,
  getLocale,
  jsonResponse,
  middleware,
  REQUEST_IDLE_TIMEOUT_MAX_SECONDS,
  REQUEST_IDLE_TIMEOUT_SECONDS,
  rateLimit,
  requiresAdmin,
  requiresAuth,
  respond,
  setRequestTimeout,
  v,
} from "@k2b/cloud/server";
import { logger } from "@k2b/cloud/services";
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
  CopyInputSchema,
  CreateDocumentInputSchema,
  CreateShareInputSchema,
  DeleteDirectorySchema,
  DirectoryIdentitySchema,
  DirectoryInputSchema,
  DirectoryTargetSchema,
  DownloadInputSchema,
  EntryIdSchema,
  EntryQuerySchema,
  ErrorSchema,
  FavoriteInputSchema,
  FolderBatchInputSchema,
  MoveInputSchema,
  PathsInputSchema,
  RenameInputSchema,
  RootActionSchema,
  SearchQuerySchema,
  ShareIdSchema,
  SharePageQuerySchema,
  ThumbnailInputSchema,
  TrashIdSchema,
  UploadIdSchema,
  UploadInputSchema,
  VersionCommentSchema,
  VersionRefSchema,
  VersionRestoreAsSchema,
  VersionRestoreSchema,
} from "../contracts";
import { isMarkdown } from "../document-assets";
import { requestCall } from "../files-call";
import { FilesError, filesService } from "../service";
import { activityApi } from "./activity";
import { createActivityActionsApi } from "./activity-actions";
import { apiError, describeError } from "./api-error";
import { inlinePdfApi } from "./inline-pdf";
import { errorMessage } from "./messages";
import { templateApi } from "./templates";
import { wopiApi } from "./wopi";

const log = logger("filesv2:api");
const api = new Hono<AuthContext>()
  .use("/admin/shares", middleware.noTransform())
  .use("/admin/shares/*", middleware.noTransform())
  .use("/bases/:baseId/editor", middleware.noTransform())
  .use("/bases/:baseId/editor/*", middleware.noTransform())
  .use("/bases/:baseId/shares", middleware.noTransform())
  .use("/bases/:baseId/shares/*", middleware.noTransform())
  // Collabora reaches these routes with an editor token instead of a session; they must answer before the role check.
  .route("/wopi", wopiApi)
  .use(rateLimit())
  .use("*", auth.requireRole("user"))
  .onError((error, c) => {
    const { code, status } = apiError(error);
    if (status >= 500)
      log.error("Files request failed", { code, status, method: c.req.method, path: c.req.path, error: describeError(error) });
    return respond(c, { ok: false, error: errorMessage(code, getLocale(c)), status, code });
  })
  .route("/", activityApi)
  .route("/templates", templateApi)
  .route("/", inlinePdfApi)
  .route(
    "/",
    createActivityActionsApi({
      recovery: filesService.activityRecovery,
      restore: filesService.restoreActivity,
      moveBack: filesService.moveActivityBack,
      recheck: filesService.recheckActivity,
    }),
  )
  .post(
    "/bases/:baseId/markdown",
    middleware.openapi({ summary: "Create an empty Markdown document", ...requiresAuth }),
    v("json", DirectoryInputSchema),
    async (c) => {
      const input = c.req.valid("json");
      if (!isMarkdown(input.path)) throw new FilesError("editor_unsupported", 400);
      return respond(
        c,
        ok(await filesService.createFromBytes(requestCall(c), { baseId: c.req.param("baseId") ?? "", path: input.path }, new Uint8Array())),
      );
    },
  )
  .get("/bases", middleware.openapi({ summary: "List accessible file bases", ...requiresAuth }), async (c) =>
    respond(c, ok(await filesService.bases(requestCall(c)))),
  )
  .get(
    "/bases/:baseId/entries",
    middleware.openapi({ summary: "List current filesystem entries", ...requiresAuth }),
    v("query", BrowseQuerySchema),
    async (c) => respond(c, ok(await filesService.list(requestCall(c), { baseId: c.req.param("baseId") ?? "", ...c.req.valid("query") }))),
  )
  .post(
    "/bases/:baseId/download",
    auth.readOnly,
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
      respond(c, ok(await filesService.download(requestCall(c), { baseId: c.req.param("baseId") ?? "", ...c.req.valid("json") }))),
  )
  .get("/recent", middleware.openapi({ summary: "Recently opened entries of the user", ...requiresAuth }), async (c) =>
    respond(c, ok(await filesService.recent(requestCall(c)))),
  )
  .get("/favorites", middleware.openapi({ summary: "Favorite entries of the user", ...requiresAuth }), async (c) =>
    respond(c, ok(await filesService.favorites(requestCall(c)))),
  )
  .post(
    "/bases/:baseId/favorite",
    middleware.openapi({ summary: "Mark or unmark an entry as favorite", ...requiresAuth }),
    v("json", FavoriteInputSchema),
    async (c) =>
      respond(c, ok(await filesService.setFavorite(requestCall(c), { baseId: c.req.param("baseId") ?? "", ...c.req.valid("json") }))),
  )
  .get(
    "/bases/:baseId/entry",
    middleware.openapi({ summary: "Read authorized current file or folder metadata", ...requiresAuth }),
    v("query", EntryQuerySchema),
    async (c) => respond(c, ok(await filesService.entry(requestCall(c), { baseId: c.req.param("baseId") ?? "", ...c.req.valid("query") }))),
  )
  .get(
    "/entries/:id",
    middleware.openapi({ summary: "Read an authorized file or folder by its file ID", ...requiresAuth }),
    v("param", EntryIdSchema),
    async (c) => respond(c, ok(await filesService.entryById(requestCall(c), c.req.valid("param").id))),
  )
  .get(
    "/bases/:baseId/search",
    middleware.openapi({ summary: "Search names below an authorized folder", ...requiresAuth }),
    v("query", SearchQuerySchema),
    async (c) =>
      respond(c, ok(await filesService.search(requestCall(c), { baseId: c.req.param("baseId") ?? "", ...c.req.valid("query") }))),
  )
  .post(
    "/bases/:baseId/directories",
    middleware.openapi({ summary: "Create a folder", ...requiresAuth }),
    v("json", DirectoryInputSchema),
    async (c) => respond(c, ok(await filesService.mkdir(requestCall(c), { baseId: c.req.param("baseId") ?? "", ...c.req.valid("json") }))),
  )
  .post(
    "/bases/:baseId/directories/batch",
    middleware.openapi({ summary: "Create several folders in one request, reusing existing ones; dryRun only checks", ...requiresAuth }),
    v("json", FolderBatchInputSchema),
    async (c) => {
      const result = await filesService.mkdirs(requestCall(c), { baseId: c.req.param("baseId") ?? "", ...c.req.valid("json") });
      return respond(
        c,
        ok({
          ...result,
          results: result.results.map((item) =>
            item.state === "failed" && item.error ? { ...item, message: errorMessage(item.error, getLocale(c)) } : item,
          ),
        }),
      );
    },
  )
  .post(
    "/bases/:baseId/documents",
    middleware.openapi({ summary: "Create an empty office document from a template", ...requiresAuth }),
    v("json", CreateDocumentInputSchema),
    async (c) =>
      respond(c, ok(await filesService.createDocument(requestCall(c), { baseId: c.req.param("baseId") ?? "", ...c.req.valid("json") }))),
  )
  .post(
    "/bases/:baseId/editor",
    middleware.openapi({ summary: "Prepare a Collabora editor session for one file", ...requiresAuth }),
    v("json", EntryQuerySchema),
    async (c) => respond(c, ok(await filesService.editor(requestCall(c), { baseId: c.req.param("baseId") ?? "", ...c.req.valid("json") }))),
  )
  .post(
    "/bases/:baseId/uploads",
    middleware.openapi({ summary: "Open a direct upload session", ...requiresAuth }),
    v("json", UploadInputSchema),
    async (c) => respond(c, ok(await filesService.upload(requestCall(c), { baseId: c.req.param("baseId") ?? "", ...c.req.valid("json") }))),
  )
  .post(
    "/bases/:baseId/uploads/:id/lease",
    middleware.openapi({ summary: "Renew the lease of an open upload session", ...requiresAuth }),
    v("param", UploadIdSchema.extend({ baseId: z.string() })),
    async (c) => respond(c, ok(await filesService.uploadLease(requestCall(c), c.req.valid("param")))),
  )
  .post(
    "/bases/:baseId/uploads/:id/commit",
    middleware.openapi({ summary: "Publish a fully transferred upload session", ...requiresAuth }),
    v("param", UploadIdSchema.extend({ baseId: z.string() })),
    async (c) => {
      setRequestTimeout(c, REQUEST_IDLE_TIMEOUT_MAX_SECONDS);
      try {
        return respond(c, ok(await filesService.commitUpload(requestCall(c), c.req.valid("param"))));
      } finally {
        setRequestTimeout(c, REQUEST_IDLE_TIMEOUT_SECONDS);
      }
    },
  )
  .post(
    "/bases/:baseId/uploads/:id/abort",
    middleware.openapi({ summary: "Abort an upload session", ...requiresAuth }),
    v("param", UploadIdSchema.extend({ baseId: z.string() })),
    async (c) => {
      await filesService.abortUpload(requestCall(c), c.req.valid("param"));
      return respond(c, ok({ aborted: true }));
    },
  )
  .post(
    "/bases/:baseId/rename",
    middleware.openapi({ summary: "Rename a file or folder", ...requiresAuth }),
    v("json", RenameInputSchema),
    async (c) => respond(c, ok(await filesService.rename(requestCall(c), { baseId: c.req.param("baseId") ?? "", ...c.req.valid("json") }))),
  )
  .post(
    "/bases/:baseId/move",
    middleware.openapi({ summary: "Move entries within the same base", ...requiresAuth }),
    v("json", MoveInputSchema),
    async (c) => respond(c, ok(await filesService.move(requestCall(c), { baseId: c.req.param("baseId") ?? "", ...c.req.valid("json") }))),
  )
  .post(
    "/bases/:baseId/copy",
    middleware.openapi({ summary: "Copy entries within or across bases", ...requiresAuth }),
    v("json", CopyInputSchema),
    async (c) => respond(c, ok(await filesService.copy(requestCall(c), { baseId: c.req.param("baseId") ?? "", ...c.req.valid("json") }))),
  )
  .post(
    "/bases/:baseId/delete",
    middleware.openapi({ summary: "Move entries to the trash", ...requiresAuth }),
    v("json", PathsInputSchema),
    async (c) => respond(c, ok(await filesService.remove(requestCall(c), { baseId: c.req.param("baseId") ?? "", ...c.req.valid("json") }))),
  )
  .get(
    "/bases/:baseId/trash",
    middleware.openapi({ summary: "List trashed entries", ...requiresAuth }),
    v("query", z.object({ after: z.string().max(16384).optional() })),
    async (c) => respond(c, ok(await filesService.trash(requestCall(c), { baseId: c.req.param("baseId") ?? "", ...c.req.valid("query") }))),
  )
  .post(
    "/bases/:baseId/trash/:id/restore",
    middleware.openapi({ summary: "Restore a trashed entry to its original path", ...requiresAuth }),
    v("param", TrashIdSchema.extend({ baseId: z.string() })),
    v("query", z.object({ path: z.string().min(1).max(4096).optional() })),
    async (c) =>
      respond(
        c,
        ok(
          await filesService.restoreTrash(
            { ...requestCall(c), requestAbort: c.req.raw.signal },
            { ...c.req.valid("param"), ...c.req.valid("query") },
          ),
        ),
      ),
  )
  .post(
    "/bases/:baseId/archive",
    auth.readOnly,
    middleware.openapi({ summary: "Issue a direct ZIP download lease for a selection", ...requiresAuth }),
    v("json", PathsInputSchema),
    async (c) => respond(c, ok(await filesService.bundle(requestCall(c), { baseId: c.req.param("baseId") ?? "", ...c.req.valid("json") }))),
  )
  .get(
    "/bases/:baseId/versions",
    middleware.openapi({ summary: "List versions of a file", ...requiresAuth }),
    v("query", EntryQuerySchema),
    async (c) =>
      respond(c, ok(await filesService.versions(requestCall(c), { baseId: c.req.param("baseId") ?? "", ...c.req.valid("query") }))),
  )
  .post(
    "/bases/:baseId/versions/comment",
    middleware.openapi({ summary: "Comment a version", ...requiresAuth }),
    v("json", VersionCommentSchema),
    async (c) =>
      respond(c, ok(await filesService.commentVersion(requestCall(c), { baseId: c.req.param("baseId") ?? "", ...c.req.valid("json") }))),
  )
  .post(
    "/bases/:baseId/versions/restore",
    middleware.openapi({ summary: "Restore a version in place", ...requiresAuth }),
    v("json", VersionRestoreSchema),
    async (c) =>
      respond(c, ok(await filesService.restoreVersion(requestCall(c), { baseId: c.req.param("baseId") ?? "", ...c.req.valid("json") }))),
  )
  .post(
    "/bases/:baseId/versions/restore-as",
    middleware.openapi({ summary: "Restore a version as a new file", ...requiresAuth }),
    v("json", VersionRestoreAsSchema),
    async (c) =>
      respond(c, ok(await filesService.restoreVersionAs(requestCall(c), { baseId: c.req.param("baseId") ?? "", ...c.req.valid("json") }))),
  )
  .post(
    "/bases/:baseId/versions/download",
    auth.readOnly,
    middleware.openapi({ summary: "Issue a direct download lease for a version", ...requiresAuth }),
    v("json", VersionRefSchema),
    async (c) =>
      respond(c, ok(await filesService.versionDownload(requestCall(c), { baseId: c.req.param("baseId") ?? "", ...c.req.valid("json") }))),
  )
  .get(
    "/shares",
    middleware.openapi({ summary: "List own public shares, or item shares for the current creator or administrator", ...requiresAuth }),
    v("query", SharePageQuerySchema),
    async (c) => respond(c, ok(await filesService.listShares(requestCall(c), c.req.valid("query")))),
  )
  .post(
    "/bases/:baseId/shares",
    middleware.openapi({ summary: "Create a public download share or upload inbox", ...requiresAuth }),
    v("json", CreateShareInputSchema),
    async (c) =>
      respond(c, ok(await filesService.createShare(requestCall(c), { baseId: c.req.param("baseId") ?? "", ...c.req.valid("json") }))),
  )
  .post(
    "/shares/:id/revoke",
    middleware.openapi({ summary: "Revoke a public share", ...requiresAuth }),
    v("param", ShareIdSchema),
    async (c) => respond(c, ok(await filesService.revokeShare(requestCall(c), c.req.valid("param")))),
  )
  .post(
    "/bases/:baseId/thumbnail",
    auth.readOnly,
    middleware.openapi({ summary: "Issue a direct thumbnail lease", ...requiresAuth }),
    v("json", ThumbnailInputSchema),
    async (c) =>
      respond(c, ok(await filesService.thumbnail(requestCall(c), { baseId: c.req.param("baseId") ?? "", ...c.req.valid("json") }))),
  )
  .use("/admin/*", auth.requireRole("admin"))
  .get(
    "/admin/shares",
    middleware.openapi({ summary: "List all public shares as administrator", ...requiresAdmin }),
    v("query", SharePageQuerySchema),
    async (c) => respond(c, ok(await filesService.listShares(requestCall(c), { ...c.req.valid("query"), admin: true }))),
  )
  .post(
    "/admin/shares/:id/revoke",
    middleware.openapi({ summary: "Revoke any public share as administrator", ...requiresAdmin }),
    v("param", ShareIdSchema),
    async (c) => respond(c, ok(await filesService.revokeShare(requestCall(c), { ...c.req.valid("param"), admin: true }))),
  )
  .get(
    "/admin/uploads",
    middleware.openapi({ summary: "Inspect unresolved inbox upload reservations", ...requiresAdmin }),
    v("query", z.object({ after: z.string().max(256).optional() })),
    async (c) => respond(c, ok(await filesService.adminUploadReservations(requestCall(c), c.req.valid("query")))),
  )
  .get(
    "/admin/versions",
    middleware.openapi({ summary: "Read file versions as administrator", ...requiresAdmin }),
    v("query", AdminLocatorSchema),
    async (c) => respond(c, ok(await filesService.adminVersions(requestCall(c), c.req.valid("query")))),
  )
  .delete(
    "/admin/versions",
    middleware.openapi({ summary: "Permanently delete a confirmed file version", ...requiresAdmin }),
    v("json", AdminLocatorSchema.extend({ id: VersionRefSchema.shape.id, confirmPath: z.string().min(1).max(4096) })),
    async (c) => respond(c, ok(await filesService.adminDeleteVersion(requestCall(c), c.req.valid("json")))),
  )
  .get(
    "/admin",
    auth.requireRole("admin"),
    middleware.openapi({ summary: "Read configuration and filesystem inventory", ...requiresAdmin }),
    v("query", AdminQuerySchema),
    async (c) => respond(c, ok(await filesService.admin(requestCall(c), c.req.valid("query")))),
  )
  .delete("/admin/configuration", middleware.openapi({ summary: "Reset Files configuration to defaults", ...requiresAdmin }), async (c) => {
    await filesService.resetConfiguration(requestCall(c));
    return respond(c, ok({ reset: true }));
  })
  .put(
    "/admin/configuration",
    middleware.openapi({ summary: "Save Files configuration", ...requiresAdmin }),
    v("json", ConfigurationInputSchema),
    async (c) => {
      await filesService.saveConfiguration(requestCall(c), c.req.valid("json"));
      return respond(c, ok({ saved: true }));
    },
  )
  .post(
    "/admin/adopt",
    middleware.openapi({ summary: "Bind an existing directory to its current identity", ...requiresAdmin }),
    v("json", AdoptInputSchema),
    async (c) => respond(c, ok(await filesService.adopt(requestCall(c), c.req.valid("json")))),
  )
  .post(
    "/admin/directories/create",
    middleware.openapi({ summary: "Create a missing identity directory", ...requiresAdmin }),
    v("json", DirectoryIdentitySchema),
    async (c) => respond(c, ok(await filesService.provision(requestCall(c), c.req.valid("json")))),
  )
  .post(
    "/admin/directories/archive",
    middleware.openapi({ summary: "Archive a directory without overwriting", ...requiresAdmin }),
    v("json", ArchiveInputSchema),
    async (c) => respond(c, ok(await filesService.archive(requestCall(c), c.req.valid("json")))),
  )
  .post(
    "/admin/directories/retire",
    middleware.openapi({ summary: "Retire a directory binding", ...requiresAdmin }),
    v("json", DirectoryTargetSchema),
    async (c) => respond(c, ok(await filesService.retire(requestCall(c), c.req.valid("json")))),
  )
  .post(
    "/admin/directories/delete",
    middleware.openapi({ summary: "Permanently delete an explicitly confirmed directory", ...requiresAdmin }),
    v("json", DeleteDirectorySchema),
    async (c) => respond(c, ok(await filesService.deleteDirectory(requestCall(c), c.req.valid("json")))),
  )
  .get(
    "/admin/archives",
    middleware.openapi({ summary: "List archived directories", ...requiresAdmin }),
    v("query", ArchiveQuerySchema),
    async (c) => respond(c, ok(await filesService.archives(requestCall(c), c.req.valid("query")))),
  )
  .post(
    "/admin/archives/:id/restore",
    middleware.openapi({ summary: "Restore an archive to its original path", ...requiresAdmin }),
    v("param", z.object({ id: z.string().uuid() })),
    v("json", ConfirmPathSchema),
    async (c) => respond(c, ok(await filesService.restore(requestCall(c), c.req.valid("param").id, c.req.valid("json")))),
  )
  .delete(
    "/admin/archives/:id",
    middleware.openapi({ summary: "Permanently delete a confirmed archive", ...requiresAdmin }),
    v("param", z.object({ id: z.string().uuid() })),
    v("json", ConfirmPathSchema),
    async (c) => respond(c, ok(await filesService.deleteArchive(requestCall(c), c.req.valid("param").id, c.req.valid("json")))),
  )
  .get(
    "/admin/entries",
    middleware.openapi({ summary: "Browse managed directories including trash and archives", ...requiresAdmin }),
    v("query", AdminBrowseSchema),
    async (c) => respond(c, ok(await filesService.adminList(requestCall(c), c.req.valid("query")))),
  )
  .post(
    "/admin/download",
    auth.readOnly,
    middleware.openapi({ summary: "Issue an administrative single-file lease", ...requiresAdmin }),
    v("json", AdminLocatorSchema),
    async (c) => respond(c, ok(await filesService.adminDownload(requestCall(c), c.req.valid("json")))),
  )
  .delete(
    "/admin/entries",
    middleware.openapi({ summary: "Permanently delete a confirmed file or folder", ...requiresAdmin }),
    v("json", AdminDeleteSchema),
    async (c) => respond(c, ok(await filesService.adminDelete(requestCall(c), c.req.valid("json")))),
  )
  .post(
    "/admin/root/refresh",
    middleware.openapi({ summary: "Refresh statistics for the entire Filegate root", ...requiresAdmin }),
    v("json", RootActionSchema),
    async (c) => respond(c, ok(await filesService.refreshRoot(requestCall(c), c.req.valid("json").area))),
  )
  .post(
    "/admin/root/rebuild",
    middleware.openapi({ summary: "Rebuild the entire Filegate root index", ...requiresAdmin }),
    v("json", RootActionSchema),
    async (c) => respond(c, ok(await filesService.rebuildRoot(requestCall(c), c.req.valid("json").area))),
  )
  .post(
    "/admin/operations/:id/retry",
    middleware.openapi({ summary: "Retry a pending directory operation after fresh checks", ...requiresAdmin }),
    v("param", z.object({ id: z.string().uuid() })),
    async (c) => respond(c, ok(await filesService.retry(requestCall(c), c.req.valid("param").id))),
  );
export default api;
export type ApiType = typeof api;
