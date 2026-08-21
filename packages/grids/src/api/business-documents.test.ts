import { describe, expect, test } from "bun:test";
import { err, fail, ok } from "@k2b/stdlib";
import type { AuthContext } from "@valentinkolb/cloud/server";
import type { MiddlewareHandler } from "hono";
import { generateSpecs } from "hono-openapi";
import type { BusinessDocument } from "../business-document-contracts";
import type { createBusinessDocumentService } from "../service/business-documents";
import { createBusinessDocumentsApi, toPublicBusinessDocumentFederationEvidence } from "./business-documents";

const baseInternalId = "019c8ddd-1111-7111-8111-111111111111";
const predecessorInternalId = "019c8ddd-2222-7222-8222-222222222222";
const authenticated: MiddlewareHandler<AuthContext> = async (_c, next) => next();

const document: BusinessDocument = {
  id: "DOC123",
  baseId: "BASE12",
  profileId: "test.statement",
  profileVersion: 1,
  source: { appId: "orders", resourceType: "order", resourceId: "42" },
  sourceRevision: { id: "7", observedAt: "2026-08-22T10:00:00.000Z", evidence: {} },
  snapshotSha256: "a".repeat(64),
  number: "STAT-0002",
  relationship: "correction",
  predecessorId: "OLD123",
  rendererVersion: "renderer-v1",
  validatorVersion: "validator-v1",
  validationStatus: "valid",
  validationReport: {},
  issuedAt: "2026-08-22T10:00:00.000Z",
  artifacts: [
    { key: "pdf", filename: "statement.pdf", mediaType: "application/pdf", sizeBytes: 4, sha256: "b".repeat(64) },
    { key: "structured", filename: "statement.json", mediaType: "application/json", sizeBytes: 2, sha256: "c".repeat(64) },
  ],
};

const issueBody = {
  profileId: "test.statement",
  profileVersion: 1,
  idempotencyKey: "order-42-correction",
  source: document.source,
  sourceRevision: document.sourceRevision,
  snapshot: { total: "10.00" },
  relationship: "correction",
  predecessorId: "OLD123",
};

const createApp = (options: { allowed?: boolean; issue?: ReturnType<typeof createBusinessDocumentService>["issue"] } = {}) => {
  const issue = options.issue ?? (async () => ok({ document, replayed: false }));
  const service: ReturnType<typeof createBusinessDocumentService> = {
    profiles: () => [],
    issue,
    getInternal: async () => null,
    getByShortId: async (id) =>
      id === "OLD123"
        ? { ...document, id: "OLD123", predecessorId: null, relationship: "original", internalId: predecessorInternalId }
        : null,
    list: async () => ok({ items: [], cursor: null, hasMore: false }),
    artifact: async () => fail(err.notFound("artifact")),
  };
  return createBusinessDocumentsApi({
    requireAuthenticated: authenticated,
    service,
    resolveId: async (resource, id) => (resource === "base" && id === "BASE12" ? baseInternalId : null),
    authorize: async () => (options.allowed === false ? fail(err.forbidden("denied")) : ok("write")),
  });
};

describe("Business Document API", () => {
  test("binds federated revisions without exposing their internal UUIDs", async () => {
    const tableId = "019c8ddd-3333-7333-8333-333333333333";
    const revisionId = "019c8ddd-4444-7444-8444-444444444444";
    const evidence = await toPublicBusinessDocumentFederationEvidence(
      [{ tableId, revisionId, revisionToken: "revision-token-v3" }],
      async () => new Map([[tableId, "TABLE1"]]),
    );
    expect(evidence).toEqual([
      { tableId: "TABLE1", revision: expect.stringMatching(/^[a-f0-9]{64}$/), revisionToken: "revision-token-v3" },
    ]);
    expect(JSON.stringify(evidence)).not.toContain(tableId);
    expect(JSON.stringify(evidence)).not.toContain(revisionId);
  });

  test("publishes issuance, browsing, and exact artifact routes in OpenAPI", async () => {
    const spec = await generateSpecs(createBusinessDocumentsApi({ requireAuthenticated: authenticated }), {
      documentation: { info: { title: "Business Documents", version: "1" }, openapi: "3.1.0" },
    });
    expect(Object.keys(spec.paths ?? {}).sort()).toEqual([
      "/by-base/{baseId}",
      "/by-base/{baseId}/issue",
      "/by-base/{baseId}/issue-from-gql",
      "/profiles",
      "/{documentId}",
      "/{documentId}/artifacts/{artifactKey}",
    ]);
  });

  test("keeps public ids at the route and passes only the predecessor UUID to the service", async () => {
    let received: Parameters<ReturnType<typeof createBusinessDocumentService>["issue"]>[0] | undefined;
    const app = createApp({
      issue: async (input) => {
        received = input;
        return ok({ document, replayed: false });
      },
    });
    const response = await app.request("/by-base/BASE12/issue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(issueBody),
    });
    expect(response.status).toBe(201);
    expect(received).toMatchObject({ baseId: baseInternalId, predecessorId: predecessorInternalId });
    const payload = await response.json();
    expect(payload.document.id).toBe("DOC123");
    expect(JSON.stringify(payload)).not.toContain(baseInternalId);
    expect(JSON.stringify(payload)).not.toContain(predecessorInternalId);
  });

  test("does not issue when Base write permission is missing", async () => {
    let called = false;
    const app = createApp({
      allowed: false,
      issue: async () => {
        called = true;
        return ok({ document, replayed: false });
      },
    });
    const response = await app.request("/by-base/BASE12/issue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(issueBody),
    });
    expect(response.status).toBe(403);
    expect(called).toBe(false);
  });

  test("rejects internal UUIDs at the public predecessor boundary", async () => {
    const response = await createApp().request("/by-base/BASE12/issue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...issueBody, predecessorId: predecessorInternalId }),
    });
    expect(response.status).toBe(400);
  });
});
