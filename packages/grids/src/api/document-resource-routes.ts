import { ErrorResponseSchema } from "@k2b/cloud/contracts";
import { type AuthContext, auth, getDateConfig, getLocale, jsonResponse, respond } from "@k2b/cloud/server";
import { Hono, type MiddlewareHandler } from "hono";
import { describeRoute } from "hono-openapi";
import { z } from "zod";
import { DocumentProfileReferenceSchema } from "../document-profile-contracts";
import { gridsService } from "../service";
import { listDocumentRecordSources } from "../service/document-record-sources";
import { documentArtifactDownloadUrl } from "./document-public-contracts";
import {
  BaseDocumentBrowseQuerySchema,
  BaseDocumentListQuerySchema,
  documentCatalogFilters,
  gateDocument,
  PublicDocumentBrowseResponseSchema,
  PublicDocumentListSchema,
  PublicDocumentSchema,
  projectDocuments,
} from "./documents-api-shared";
import { fileResponse } from "./download-response";
import { apiMessages } from "./messages";
import { currentActorViewer, gateAt } from "./permissions";
import { internalIdParam, requirePublicIdParam } from "./route-params";
import { v } from "./validator";

const DocumentArtifactKeySchema = z.string().regex(/^[a-z][a-z0-9._-]{0,63}$/);

