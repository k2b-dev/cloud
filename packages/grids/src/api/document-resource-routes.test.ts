import { describe, expect, test } from "bun:test";
import type { AuthContext } from "@k2b/cloud/server";
import type { MiddlewareHandler } from "hono";
import { generateSpecs } from "hono-openapi";
import { encodeDocumentCursor } from "../service/document-values";
import { createDocumentResourceRoutes } from "./document-resource-routes";
import { BaseDocumentBrowseQuerySchema, BaseDocumentListQuerySchema, PublicDocumentSchema } from "./documents-api-shared";

const authenticated: MiddlewareHandler<AuthContext> = async (_c, next) => next();

describe("Document resource API", () => {
  test("publishes one collection, detail, download, artifact, and renderer registry contract", async () => {
    const spec = await generateSpecs(createDocumentResourceRoutes({ requireAuthenticated: authenticated }), {
      documentation: { info: { title: "Documents", version: "1" }, openapi: "3.1.0" },
    });

    expect(Object.keys(spec.paths ?? {}).sort()).toEqual([
      "/by-base/{baseId}",
      "/by-base/{baseId}/browse",
      "/renderers",
      "/{documentId}",
      "/{documentId}/artifacts/{artifactKey}",
      "/{documentId}/contents",
      "/{documentId}/download",
      "/{documentId}/sources",
    ]);
    expect(spec.paths?.["/by-base/{baseId}"]?.post).toBeUndefined();
  });

  test("uses one strict public Document shape for every renderer", () => {
    const base = {
      id: "DOC123",
      baseId: "BASE12",
      tableId: "TABLE1",
      recordId: "REC123",
      templateId: "TPL123",
      workflowId: null,
      workflowRunId: null,
      number: "RE-2026-1",
      filename: "invoice.pdf",
      createdAt: "2026-08-22T10:00:00.000Z",
      tags: ["invoice"],
      createdBy: null,
      primaryArtifactKey: "pdf",
      downloadUrl: "/api/grids/documents/DOC123/download",
      dataSnapshot: null,
      sourceRecordCount: 1,
      validationStatus: null,
      artifacts: [
        {
          key: "pdf",
          filename: "invoice.pdf",
          mimeType: "application/pdf",
          sizeBytes: 4,
          sha256: "a".repeat(64),
          downloadUrl: "/api/grids/documents/DOC123/artifacts/pdf",
        },
      ],
    };
    expect(PublicDocumentSchema.safeParse({ ...base, renderer: { kind: "html" } }).success).toBe(true);
    expect(
      PublicDocumentSchema.safeParse({
        ...base,
        renderer: { kind: "profile", id: "de.zugferd.en16931", version: 1 },
        primaryArtifactKey: "pdf",
        validationStatus: "valid",
        artifacts: [
          ...base.artifacts,
          {
            key: "structured",
            filename: "invoice.xml",
            mimeType: "application/xml",
            sizeBytes: 3,
            sha256: "b".repeat(64),
            downloadUrl: "/api/grids/documents/DOC123/artifacts/structured",
          },
        ],
      }).success,
    ).toBe(true);
    expect(PublicDocumentSchema.safeParse({ ...base, renderer: { kind: "html" }, downloadUrl: undefined }).success).toBe(false);
    expect(PublicDocumentSchema.safeParse({ ...base, renderer: { kind: "html" }, documentNumber: base.number }).success).toBe(false);
    expect(PublicDocumentSchema.safeParse({ ...base, renderer: { kind: "html" }, recordId: null }).success).toBe(false);
    expect(
      PublicDocumentSchema.safeParse({ ...base, renderer: { kind: "html" }, recordId: null, tableId: null, templateId: null }).success,
    ).toBe(true);
  });

  test("validates combinable catalog filters and keeps cursors bound to their sort order", () => {
    const createdAt = "2026-09-01T10:00:00.000Z";
    const id = "11111111-1111-4111-8111-111111111111";
    const byTime = encodeDocumentCursor({ createdAt, id });
    const byName = encodeDocumentCursor({ createdAt, id }, "a.pdf");
    const filters = { workflow: "WFLOW1", template: "TPL123", table: "TABLE1", mediaType: "Application/ZIP" };
    for (const schema of [BaseDocumentBrowseQuerySchema, BaseDocumentListQuerySchema]) {
      expect(schema.parse({ ...filters })).toMatchObject({ ...filters, mediaType: "application/zip", sort: "newest" });
      expect(schema.safeParse({ sort: "name", cursor: byName }).success).toBe(true);
      expect(schema.safeParse({ sort: "oldest", cursor: byTime }).success).toBe(true);
      expect(schema.safeParse({ sort: "name", cursor: byTime }).success).toBe(false);
      expect(schema.safeParse({ cursor: byName }).success).toBe(false);
      expect(schema.safeParse({ sort: "size" }).success).toBe(false);
      expect(schema.safeParse({ mediaType: "pdf" }).success).toBe(false);
      expect(schema.safeParse({ workflow: "not a short id" }).success).toBe(false);
    }
  });
});
