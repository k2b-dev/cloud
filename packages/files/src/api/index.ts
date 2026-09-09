import { err, fail, ok } from "@k2b/stdlib";
import {
  type AuthContext,
  auth,
  expectUserBackedActor,
  getLocale,
  jsonResponse,
  requiresIpaUser,
  respond,
  v,
} from "@k2b/cloud/server";
import { type Context, Hono } from "hono";
import { describeRoute } from "hono-openapi";
import {
  ChunkedUploadChunkQuerySchema,
  ChunkedUploadResponseSchema,
  ChunkedUploadStartResponseSchema,
  ChunkedUploadStartSchema,
  ChunkHeaderSchema,
  DownloadQuerySchema,
  DuplicateRequestSchema,
  ErrorResponseSchema,
  FileActionQuerySchema,
  FileBaseInfoSchema,
  FileBaseParamSchema,
  FileInfoResponseSchema,
  FileInfoSchema,
  FilePathQuerySchema,
  GlobalSearchQuerySchema,
  GlobalSearchResponseSchema,
  ListFilesQuerySchema,
  MoveTargetSearchQuerySchema,
  MoveTargetSearchResponseSchema,
  OptionalFilePathQuerySchema,
  TransferRequestSchema,
  TransferResultSchema,
  UploadHeaderSchema,
  UploadIdParamSchema,
} from "@/contracts";
import { filesService } from "../service";
import { filesApiErrorMessage } from "../service/messages";
import { signUploadTicket, verifyUploadTicket } from "../service/upload-ticket";

/**
 * Resolves the requested file base and verifies access for the current user before running file operations.
 */
const requireBaseAccess = async (c: Context<AuthContext>) => {
  const user = expectUserBackedActor(c);
  const params = FileBaseParamSchema.safeParse({
    baseType: c.req.param("baseType"),
    baseId: c.req.param("baseId"),
  });
  if (!params.success) {
    return {
      base: null,
      error: await respond(c, fail(err.badInput("Invalid file base"))),
    };
  }
  const { baseType, baseId } = params.data;

  const base = await filesService.base.get({ baseType, baseId });
  if (!base.ok) {
    return {
      base: null,
      error: await respond(c, base),
    };
  }

  const access = await filesService.base.permission.canAccess({
    user,
    base: base.data,
  });
  if (!access.ok) {
    return {
      base: null,
      error: await respond(c, access),
    };
  }

  return { base: base.data };
};

/** File management routes. Only for full IPA users. */
//
// Mounted at `/api/files`, so sub-routes become:
//   /api/files/admin/*  — settings router (admin-gated)
//   /api/files/...      — file ops (auth.requireAccount IPA user)
//
// Admin sub-router mounts BEFORE the user-auth middleware so admins (who may
// not be IPA users) can still reach it.
import { filesSettingsRouter } from "./settings";

const localizeApiError = async (c: Context, next: () => Promise<void>) => {
  await next();
  if (c.res.status < 400 || !c.res.headers.get("content-type")?.includes("application/json")) return;
  const body: unknown = await c.res
    .clone()
    .json()
    .catch(() => null);
  if (!body || typeof body !== "object" || !("message" in body) || typeof body.message !== "string") return;
  const message = filesApiErrorMessage(c.res.status, getLocale(c), body.message);
  const errors =
    "errors" in body && body.errors && typeof body.errors === "object"
      ? Object.fromEntries(Object.keys(body.errors).map((key) => [key, message]))
      : undefined;
  const headers = new Headers(c.res.headers);
  headers.delete("content-length");
  c.res = new Response(JSON.stringify({ ...body, message, ...(errors ? { errors } : {}) }), {
    status: c.res.status,
    statusText: c.res.statusText,
    headers,
  });
};

