import { describe, expect, test } from "bun:test";
import type { AuthContext } from "@k2b/cloud/server";
import type { MiddlewareHandler } from "hono";
import { generateSpecs } from "hono-openapi";
import { createDocumentResourceRoutes } from "./document-resource-routes";
import { PublicDocumentSchema } from "./documents-api-shared";

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
      "/{documentId}/download",
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
      number: "RE-2026-1",
      filename: "invoice.pdf",
      createdAt: "2026-08-22T10:00:00.000Z",
      tags: ["invoice"],
      createdBy: null,
      validationStatus: null,
      artifacts: [{ key: "pdf", filename: "invoice.pdf", mimeType: "application/pdf", sizeBytes: 4, sha256: "a".repeat(64) }],
    };
    expect(PublicDocumentSchema.safeParse({ ...base, renderer: { kind: "html" } }).success).toBe(true);
    expect(
      PublicDocumentSchema.safeParse({
        ...base,
        renderer: { kind: "profile", id: "de.zugferd.en16931", version: 1 },
        validationStatus: "valid",
        artifacts: [
          ...base.artifacts,
          { key: "structured", filename: "invoice.xml", mimeType: "application/xml", sizeBytes: 3, sha256: "b".repeat(64) },
        ],
      }).success,
    ).toBe(true);
    expect(PublicDocumentSchema.safeParse({ ...base, renderer: { kind: "html" }, documentNumber: base.number }).success).toBe(false);
    expect(PublicDocumentSchema.safeParse({ ...base, renderer: { kind: "html" }, recordId: null }).success).toBe(false);
  });
});
