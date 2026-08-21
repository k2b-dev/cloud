import { createHash } from "node:crypto";
import { ErrorResponseSchema } from "@valentinkolb/cloud/contracts";
import { type AuthContext, auth, jsonResponse, type RequestActor, respond, v } from "@valentinkolb/cloud/server";
import { Hono, type MiddlewareHandler } from "hono";
import { describeRoute } from "hono-openapi";
import { z } from "zod";
import {
  BusinessDocumentArtifactKeySchema,
  BusinessDocumentGqlIssueSchema,
  BusinessDocumentIssueResponseSchema,
  BusinessDocumentIssueSchema,
  BusinessDocumentListQuerySchema,
  BusinessDocumentListSchema,
  BusinessDocumentProfileSummarySchema,
  BusinessDocumentSchema,
} from "../business-document-contracts";
import { gridsService } from "../service";
import {
  type BusinessDocumentActor,
  canonicalBusinessDocumentJson,
  type createBusinessDocumentService,
} from "../service/business-documents";
import type { FederatedRevisionScope } from "../service/federated-tables";
import { projectPublicIds, type resolvePublicId } from "../service/public-resources";
import { fromPublicGqlScope, toPublicGqlResponse } from "./gql-public";
import { canonicalGqlSource, executeGqlSource } from "./gql-runtime";
import { gateAt } from "./permissions";
import { internalIdParam, requirePublicIdParam } from "./route-params";

type BusinessDocumentService = ReturnType<typeof createBusinessDocumentService>;

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

const businessDocumentActor = (actor: RequestActor | undefined): BusinessDocumentActor => {
  if (!actor) return { kind: "system" };
  if (actor.kind === "user") return { kind: "user", userId: actor.user.id };
  return {
    kind: "service_account",
    serviceAccountId: actor.serviceAccount.id,
    delegatedUserId: actor.delegatedUser?.id ?? null,
    credentialId: actor.credentialId ?? null,
  };
};

export const toPublicBusinessDocumentFederationEvidence = async (
  scope: FederatedRevisionScope,
  projectIds: typeof projectPublicIds = projectPublicIds,
) => {
  const tableIds = await projectIds(
    "table",
    scope.map((item) => item.tableId),
  );
  return scope.map((item) => {
    const tableId = tableIds.get(item.tableId);
    if (!tableId) throw new Error("Missing public Table ID for Business Document source revision");
    return { tableId, revision: sha256(item.revisionId), revisionToken: item.revisionToken };
  });
};