const artifactResponse = (artifact: {
  stream: () => ReadableStream<Uint8Array>;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
}) =>
  new Response(artifact.stream(), {
    headers: {
      "Content-Type": artifact.mimeType,
      "Content-Length": String(artifact.sizeBytes),
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(artifact.filename)}`,
      ETag: `"${artifact.sha256}"`,
      "Cache-Control": "private, no-store",
    },
  });

export const createDocumentResourceRoutes = (deps: { requireAuthenticated?: MiddlewareHandler<AuthContext> } = {}) =>
  new Hono<AuthContext>()
    .use(deps.requireAuthenticated ?? auth.requireRole("authenticated"))
    .use("/by-base/:baseId/*", requirePublicIdParam("baseId", "base", "Base"))
    .get(
      "/renderers",
      describeRoute({
        tags: ["Grids:Document"],
        summary: "List installed Document renderers",
        responses: { 200: jsonResponse(z.array(DocumentProfileReferenceSchema), "Document renderers with input schemas") },
      }),
      (c) => c.json(gridsService.document.profiles()),
    )
    .get(
      "/by-base/:baseId/browse",
      describeRoute({
        tags: ["Grids:Document"],
        summary: "Browse Documents by template and year, or search, filter and sort the Base catalog",
        responses: {
          200: jsonResponse(PublicDocumentBrowseResponseSchema, "Document browser page"),
          403: jsonResponse(ErrorResponseSchema, "Forbidden"),
        },
      }),
      v("query", BaseDocumentBrowseQuerySchema),
      async (c) => {
        const baseId = internalIdParam(c, "baseId")!;
        const gate = await gateAt(c, { baseId }, "read");
        if (!gate.ok) return respond(c, () => Promise.resolve(gate));
        const query = c.req.valid("query");
        const page = await gridsService.document.browseDocumentsForBase({
          ...query,
          filters: documentCatalogFilters(query),
          baseId,
          timeZone: (await getDateConfig(c)).timeZone,
        });
        return c.json({
          path: page.path,
          folders: page.folders,
          items: await projectDocuments(page.items),
          cursor: page.nextCursor ?? null,
          hasMore: page.hasMore ?? false,
        });
      },
    )
    .get(
      "/by-base/:baseId",
      describeRoute({
        tags: ["Grids:Document"],
        summary: "List, search, filter and sort Documents for a Base",
        responses: {
          200: jsonResponse(PublicDocumentListSchema, "Documents"),
          403: jsonResponse(ErrorResponseSchema, "Forbidden"),
        },
      }),
      v("query", BaseDocumentListQuerySchema),
      async (c) => {
        const baseId = internalIdParam(c, "baseId")!;
        const gate = await gateAt(c, { baseId }, "read");
        if (!gate.ok) return respond(c, () => Promise.resolve(gate));
        const query = c.req.valid("query");
        const page = await gridsService.document.listForBase({
          baseId,
          q: query.q,
          filters: documentCatalogFilters(query),
          sort: query.sort,
          limit: query.limit,
          cursor: query.cursor || null,
        });
        return c.json({
          items: await projectDocuments(page.items),
          cursor: page.nextCursor,
          hasMore: page.hasMore,
        });
      },
    )
    .get(
      "/:documentId/sources",
      describeRoute({
        tags: ["Grids:Document"],
        summary: "List frozen source record identities and versions for a Document",
        responses: {
          200: jsonResponse(
            z.object({
              items: z.array(
                z.object({
                  tableId: z.string(),
                  recordId: z.string(),
                  tableName: z.string(),
                  label: z.string(),
                  version: z.number().int().positive().nullable(),
                  deleted: z.boolean(),
                }),
              ),
              hasMore: z.boolean(),
            }),
            "Source records page",
          ),
          403: jsonResponse(ErrorResponseSchema, "Forbidden"),
          404: jsonResponse(ErrorResponseSchema, "Document not found"),
        },
      }),
      requirePublicIdParam("documentId", "document", "Document"),
      v(
        "query",
        z.object({ offset: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(100).default(50) }),
      ),
      async (c) => {
        const document = await gridsService.document.getDocument(internalIdParam(c, "documentId")!);
        if (!document) return c.json({ message: apiMessages(c).documentNotFound }, 404);
        const gate = await gateDocument(c, document, "read");
        if (!gate.ok) return respond(c, () => Promise.resolve(gate));
        const { offset, limit } = c.req.valid("query");
        return c.json(await listDocumentRecordSources(document.id, offset, limit, undefined, currentActorViewer(c)));
      },
    )
    .get(
      "/:documentId/contents",
      describeRoute({
        tags: ["Grids:Document"],
        summary: "List the files packaged in a ZIP Document",
        description:
          "Frozen provenance of a ZIP Document: each packaged path, its size and the stored Document artifact it came from. Other Documents have no contents.",
        responses: {
          200: jsonResponse(
            z.object({
              items: z.array(
                z.object({
                  path: z.string(),
                  sizeBytes: z.number().int().nonnegative(),
                  documentId: z.string(),
                  artifactKey: z.string(),
                  downloadUrl: z.string(),
                }),
              ),
              total: z.number().int().nonnegative(),
              hasMore: z.boolean(),
            }),
            "Archive contents page",
          ),
          403: jsonResponse(ErrorResponseSchema, "Forbidden"),
          404: jsonResponse(ErrorResponseSchema, "Document not found"),
        },
      }),
      requirePublicIdParam("documentId", "document", "Document"),
      v(
        "query",
        z.object({ offset: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(100).default(50) }),
      ),
      async (c) => {
        const document = await gridsService.document.getDocument(internalIdParam(c, "documentId")!);
        if (!document) return c.json({ message: apiMessages(c).documentNotFound }, 404);
        const gate = await gateDocument(c, document, "read");
        if (!gate.ok) return respond(c, () => Promise.resolve(gate));
        const { offset, limit } = c.req.valid("query");
        const page = await gridsService.document.listArchiveContents(document.id, offset, limit);
        return c.json({
          ...page,
          items: page.items.map((item) => ({ ...item, downloadUrl: documentArtifactDownloadUrl(item.documentId, item.artifactKey) })),
        });
      },
    )
    .get(
      "/:documentId",
      requirePublicIdParam("documentId", "document", "Document"),
      describeRoute({
        tags: ["Grids:Document"],
        summary: "Get a Document",
        responses: {
          200: jsonResponse(PublicDocumentSchema, "Document"),
          404: jsonResponse(ErrorResponseSchema, "Unavailable"),
        },
      }),
      async (c) => {
        const document = await gridsService.document.getDocument(internalIdParam(c, "documentId")!);
        if (!document) return c.json({ message: apiMessages(c).documentNotFound }, 404);
        const gate = await gateDocument(c, document, "read");
        if (!gate.ok) return respond(c, () => Promise.resolve(gate));
        const [projected] = await projectDocuments([gridsService.document.summarizeDocument(document)]);
        return projected ? c.json(projected) : c.json({ message: apiMessages(c).documentNotFound }, 404);
      },
    )
    .get(
      "/:documentId/download",
      requirePublicIdParam("documentId", "document", "Document"),
      describeRoute({
        tags: ["Grids:Document"],
        summary: "Download the primary Document artifact",
        responses: { 200: { description: "Stored primary artifact bytes" }, 404: jsonResponse(ErrorResponseSchema, "Unavailable") },
      }),
      async (c) => {
        const document = await gridsService.document.getDocument(internalIdParam(c, "documentId")!);
        if (!document) return c.json({ message: apiMessages(c).documentNotFound }, 404);
        const gate = await gateDocument(c, document, "read");
        if (!gate.ok) return respond(c, () => Promise.resolve(gate));
        const artifact = await gridsService.document.openDocumentArtifact(document.id, document.primaryArtifactKey, getLocale(c));
        if (!artifact.ok) return respond(c, () => Promise.resolve(artifact));
        return fileResponse(artifact.data, artifact.data.filename, artifact.data.mimeType, {
          "X-Grids-Document-Id": document.shortId,
          "X-Grids-Document-Number": document.documentNumber,
          "X-Grids-Document-Artifact": document.primaryArtifactKey,
        });
      },
    )
    .get(
      "/:documentId/artifacts/:artifactKey",
      requirePublicIdParam("documentId", "document", "Document"),
      v("param", z.object({ documentId: z.string(), artifactKey: DocumentArtifactKeySchema })),
      describeRoute({
        tags: ["Grids:Document"],
        summary: "Download an exact immutable Document artifact",
        responses: { 200: { description: "Stored artifact bytes" }, 404: jsonResponse(ErrorResponseSchema, "Unavailable") },
      }),
      async (c) => {
        const document = await gridsService.document.getDocument(internalIdParam(c, "documentId")!);
        if (!document) return c.json({ message: apiMessages(c).documentNotFound }, 404);
        const gate = await gateDocument(c, document, "read");
        if (!gate.ok) return respond(c, () => Promise.resolve(gate));
        const artifact = await gridsService.document.openDocumentArtifact(document.id, c.req.valid("param").artifactKey, getLocale(c));
        return artifact.ok ? artifactResponse(artifact.data) : respond(c, () => Promise.resolve(artifact));
      },
    );