const app = new Hono<AuthContext>()
  .use(localizeApiError)
  .route("/admin/settings", filesSettingsRouter)
  .use(auth.requireAccount({ provider: "ipa", profile: "user" }))

  // Get current user's home directory info
  .get(
    "/home",
    describeRoute({
      tags: ["Files"],
      summary: "Get home directory info",
      description: "Returns info about the current user's home directory. Requires a POSIX UID.",
      ...requiresIpaUser,
      responses: {
        200: jsonResponse(FileBaseInfoSchema, "Home directory info"),
        401: jsonResponse(ErrorResponseSchema, "Authentication required"),
        404: jsonResponse(ErrorResponseSchema, "No home directory (user has no uidNumber)"),
      },
    }),
    async (c) => {
      const user = expectUserBackedActor(c);

      // User needs uidNumber for home directory
      if (!user.ipa?.uidNumber) {
        return respond(c, fail(err.notFound("No home directory (missing uidNumber)")));
      }

      return respond(
        c,
        ok({
          type: "home" as const,
          id: user.uid,
          name: `Home (${user.displayName})`,
        }),
      );
    },
  )

  // List accessible file bases (home + groups)
  .get(
    "/bases",
    describeRoute({
      tags: ["Files"],
      summary: "List accessible file bases",
      description: "Returns list of file bases the user can access (home directory + group directories).",
      ...requiresIpaUser,
      responses: {
        200: jsonResponse(FileBaseInfoSchema.array(), "List of accessible bases"),
        401: jsonResponse(ErrorResponseSchema, "Authentication required"),
      },
    }),
    async (c) => {
      const user = expectUserBackedActor(c);
      const bases = await filesService.base.list({ user });
      return respond(c, ok(bases.items));
    },
  )

  // Global search across all accessible bases
  .get(
    "/search",
    describeRoute({
      tags: ["Files"],
      summary: "Search files globally",
      description:
        "Search for files across all accessible bases (or specific bases if provided). " +
        "Uses glob patterns for matching (e.g. '**/*.pdf', '*.{jpg,png}').",
      ...requiresIpaUser,
      responses: {
        200: jsonResponse(GlobalSearchResponseSchema, "Search results grouped by base"),
        400: jsonResponse(ErrorResponseSchema, "Invalid request"),
        401: jsonResponse(ErrorResponseSchema, "Authentication required"),
      },
    }),
    v("query", GlobalSearchQuerySchema),
    async (c) => {
      const user = expectUserBackedActor(c);
      const { pattern, showHidden, limit, bases: basesParam } = c.req.valid("query");

      const result = await filesService.search.global({
        user,
        bases: basesParam,
        pattern,
        showHidden,
        limit,
      });

      return respond(c, result);
    },
  )

  // Get file/directory info (unified endpoint)
  .get(
    "/:baseType/:baseId",
    describeRoute({
      tags: ["Files"],
      summary: "Get file or directory info",
      description:
        "Returns info about a file or directory. For directories, includes a listing of contents. " +
        "For files, returns only metadata (use /content endpoint to download).",
      ...requiresIpaUser,
      responses: {
        200: jsonResponse(FileInfoResponseSchema, "File info or directory listing"),
        400: jsonResponse(ErrorResponseSchema, "Invalid request"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Not found"),
      },
    }),
    v("param", FileBaseParamSchema),
    v("query", ListFilesQuerySchema),
    async (c) => {
      const query = c.req.valid("query");

      const { base, error } = await requireBaseAccess(c);
      if (error || !base) return error!;

      const result = await filesService.item.get({
        base,
        path: query.path,
        showHidden: query.showHidden,
      });

      return respond(c, result);
    },
  )

  // Download file content
  .get(
    "/:baseType/:baseId/content",
    describeRoute({
      tags: ["Files"],
      summary: "Download file",
      description: "Download the content of a file. Use inline=true for browser preview (Content-Disposition: inline).",
      ...requiresIpaUser,
      responses: {
        200: { description: "File content stream" },
        400: jsonResponse(ErrorResponseSchema, "Invalid request or path is a directory"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "File not found"),
      },
    }),
    v("param", FileBaseParamSchema),
    v("query", DownloadQuerySchema),
    async (c) => {
      const { path, inline } = c.req.valid("query");

      const { base, error } = await requireBaseAccess(c);
      if (error || !base) return error!;

      const result = await filesService.item.download({ base, path, inline });
      if (!result.ok) return respond(c, result);

      const disposition = result.data.inline ? "inline" : "attachment";
      return new Response(result.data.stream, {
        headers: {
          "Content-Type": result.data.contentType,
          "Content-Disposition": `${disposition}; filename="${encodeURIComponent(result.data.filename)}"`,
          "Content-Length": String(result.data.size),
        },
      });
    },
  )

  // Get image thumbnail
  .get(
    "/:baseType/:baseId/thumbnail",
    describeRoute({
      tags: ["Files"],
      summary: "Get image thumbnail",
      description: "Generate a thumbnail for an image file. Returns 200x200 WebP with preserved aspect ratio.",
      ...requiresIpaUser,
      responses: {
        200: { description: "Thumbnail image (WebP)" },
        400: jsonResponse(ErrorResponseSchema, "Not an image or unsupported format"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "File not found"),
      },
    }),
    v("param", FileBaseParamSchema),
    v("query", FilePathQuerySchema),
    async (c) => {
      const { path } = c.req.valid("query");

      const { base, error } = await requireBaseAccess(c);
      if (error || !base) return error!;

      const result = await filesService.item.thumbnail({ base, path });
      if (!result.ok) return respond(c, result);

      return result.data.response;
    },
  )

  // Upload file
  .put(
    "/:baseType/:baseId/content",
    describeRoute({
      tags: ["Files"],
      summary: "Upload file",
      description: "Upload a file to the specified path. The filename is taken from the X-File-Name header.",
      ...requiresIpaUser,
      responses: {
        201: jsonResponse(FileInfoSchema, "File uploaded successfully"),
        400: jsonResponse(ErrorResponseSchema, "Invalid request"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
      },
    }),
    v("param", FileBaseParamSchema),
    v("query", OptionalFilePathQuerySchema),
    v("header", UploadHeaderSchema),
    async (c) => {
      const { path } = c.req.valid("query");
      const filename = c.req.valid("header")["x-file-name"];

      const { base, error } = await requireBaseAccess(c);
      if (error || !base) return error!;

      const body = await c.req.arrayBuffer();
      const result = await filesService.item.upload({
        base,
        path,
        content: body,
        filename,
      });

      return respond(c, result, 201);
    },
  )

  // File actions: mkdir, move, copy
  .post(
    "/:baseType/:baseId",
    describeRoute({
      tags: ["Files"],
      summary: "Perform file action",
      description: "Create directory, move, or copy files. Use query params: action (mkdir|move|copy), path, to (for move/copy).",
      ...requiresIpaUser,
      responses: {
        200: jsonResponse(FileInfoSchema, "Action completed successfully"),
        400: jsonResponse(ErrorResponseSchema, "Invalid request"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Source not found"),
      },
    }),
    v("param", FileBaseParamSchema),
    v("query", FileActionQuerySchema),
    async (c) => {
      const { action, path, to } = c.req.valid("query");

      const { base, error } = await requireBaseAccess(c);
      if (error || !base) return error!;

      switch (action) {
        case "mkdir":
          return respond(c, await filesService.item.createDirectory({ base, path }));
        case "move":
          if (!to) return respond(c, fail(err.badInput("Missing 'to' parameter for move action")));
          return respond(c, await filesService.item.move({ base, from: path, to }));
        case "copy":
          if (!to) return respond(c, fail(err.badInput("Missing 'to' parameter for copy action")));
          return respond(c, await filesService.item.copy({ base, from: path, to }));
      }
    },
  )

  // Delete file or directory
  .delete(
    "/:baseType/:baseId",
    describeRoute({
      tags: ["Files"],
      summary: "Delete file or directory",
      description: "Delete a file or directory (recursive for directories).",
      ...requiresIpaUser,
      responses: {
        204: { description: "Successfully deleted" },
        400: jsonResponse(ErrorResponseSchema, "Invalid request"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Not found"),
      },
    }),
    v("param", FileBaseParamSchema),
    v("query", FilePathQuerySchema),
    async (c) => {
      const { path } = c.req.valid("query");

      const { base, error } = await requireBaseAccess(c);
      if (error || !base) return error!;

      const result = await filesService.item.remove({ base, path });
      if (!result.ok) return respond(c, result);

      return c.body(null, 204);
    },
  )

  // ==========================================================================
  // Move/Copy Endpoints
  // ==========================================================================

  // Search directories for move/copy target
  .get(
    "/:baseType/:baseId/directories",
    describeRoute({
      tags: ["Files"],
      summary: "Search directories for move target",
      description: "Search for directories within a base to use as move/copy destination.",
      ...requiresIpaUser,
      responses: {
        200: jsonResponse(MoveTargetSearchResponseSchema, "Directory search results"),
        400: jsonResponse(ErrorResponseSchema, "Invalid request"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
      },
    }),
    v("param", FileBaseParamSchema),
    v("query", MoveTargetSearchQuerySchema),
    async (c) => {
      const user = expectUserBackedActor(c);
      const { query, targetBaseType, targetBaseId, limit } = c.req.valid("query");

      // Parse and verify access to target base
      const targetBase = await filesService.base.get({
        baseType: targetBaseType,
        baseId: targetBaseId,
      });
      if (!targetBase.ok) return respond(c, targetBase);

      const access = await filesService.base.permission.canAccess({
        user,
        base: targetBase.data,
      });
      if (!access.ok) return respond(c, access);

      const result = await filesService.item.searchDirectories({
        base: targetBase.data,
        query,
        limit,
      });

      return respond(c, result);
    },
  )

  // Transfer (move/copy) files
  .post(
    "/:baseType/:baseId/transfer",
    describeRoute({
      tags: ["Files"],
      summary: "Move or copy files",
      description:
        "Transfer files to another location. Same-base transfers use move (preserves permissions), " +
        "cross-base transfers use copy (adjusts permissions for destination).",
      ...requiresIpaUser,
      responses: {
        200: jsonResponse(TransferResultSchema, "Transfer completed"),
        400: jsonResponse(ErrorResponseSchema, "Invalid request"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
      },
    }),
    v("param", FileBaseParamSchema),
    v("json", TransferRequestSchema),
    async (c) => {
      const user = expectUserBackedActor(c);
      const { baseType: sourceBaseType, baseId: sourceBaseId } = c.req.valid("param");
      const { paths: sourcePaths, targetBaseType, targetBaseId, targetPath } = c.req.valid("json");

      // Parse and verify access to source base
      const sourceBase = await filesService.base.get({
        baseType: sourceBaseType,
        baseId: sourceBaseId,
      });
      if (!sourceBase.ok) return respond(c, sourceBase);

      const sourceAccess = await filesService.base.permission.canAccess({
        user,
        base: sourceBase.data,
      });
      if (!sourceAccess.ok) return respond(c, sourceAccess);

      // Parse and verify access to target base
      const targetBase = await filesService.base.get({
        baseType: targetBaseType,
        baseId: targetBaseId,
      });
      if (!targetBase.ok) return respond(c, targetBase);

      const targetAccess = await filesService.base.permission.canAccess({
        user,
        base: targetBase.data,
      });
      if (!targetAccess.ok) return respond(c, targetAccess);

      const result = await filesService.transfer.execute({
        sourceBase: sourceBase.data,
        targetBase: targetBase.data,
        sourcePaths,
        targetPath,
      });

      return respond(c, result);
    },
  )

  // Duplicate file or folder
  .post(
    "/:baseType/:baseId/duplicate",
    describeRoute({
      tags: ["Files"],
      summary: "Duplicate file or folder",
      description: "Create a copy of a file or folder in the same directory with a new name.",
      ...requiresIpaUser,
      responses: {
        200: jsonResponse(FileInfoSchema, "Duplicate created"),
        400: jsonResponse(ErrorResponseSchema, "Invalid request"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Source not found"),
      },
    }),
    v("param", FileBaseParamSchema),
    v("json", DuplicateRequestSchema),
    async (c) => {
      const { path, newName } = c.req.valid("json");

      const { base, error } = await requireBaseAccess(c);
      if (error || !base) return error!;

      const result = await filesService.item.duplicate({
        base,
        path,
        newName,
      });

      return respond(c, result);
    },
  )

  // ==========================================================================
  // Chunked Upload Endpoints
  // ==========================================================================

  // Start chunked upload
  .post(
    "/:baseType/:baseId/upload",
    describeRoute({
      tags: ["Files"],
      summary: "Start chunked upload",
      description:
        "Initialize a chunked upload session. Returns an uploadId for subsequent chunk uploads. " +
        "The checksum must be the SHA-256 hash of the entire file in format 'sha256:<64 hex chars>'.",
      ...requiresIpaUser,
      responses: {
        200: jsonResponse(ChunkedUploadStartResponseSchema, "Upload session started"),
        400: jsonResponse(ErrorResponseSchema, "Invalid request"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
      },
    }),
    v("param", FileBaseParamSchema),
    v("query", OptionalFilePathQuerySchema),
    v("json", ChunkedUploadStartSchema),
    async (c) => {
      const { path } = c.req.valid("query");
      const { baseType, baseId } = c.req.valid("param");
      const body = c.req.valid("json");

      const { base, error } = await requireBaseAccess(c);
      if (error || !base) return error!;

      const result = await filesService.upload.start({
        base,
        path,
        filename: body.filename,
        size: body.size,
        checksum: body.checksum,
        chunkSize: body.chunkSize,
      });
      if (!result.ok) return respond(c, result);

      // The base is authorized here and nowhere else in the chunk loop, so the
      // ticket is issued now and re-checked on every chunk.
      return respond(c, {
        ok: true,
        data: {
          ...result.data,
          uploadTicket: signUploadTicket({ uploadId: result.data.uploadId, baseType, baseId }),
        },
      });
    },
  )

  // Upload chunk
  .put(
    "/:baseType/:baseId/upload/:uploadId",
    describeRoute({
      tags: ["Files"],
      summary: "Upload chunk",
      description:
        "Upload a single chunk of a chunked upload. The chunk index is specified in the query parameter. " +
        "Returns progress info or completion info when the last chunk is uploaded.",
      ...requiresIpaUser,
      responses: {
        200: jsonResponse(ChunkedUploadResponseSchema, "Chunk uploaded (progress or complete)"),
        400: jsonResponse(ErrorResponseSchema, "Invalid request"),
        403: jsonResponse(ErrorResponseSchema, "Access denied"),
        404: jsonResponse(ErrorResponseSchema, "Upload session not found"),
      },
    }),
    v("param", UploadIdParamSchema),
    v("query", ChunkedUploadChunkQuerySchema),
    v("header", ChunkHeaderSchema),
    async (c) => {
      const { uploadId, baseType, baseId } = c.req.valid("param");
      const { index } = c.req.valid("query");
      const headers = c.req.valid("header");
      const checksum = headers["x-chunk-checksum"];

      // Two separate questions. First: may the caller write to the base named
      // in the URL?
      const { base, error } = await requireBaseAccess(c);
      if (error || !base) return error!;

      // Second: does this upload session actually belong to that base? Filegate
      // derives the upload id from the target path, so it is guessable — without
      // this check a caller could point their own base at somebody else's
      // in-flight session and write chunks into it.
      if (!verifyUploadTicket({ uploadId, baseType, baseId, ticket: headers["x-upload-ticket"] })) {
        return respond(c, { ok: false, error: "Upload session does not belong to this base", status: 403 });
      }

      const body = await c.req.blob();
      const result = await filesService.upload.chunk({
        uploadId,
        index,
        data: body,
        checksum,
      });

      return respond(c, result);
    },
  );

export default app;
export type ApiType = typeof app;
