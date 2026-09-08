import { ErrorResponseSchema } from "@valentinkolb/cloud/contracts";
import { type AuthContext, auth, getLocale, jsonResponse, respond } from "@valentinkolb/cloud/server";
import { Hono, type MiddlewareHandler } from "hono";
import { describeRoute } from "hono-openapi";
import { z } from "zod";
import { DocumentProfileSummarySchema } from "../document-profile-contracts";
import { gridsService } from "../service";
import {
  gateDocument,
  PublicDocumentListSchema,
  PublicDocumentPageQuerySchema,
  PublicDocumentSchema,
  projectDocuments,
} from "./documents-api-shared";
import { pdfResponse } from "./download-response";
import { apiMessages } from "./messages";
import { gateAt } from "./permissions";
import { internalIdParam, requirePublicIdParam } from "./route-params";
import { v } from "./validator";

const DocumentArtifactKeySchema = z.string().regex(/^[a-z][a-z0-9._-]{0,63}$/);

const artifactResponse = (artifact: { bytes: Uint8Array; filename: string; mimeType: string; sizeBytes: number; sha256: string }) =>
  new Response(new Blob([Uint8Array.from(artifact.bytes)]), {
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
        responses: { 200: jsonResponse(z.array(DocumentProfileSummarySchema), "Document renderers") },
      }),
      (c) => c.json(gridsService.document.profiles()),
    )
    .get(
      "/by-base/:baseId",
      describeRoute({
        tags: ["Grids:Document"],
        summary: "List Documents for a Base",
        responses: {
          200: jsonResponse(PublicDocumentListSchema, "Documents"),
          403: jsonResponse(ErrorResponseSchema, "Forbidden"),
        },
      }),
      v("query", PublicDocumentPageQuerySchema),
      async (c) => {
        const baseId = internalIdParam(c, "baseId")!;
        const gate = await gateAt(c, { baseId }, "read");
        if (!gate.ok) return respond(c, () => Promise.resolve(gate));
        const query = c.req.valid("query");
        const page = await gridsService.document.listForBase({
          baseId,
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
        summary: "Download the primary PDF artifact",
        responses: { 200: { description: "Stored PDF bytes" }, 404: jsonResponse(ErrorResponseSchema, "Unavailable") },
      }),
      async (c) => {
        const document = await gridsService.document.getDocument(internalIdParam(c, "documentId")!);
        if (!document) return c.json({ message: apiMessages(c).documentNotFound }, 404);
        const gate = await gateDocument(c, document, "read");
        if (!gate.ok) return respond(c, () => Promise.resolve(gate));
        const artifact = await gridsService.document.getDocumentArtifact(document.id, "pdf", getLocale(c));
        if (!artifact.ok) return respond(c, () => Promise.resolve(artifact));
        return pdfResponse(artifact.data.bytes, artifact.data.filename, {
          "X-Grids-Document-Id": document.shortId,
          "X-Grids-Document-Number": document.documentNumber,
          "X-Grids-Document-Artifact": "pdf",
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
        const artifact = await gridsService.document.getDocumentArtifact(document.id, c.req.valid("param").artifactKey, getLocale(c));
        return artifact.ok ? artifactResponse(artifact.data) : respond(c, () => Promise.resolve(artifact));
      },
    );

export default createDocumentResourceRoutes();