export const createBusinessDocumentsApi = (
  deps: {
    requireAuthenticated?: MiddlewareHandler<AuthContext>;
    service?: BusinessDocumentService;
    resolveId?: typeof resolvePublicId;
    authorize?: typeof gateAt;
    getBaseByShortId?: typeof gridsService.base.getByShortId;
  } = {},
) => {
  const service = deps.service ?? gridsService.businessDocument;
  const authorize = deps.authorize ?? gateAt;
  const getBaseByShortId = deps.getBaseByShortId ?? gridsService.base.getByShortId;
  const loadDocument = async (publicId: string) => service.getByShortId(publicId);

  return new Hono<AuthContext>()
    .use(deps.requireAuthenticated ?? auth.requireRole("authenticated"))
    .use("/by-base/:baseId/*", requirePublicIdParam("baseId", "base", "Base", deps.resolveId))
    .get(
      "/profiles",
      describeRoute({
        tags: ["Grids:BusinessDocument"],
        summary: "List immutable Business Document profiles",
        responses: { 200: jsonResponse(z.array(BusinessDocumentProfileSummarySchema), "Profiles") },
      }),
      (c) => c.json(service.profiles()),
    )
    .get(
      "/by-base/:baseId",
      describeRoute({
        tags: ["Grids:BusinessDocument"],
        summary: "List immutable Business Documents for a Base",
        responses: {
          200: jsonResponse(BusinessDocumentListSchema, "Business Documents"),
          403: jsonResponse(ErrorResponseSchema, "Forbidden"),
        },
      }),
      v("query", BusinessDocumentListQuerySchema),
      async (c) => {
        const baseId = internalIdParam(c, "baseId")!;
        const gate = await authorize(c, { baseId }, "read");
        if (!gate.ok) return respond(c, () => Promise.resolve(gate));
        return respond(c, () => service.list({ baseId, ...c.req.valid("query") }));
      },
    )
    .post(
      "/by-base/:baseId/issue",
      describeRoute({
        tags: ["Grids:BusinessDocument"],
        summary: "Issue an immutable Business Document from an exact native snapshot",
        responses: {
          200: jsonResponse(BusinessDocumentIssueResponseSchema, "Idempotent replay"),
          201: jsonResponse(BusinessDocumentIssueResponseSchema, "Issued"),
          400: jsonResponse(ErrorResponseSchema, "Invalid profile input"),
          403: jsonResponse(ErrorResponseSchema, "Base write required"),
          404: jsonResponse(ErrorResponseSchema, "Base or predecessor not found"),
          409: jsonResponse(ErrorResponseSchema, "Idempotency or predecessor conflict"),
        },
      }),
      v("json", BusinessDocumentIssueSchema),
      async (c) => {
        const baseId = internalIdParam(c, "baseId")!;
        const gate = await authorize(c, { baseId }, "write");
        if (!gate.ok) return respond(c, () => Promise.resolve(gate));
        const body = c.req.valid("json");
        const predecessor = body.predecessorId ? await loadDocument(body.predecessorId) : null;
        if (body.predecessorId && (!predecessor || predecessor.baseId !== c.req.param("baseId"))) {
          return c.json({ message: "Business Document predecessor not found" }, 404);
        }
        const result = await service.issue({
          ...body,
          baseId,
          predecessorId: predecessor?.internalId,
          actor: businessDocumentActor(c.get("actor")),
        });
        return result.ok ? c.json(result.data, result.data.replayed ? 200 : 201) : respond(c, () => Promise.resolve(result));
      },
    )
    .post(
      "/by-base/:baseId/issue-from-gql",
      describeRoute({
        tags: ["Grids:BusinessDocument"],
        summary: "Issue an immutable Business Document from one bounded permission-safe GQL snapshot",
        responses: {
          200: jsonResponse(BusinessDocumentIssueResponseSchema, "Idempotent replay"),
          201: jsonResponse(BusinessDocumentIssueResponseSchema, "Issued"),
          400: jsonResponse(ErrorResponseSchema, "Invalid query, result, or profile input"),
          403: jsonResponse(ErrorResponseSchema, "Base write required"),
          404: jsonResponse(ErrorResponseSchema, "Base or predecessor not found"),
          409: jsonResponse(ErrorResponseSchema, "Idempotency or predecessor conflict"),
        },
      }),
      v("json", BusinessDocumentGqlIssueSchema),
      async (c) => {
        const baseId = internalIdParam(c, "baseId")!;
        const gate = await authorize(c, { baseId }, "write");
        if (!gate.ok) return respond(c, () => Promise.resolve(gate));
        const body = c.req.valid("json");
        const scope = await fromPublicGqlScope(baseId, body);
        if (!scope.ok) return respond(c, () => Promise.resolve(scope));
        const canonical = await canonicalGqlSource(c, baseId, { query: body.query, ...scope.data });
        if (!canonical.ok) return c.json({ message: canonical.diagnostics.map((item) => item.message).join("; ") }, 400);
        const execution = await executeGqlSource(
          c,
          baseId,
          { query: canonical.source, ...scope.data, pageSize: 100, surface: "api" },
          { operation: "execute", maxRows: 100, maxResultBytes: 5 * 1024 * 1024, labelRelationValues: true },
        );
        const projected = await toPublicGqlResponse(execution.response);
        if (!projected.ok) return c.json({ message: projected.diagnostics.map((item) => item.message).join("; ") }, 400);
        if (projected.truncated || projected.page?.nextCursor) {
          return c.json({ message: "Business Document GQL input must fit in one result of at most 100 rows." }, 400);
        }
        const snapshot = canonicalBusinessDocumentJson({ columns: projected.columns, rows: projected.rows });
        const federation = await toPublicBusinessDocumentFederationEvidence(execution.revisionScope ?? []);
        const predecessor = body.predecessorId ? await loadDocument(body.predecessorId) : null;
        if (body.predecessorId && (!predecessor || predecessor.baseId !== c.req.param("baseId"))) {
          return c.json({ message: "Business Document predecessor not found" }, 404);
        }
        const result = await service.issue({
          baseId,
          profileId: body.profileId,
          profileVersion: body.profileVersion,
          idempotencyKey: body.idempotencyKey,
          relationship: body.relationship,
          predecessorId: predecessor?.internalId,
          source: { appId: "grids", resourceType: "gql-selection", resourceId: sha256(canonical.source) },
          sourceRevision: {
            id: snapshot.sha256,
            observedAt: body.observedAt,
            evidence: { canonicalGql: canonical.source, federation },
          },
          snapshot: snapshot.value,
          actor: businessDocumentActor(c.get("actor")),
        });
        return result.ok ? c.json(result.data, result.data.replayed ? 200 : 201) : respond(c, () => Promise.resolve(result));
      },
    )
    .get(
      "/:documentId",
      v("param", z.object({ documentId: z.string().regex(/^[A-Za-z0-9]{6}$/) })),
      describeRoute({
        tags: ["Grids:BusinessDocument"],
        summary: "Inspect an immutable Business Document",
        responses: {
          200: jsonResponse(BusinessDocumentSchema, "Business Document"),
          404: jsonResponse(ErrorResponseSchema, "Unavailable"),
        },
      }),
      async (c) => {
        const { documentId } = c.req.valid("param");
        const document = await loadDocument(documentId);
        if (!document) return c.json({ message: "Business Document not found" }, 404);
        const base = await getBaseByShortId(document.baseId);
        if (!base) return c.json({ message: "Business Document not found" }, 404);
        const gate = await authorize(c, { baseId: base.id }, "read");
        if (!gate.ok) return c.json({ message: "Business Document not found" }, 404);
        const { internalId: _internalId, ...publicDocument } = document;
        return c.json(publicDocument);
      },
    )
    .get(
      "/:documentId/artifacts/:artifactKey",
      v("param", z.object({ documentId: z.string().regex(/^[A-Za-z0-9]{6}$/), artifactKey: BusinessDocumentArtifactKeySchema })),
      describeRoute({
        tags: ["Grids:BusinessDocument"],
        summary: "Download an exact immutable Business Document artifact",
        responses: { 200: { description: "Stored artifact bytes" }, 404: jsonResponse(ErrorResponseSchema, "Unavailable") },
      }),
      async (c) => {
        const { documentId, artifactKey } = c.req.valid("param");
        const document = await loadDocument(documentId);
        if (!document) return c.json({ message: "Business Document not found" }, 404);
        const base = await getBaseByShortId(document.baseId);
        if (!base || !(await authorize(c, { baseId: base.id }, "read")).ok) return c.json({ message: "Business Document not found" }, 404);
        const artifact = await service.artifact(document.internalId, artifactKey);
        if (!artifact.ok) return respond(c, () => Promise.resolve(artifact));
        return new Response(new Blob([Uint8Array.from(artifact.data.bytes)]), {
          headers: {
            "Content-Type": artifact.data.mediaType,
            "Content-Length": String(artifact.data.sizeBytes),
            "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(artifact.data.filename)}`,
            ETag: `"${artifact.data.sha256}"`,
            "Cache-Control": "private, no-store",
          },
        });
      },
    );
};

export default createBusinessDocumentsApi();
