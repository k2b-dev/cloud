import { ErrorResponseSchema } from "@valentinkolb/cloud/contracts";
import { type AuthContext, auth, getLocale, jsonResponse, respond } from "@valentinkolb/cloud/server";
import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { z } from "zod";
import {
  type FederatedDraftInput,
  type FederatedRevision,
  FederatedSourceCandidateQuerySchema,
  RecordActorListResponseSchema,
  RecordMetaUserKeySchema,
  ShortIdSchema,
} from "../contracts";
import { gridsService } from "../service";
import { projectPublicIds, resolvePublicIds } from "../service/public-resources";
import * as recordFinalizationService from "../service/record-finalization";
import { PublicDurableHistoryStatusSchema, toPublicDurableHistoryStatus } from "./durable-history";
import { apiMessages } from "./messages";
import { currentAccessSubject, currentActorUserId, currentCredentialPermission, currentResourceBoundBaseId, gateAt } from "./permissions";
import {
  fromPublicCreateTable,
  fromPublicFederatedDraft,
  fromPublicUpdateTable,
  PublicCreateTableSchema,
  PublicFederatedDraftInputSchema,
  PublicFederatedRevisionViewSchema,
  PublicFederatedSourceCandidatePageSchema,
  PublicFederatedSourcePublicationListSchema,
  PublicFederatedTableConfigSchema,
  PublicFederatedValidationSchema,
  PublicMutationPolicyImpactSchema,
  PublicMutationPolicyInputSchema,
  PublicMutationPolicyResponseSchema,
  PublicMutationPolicyUpdateSchema,
  PublicTableListSchema,
  PublicTableSchema,
  PublicUpdateFederatedDraftSchema,
  PublicUpdateTableSchema,
  toPublicFederatedDiagnostics,
  toPublicFederatedRevision,
  toPublicFederatedSourceCandidates,
  toPublicFederatedSourcePublications,
  toPublicTable,
  toPublicTables,
} from "./public-dto";
import {
  PublicFinalizationPolicyInputSchema,
  PublicRecordFinalizationStatusSchema,
  toPublicRecordFinalizationStatus,
} from "./record-finalization";
import { internalIdParam, requirePublicIdParam, requireStoredPublicIdParam } from "./route-params";
import {
  PublicTableAdminOverviewPageSchema,
  PublicTableAdminOverviewQuerySchema,
  toPublicTableAdminOverview,
} from "./table-admin-overview";
import { tableQueryRoutes } from "./table-query-routes";
import { v } from "./validator";

const PublicRelationLookupResponseSchema = z.object({
  items: z.array(z.object({ id: ShortIdSchema, label: z.string() })),
});

const TablesByBaseQuerySchema = z
  .object({
    q: z.string().trim().max(100).optional().default(""),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();

const requireSourceBaseAdmins = async (c: Parameters<typeof gateAt>[0], sourceTableIds: string[]) => {
  const administered = await Promise.all(
    [...new Set(sourceTableIds)].map(async (sourceTableId) => {
      const source = await gridsService.table.get(sourceTableId);
      if (!source || source.kind !== "stored") return false;
      return (await gateAt(c, { baseId: source.baseId }, "admin")).ok;
    }),
  );
  if (administered.some((allowed) => !allowed)) {
    return { response: c.json({ message: apiMessages(c).sourceTablesUnavailable }, 403) };
  }
  return { response: null };
};

const publicationAuthorization = (c: Parameters<typeof gateAt>[0]) => ({
  subject: currentAccessSubject(c),
  permissionCap: currentCredentialPermission(c),
  resourceBoundBaseId: currentResourceBoundBaseId(c),
});

const sourceTablesAdministeredByActor = async (
  c: Parameters<typeof gateAt>[0],
  revisions: Array<FederatedRevision | null>,
): Promise<Set<string>> => {
  const sourceTableIds = [...new Set(revisions.flatMap((revision) => revision?.sources.map((source) => source.sourceTableId) ?? []))];
  const checks = await Promise.all(
    sourceTableIds.map(async (sourceTableId) => {
      const source = await gridsService.table.get(sourceTableId, { includeDeleted: true });
      if (!source) return null;
      const gate = await gateAt(c, { baseId: source.baseId }, "admin");
      return gate.ok ? sourceTableId : null;
    }),
  );
  return new Set(checks.filter((sourceTableId): sourceTableId is string => sourceTableId !== null));
};

const retainUnadministeredDraftSources = (
  input: FederatedDraftInput,
  draft: FederatedRevision,
  administeredSourceTableIds: ReadonlySet<string>,
): FederatedDraftInput => {
  const retainedSourceIds = draft.sources
    .filter((source) => !administeredSourceTableIds.has(source.sourceTableId))
    .map((source) => source.id);
  return retainedSourceIds.length > 0 ? { ...input, retainedSourceIds } : input;
};

export const tablesRoutes = new Hono<AuthContext>()

  .get(
    "/:tableId/federation/publications",
    requirePublicIdParam("tableId", "table", "Source table"),
    describeRoute({
      tags: ["Grids:Table"],
      summary: "List combined-table publications of a source table",
      responses: {
        200: jsonResponse(PublicFederatedSourcePublicationListSchema, "Combined-table publications"),
        403: jsonResponse(ErrorResponseSchema, "Forbidden"),
        404: jsonResponse(ErrorResponseSchema, "Not found"),
      },
    }),
    async (c) => {
      const tableId = internalIdParam(c, "tableId")!;
      const source = await gridsService.table.get(tableId);
      if (!source || source.kind !== "stored") return c.json({ message: apiMessages(c).sourceTableNotFound }, 404);
      const gate = await gateAt(c, { baseId: source.baseId }, "admin");
      if (!gate.ok) return respond(c, () => Promise.resolve(gate));
      return c.json(await toPublicFederatedSourcePublications(await gridsService.table.federation.listPublicationsForSource(tableId)));
    },
  )

  .get(
    "/:tableId/federation",
    requirePublicIdParam("tableId", "table", "Combined table"),
    describeRoute({
      tags: ["Grids:Table"],
      summary: "Get combined table configuration",
      responses: {
        200: jsonResponse(PublicFederatedTableConfigSchema, "Combined table configuration"),
        403: jsonResponse(ErrorResponseSchema, "Forbidden"),
        404: jsonResponse(ErrorResponseSchema, "Not found"),
      },
    }),
    async (c) => {
      const tableId = internalIdParam(c, "tableId")!;
      const table = await gridsService.table.get(tableId);
      if (!table || table.kind !== "federated") return c.json({ message: apiMessages(c).combinedTableNotFound }, 404);
      const gate = await gateAt(c, { baseId: table.baseId }, "admin");
      if (!gate.ok) return respond(c, () => Promise.resolve(gate));
      const [draft, current] = await Promise.all([
        gridsService.table.federation.getDraft(tableId),
        gridsService.table.federation.getCurrent(tableId),
      ]);
      if (!draft) return c.json({ message: apiMessages(c).combinedTableDraftNotFound }, 404);
      const administeredSources = await sourceTablesAdministeredByActor(c, [draft, current]);
      return c.json({
        current: current ? await toPublicFederatedRevision(current, administeredSources) : null,
        draft: await toPublicFederatedRevision(draft, administeredSources),
      });
    },
  )

  .get(
    "/:tableId/federation/source-candidates",
    requirePublicIdParam("tableId", "table", "Combined table"),
    describeRoute({
      tags: ["Grids:Table"],
      summary: "List source tables available for a combined table",
      responses: {
        200: jsonResponse(PublicFederatedSourceCandidatePageSchema, "Source candidates"),
        403: jsonResponse(ErrorResponseSchema, "Forbidden"),
        404: jsonResponse(ErrorResponseSchema, "Not found"),
      },
    }),
    v("query", FederatedSourceCandidateQuerySchema),
    async (c) => {
      const tableId = internalIdParam(c, "tableId")!;
      const target = await gridsService.table.get(tableId);
      if (!target || target.kind !== "federated") return c.json({ message: apiMessages(c).combinedTableNotFound }, 404);
      const targetGate = await gateAt(c, { baseId: target.baseId }, "admin");
      if (!targetGate.ok) return respond(c, () => Promise.resolve(targetGate));

      const query = c.req.valid("query");
      return c.json(
        toPublicFederatedSourceCandidates(
          await gridsService.table.federation.listSourceCandidates({
            targetTableId: tableId,
            authorization: publicationAuthorization(c),
            q: query.q,
            limit: query.limit,
            offset: query.offset,
          }),
        ),
      );
    },
  )

  .put(
    "/:tableId/federation/draft",
    requirePublicIdParam("tableId", "table", "Combined table"),
    describeRoute({
      tags: ["Grids:Table"],
      summary: "Update combined table draft",
      responses: {
        200: jsonResponse(PublicFederatedRevisionViewSchema, "Updated draft"),
        400: jsonResponse(ErrorResponseSchema, "Invalid draft"),
        403: jsonResponse(ErrorResponseSchema, "Forbidden"),
        404: jsonResponse(ErrorResponseSchema, "Not found"),
        409: jsonResponse(ErrorResponseSchema, "Configuration changed"),
      },
    }),
    v("json", PublicUpdateFederatedDraftSchema),
    async (c) => {
      const tableId = internalIdParam(c, "tableId")!;
      const target = await gridsService.table.get(tableId);
      if (!target || target.kind !== "federated") return c.json({ message: apiMessages(c).combinedTableNotFound }, 404);
      const targetGate = await gateAt(c, { baseId: target.baseId }, "admin");
      if (!targetGate.ok) return respond(c, () => Promise.resolve(targetGate));
      const { draftToken, ...body } = c.req.valid("json");
      const internal = await fromPublicFederatedDraft(body);
      if (!internal.ok) return respond(c, () => Promise.resolve(internal));
      const sourceGate = await requireSourceBaseAdmins(c, internal.data.sourceTableIds);
      if (sourceGate.response) return sourceGate.response;
      const draft = await gridsService.table.federation.getDraft(tableId);
      if (!draft) return c.json({ message: apiMessages(c).combinedTableDraftNotFound }, 404);
      const administeredSources = await sourceTablesAdministeredByActor(c, [draft]);
      const result = await gridsService.table.federation.updateDraft(
        tableId,
        retainUnadministeredDraftSources(internal.data, draft, administeredSources),
        draftToken,
        currentActorUserId(c),
        publicationAuthorization(c),
        getLocale(c),
      );
      if (!result.ok) return respond(c, () => Promise.resolve(result));
      const administeredUpdatedSources = await sourceTablesAdministeredByActor(c, [result.data]);
      return c.json(await toPublicFederatedRevision(result.data, administeredUpdatedSources));
    },
  )

  .post(
    "/:tableId/federation/validate",
    requirePublicIdParam("tableId", "table", "Combined table"),
    describeRoute({
      tags: ["Grids:Table"],
      summary: "Validate a combined table draft without saving it",
      responses: {
        200: jsonResponse(PublicFederatedValidationSchema, "Draft validation"),
        400: jsonResponse(ErrorResponseSchema, "Invalid draft"),
        403: jsonResponse(ErrorResponseSchema, "Forbidden"),
        404: jsonResponse(ErrorResponseSchema, "Not found"),
      },
    }),
    v("json", PublicFederatedDraftInputSchema),
    async (c) => {
      const tableId = internalIdParam(c, "tableId")!;
      const target = await gridsService.table.get(tableId);
      if (!target || target.kind !== "federated") return c.json({ message: apiMessages(c).combinedTableNotFound }, 404);
      const targetGate = await gateAt(c, { baseId: target.baseId }, "admin");
      if (!targetGate.ok) return respond(c, () => Promise.resolve(targetGate));
      const body = c.req.valid("json");
      const internal = await fromPublicFederatedDraft(body);
      if (!internal.ok) return respond(c, () => Promise.resolve(internal));
      const sourceGate = await requireSourceBaseAdmins(c, internal.data.sourceTableIds);
      if (sourceGate.response) return sourceGate.response;
      const draft = await gridsService.table.federation.getDraft(tableId);
      const administeredSources = await sourceTablesAdministeredByActor(c, [draft]);
      const validation = await gridsService.table.federation.validateDraft(
        tableId,
        draft ? retainUnadministeredDraftSources(internal.data, draft, administeredSources) : internal.data,
        getLocale(c),
      );
      return c.json({ ...validation, diagnostics: await toPublicFederatedDiagnostics(validation.diagnostics, administeredSources) });
    },
  )

  .post(
    "/:tableId/federation/publish",
    requirePublicIdParam("tableId", "table", "Combined table"),
    describeRoute({
      tags: ["Grids:Table"],
      summary: "Publish combined table draft",
      responses: {
        200: jsonResponse(PublicFederatedRevisionViewSchema, "Published revision"),
        400: jsonResponse(ErrorResponseSchema, "Invalid draft"),
        403: jsonResponse(ErrorResponseSchema, "Forbidden"),
        404: jsonResponse(ErrorResponseSchema, "Not found"),
        409: jsonResponse(ErrorResponseSchema, "Configuration changed"),
      },
    }),
    async (c) => {
      const tableId = internalIdParam(c, "tableId")!;
      const target = await gridsService.table.get(tableId);
      if (!target || target.kind !== "federated") return c.json({ message: apiMessages(c).combinedTableNotFound }, 404);
      const targetGate = await gateAt(c, { baseId: target.baseId }, "admin");
      if (!targetGate.ok) return respond(c, () => Promise.resolve(targetGate));
      const draft = await gridsService.table.federation.getDraft(tableId);
      if (!draft) return c.json({ message: apiMessages(c).combinedTableDraftNotFound }, 404);
      const current = await gridsService.table.federation.getCurrent(tableId);
      const sourceGate = await requireSourceBaseAdmins(
        c,
        gridsService.table.federation.sourceIdsRequiringAuthorization(current, {
          sourceTableIds: draft.sources.map((source) => source.sourceTableId),
          mappings: draft.mappings.map((mapping) => ({
            targetFieldId: mapping.targetFieldId,
            sourceTableId: mapping.sourceTableId,
            sourceFieldId: mapping.sourceFieldId,
            config: mapping.config,
          })),
        }),
      );
      if (sourceGate.response) return sourceGate.response;
      const result = await gridsService.table.federation.publishDraft(
        tableId,
        currentActorUserId(c),
        publicationAuthorization(c),
        {
          draftId: draft.id,
          draftToken: draft.revisionToken,
          currentId: current?.id ?? null,
          currentToken: current?.revisionToken ?? null,
        },
        getLocale(c),
      );
      if (!result.ok) return respond(c, () => Promise.resolve(result));
      const administeredSources = await sourceTablesAdministeredByActor(c, [result.data]);
      return c.json(await toPublicFederatedRevision(result.data, administeredSources));
    },
  )

  .post(
    "/:tableId/federation/sources/:sourceTableId/revoke",
    requirePublicIdParam("tableId", "table", "Combined table"),
    requirePublicIdParam("sourceTableId", "table", "Source table"),
    describeRoute({
      tags: ["Grids:Table"],
      summary: "Revoke a published combined table source",
      responses: {
        204: { description: "Source access revoked" },
        403: jsonResponse(ErrorResponseSchema, "Forbidden"),
        404: jsonResponse(ErrorResponseSchema, "Not found"),
        409: jsonResponse(ErrorResponseSchema, "Configuration changed"),
      },
    }),
    async (c) => {
      const tableId = internalIdParam(c, "tableId")!;
      const sourceTableId = internalIdParam(c, "sourceTableId")!;
      const source = await gridsService.table.get(sourceTableId, { includeDeleted: true });
      if (!source) return c.json({ message: apiMessages(c).sourceTableNotFound }, 404);
      const sourceGate = await gateAt(c, { baseId: source.baseId }, "admin");
      if (!sourceGate.ok) return respond(c, () => Promise.resolve(sourceGate));
      const result = await gridsService.table.federation.revokeSource(
        tableId,
        sourceTableId,
        currentActorUserId(c),
        publicationAuthorization(c),
        getLocale(c),
      );
      if (!result.ok) return c.json({ message: result.error.message }, result.error.status);
      return c.body(null, 204);
    },
  )

  // List tables of a base.
  .get(
    "/by-base/:baseId/admin-overview",
    requirePublicIdParam("baseId", "base", "Base"),
    describeRoute({
      tags: ["Grids:Table"],
      summary: "List Table administration summaries for a Base",
      responses: {
        200: jsonResponse(PublicTableAdminOverviewPageSchema, "Table administration summaries"),
        403: jsonResponse(ErrorResponseSchema, "Forbidden"),
        404: jsonResponse(ErrorResponseSchema, "Not found"),
      },
    }),
    v("query", PublicTableAdminOverviewQuerySchema),
    async (c) => {
      const baseId = internalIdParam(c, "baseId")!;
      const gate = await gateAt(c, { baseId }, "admin");
      if (!gate.ok) return respond(c, () => Promise.resolve(gate));
      return c.json(await toPublicTableAdminOverview(await gridsService.table.adminOverview.list(baseId, c.req.valid("query"))));
    },
  )

  // List tables of a base.
  .get(
    "/by-base/:baseId",
    requirePublicIdParam("baseId", "base", "Base"),
    describeRoute({
      tags: ["Grids:Table"],
      summary: "List tables in a base",
      responses: {
        200: jsonResponse(PublicTableListSchema, "Tables"),
        403: jsonResponse(ErrorResponseSchema, "Forbidden"),
        404: jsonResponse(ErrorResponseSchema, "Not found"),
      },
    }),
    v("query", TablesByBaseQuerySchema),
    async (c) => {
      const baseId = internalIdParam(c, "baseId")!;
      const gate = await gateAt(c, { baseId }, "read");
      if (!gate.ok) return respond(c, () => Promise.resolve(gate));
      const query = c.req.valid("query");
      return c.json(
        await toPublicTables(
          await gridsService.table.listByBase(baseId, { search: query.q, limit: query.limit ?? (query.q ? 100 : undefined) }),
        ),
      );
    },
  )

  // Create table under a base.
  .post(
    "/by-base/:baseId",
    requirePublicIdParam("baseId", "base", "Base"),
    describeRoute({
      tags: ["Grids:Table"],
      summary: "Create a table",
      responses: {
        201: jsonResponse(PublicTableSchema, "Created"),
        400: jsonResponse(ErrorResponseSchema, "Invalid input"),
        403: jsonResponse(ErrorResponseSchema, "Forbidden"),
        404: jsonResponse(ErrorResponseSchema, "Not found"),
        409: jsonResponse(ErrorResponseSchema, "Conflict"),
      },
    }),
    v("json", PublicCreateTableSchema),
    async (c) => {
      const baseId = internalIdParam(c, "baseId")!;
      const gate = await gateAt(c, { baseId }, "admin");
      if (!gate.ok) return respond(c, () => Promise.resolve(gate));
      const body = c.req.valid("json");
      const converted = await fromPublicCreateTable(body);
      if (!converted.ok) return c.json({ message: converted.error.message }, converted.error.status);
      const result = await gridsService.table.create(
        {
          baseId,
          ...converted.data,
          description: converted.data.description ?? null,
          icon: converted.data.icon ?? null,
        },
        currentActorUserId(c),
        getLocale(c),
      );
      return result.ok ? c.json(await toPublicTable(result.data), 201) : c.json({ message: result.error.message }, result.error.status);
    },
  )

  .post(
    "/:tableId/mutation-policy/impact",
    requirePublicIdParam("tableId", "table", "Table"),
    describeRoute({
      tags: ["Grids:Table"],
      summary: "Preview resources affected by a table mutation policy",
      responses: {
        200: jsonResponse(PublicMutationPolicyImpactSchema, "Mutation policy impact"),
        400: jsonResponse(ErrorResponseSchema, "Invalid policy or unsupported table"),
        403: jsonResponse(ErrorResponseSchema, "Forbidden"),
        404: jsonResponse(ErrorResponseSchema, "Not found"),
      },
    }),
    v("json", PublicMutationPolicyInputSchema),
    async (c) => {
      const tableId = internalIdParam(c, "tableId")!;
      const table = await gridsService.table.get(tableId);
      if (!table) return c.json({ message: apiMessages(c).tableNotFound }, 404);
      if (table.kind !== "stored") return c.json({ message: apiMessages(c).mutationPolicyStoredOnly }, 400);
      const gate = await gateAt(c, { baseId: table.baseId }, "admin");
      if (!gate.ok) return respond(c, () => Promise.resolve(gate));
      const result = await gridsService.table.mutationPolicy.getImpact(tableId, c.req.valid("json").policy, { locale: getLocale(c) });
      return result.ok ? c.json(result.data) : respond(c, () => Promise.resolve(result));
    },
  )

  .put(
    "/:tableId/mutation-policy",
    requirePublicIdParam("tableId", "table", "Table"),
    describeRoute({
      tags: ["Grids:Table"],
      summary: "Update a table mutation policy",
      responses: {
        200: jsonResponse(PublicMutationPolicyResponseSchema, "Updated mutation policy"),
        400: jsonResponse(ErrorResponseSchema, "Invalid policy or unsupported table"),
        403: jsonResponse(ErrorResponseSchema, "Forbidden"),
        404: jsonResponse(ErrorResponseSchema, "Not found"),
      },
    }),
    v("json", PublicMutationPolicyUpdateSchema),
    async (c) => {
      const tableId = internalIdParam(c, "tableId")!;
      const table = await gridsService.table.get(tableId);
      if (!table) return c.json({ message: apiMessages(c).tableNotFound }, 404);
      if (table.kind !== "stored") return c.json({ message: apiMessages(c).mutationPolicyStoredOnly }, 400);
      const gate = await gateAt(c, { baseId: table.baseId }, "admin");
      if (!gate.ok) return respond(c, () => Promise.resolve(gate));
      const result = await gridsService.table.mutationPolicy.update(
        tableId,
        c.req.valid("json").policy,
        currentActorUserId(c),
        getLocale(c),
      );
      return result.ok ? c.json({ policy: result.data }) : respond(c, () => Promise.resolve(result));
    },
  )

  .get(
    "/:tableId/durable-history",
    requirePublicIdParam("tableId", "table", "Table"),
    describeRoute({
      tags: ["Grids:Table"],
      summary: "Get durable history activation status",
      responses: {
        200: jsonResponse(PublicDurableHistoryStatusSchema, "Durable history status"),
        400: jsonResponse(ErrorResponseSchema, "Unsupported table"),
        403: jsonResponse(ErrorResponseSchema, "Forbidden"),
        404: jsonResponse(ErrorResponseSchema, "Not found"),
      },
    }),
    async (c) => {
      const tableId = internalIdParam(c, "tableId")!;
      const table = await gridsService.table.get(tableId);
      if (!table) return c.json({ message: apiMessages(c).tableNotFound }, 404);
      const gate = await gateAt(c, { baseId: table.baseId }, "admin");
      if (!gate.ok) return respond(c, () => Promise.resolve(gate));
      const result = await gridsService.table.durableHistory.getStatus(tableId, getLocale(c));
      return result.ok ? c.json(toPublicDurableHistoryStatus(result.data)) : c.json({ message: result.error.message }, result.error.status);
    },
  )

  .post(
    "/:tableId/durable-history/enable",
    requirePublicIdParam("tableId", "table", "Table"),
    describeRoute({
      tags: ["Grids:Table"],
      summary: "Irreversibly enable durable history",
      responses: {
        200: jsonResponse(PublicDurableHistoryStatusSchema, "Durable history activation status"),
        400: jsonResponse(ErrorResponseSchema, "Unsupported table"),
        403: jsonResponse(ErrorResponseSchema, "Forbidden"),
        404: jsonResponse(ErrorResponseSchema, "Not found"),
      },
    }),
    async (c) => {
      const tableId = internalIdParam(c, "tableId")!;
      const table = await gridsService.table.get(tableId);
      if (!table) return c.json({ message: apiMessages(c).tableNotFound }, 404);
      const gate = await gateAt(c, { baseId: table.baseId }, "admin");
      if (!gate.ok) return respond(c, () => Promise.resolve(gate));
      const result = await gridsService.table.durableHistory.enable(tableId, currentActorUserId(c), getLocale(c));
      return result.ok ? c.json(toPublicDurableHistoryStatus(result.data)) : c.json({ message: result.error.message }, result.error.status);
    },
  )

  .post(
    "/:tableId/durable-history/continue",
    requirePublicIdParam("tableId", "table", "Table"),
    describeRoute({
      tags: ["Grids:Table"],
      summary: "Continue a durable history baseline",
      responses: {
        200: jsonResponse(PublicDurableHistoryStatusSchema, "Durable history activation status"),
        400: jsonResponse(ErrorResponseSchema, "Not enabled"),
        403: jsonResponse(ErrorResponseSchema, "Forbidden"),
        404: jsonResponse(ErrorResponseSchema, "Not found"),
      },
    }),
    async (c) => {
      const tableId = internalIdParam(c, "tableId")!;
      const table = await gridsService.table.get(tableId);
      if (!table) return c.json({ message: apiMessages(c).tableNotFound }, 404);
      const gate = await gateAt(c, { baseId: table.baseId }, "admin");
      if (!gate.ok) return respond(c, () => Promise.resolve(gate));
      const result = await gridsService.table.durableHistory.continueActivation(tableId, getLocale(c));
      return result.ok ? c.json(toPublicDurableHistoryStatus(result.data)) : c.json({ message: result.error.message }, result.error.status);
    },
  )

  .get(
    "/:tableId/finalization",
    requirePublicIdParam("tableId", "table", "Table"),
    describeRoute({
      tags: ["Grids:Table"],
      summary: "Get record finalization status",
      responses: {
        200: jsonResponse(PublicRecordFinalizationStatusSchema, "Record finalization status"),
        400: jsonResponse(ErrorResponseSchema, "Unsupported table"),
        403: jsonResponse(ErrorResponseSchema, "Forbidden"),
        404: jsonResponse(ErrorResponseSchema, "Not found"),
      },
    }),
    async (c) => {
      const tableId = internalIdParam(c, "tableId")!;
      const table = await gridsService.table.get(tableId);
      if (!table) return c.json({ message: apiMessages(c).tableNotFound }, 404);
      const gate = await gateAt(c, { baseId: table.baseId }, "admin");
      if (!gate.ok) return respond(c, () => Promise.resolve(gate));
      const result = await gridsService.table.finalization.getStatus(tableId, undefined, getLocale(c));
      return result.ok ? c.json(toPublicRecordFinalizationStatus(result.data)) : respond(c, () => Promise.resolve(result));
    },
  )

  .post(
    "/:tableId/finalization/enable",
    requirePublicIdParam("tableId", "table", "Table"),
    v("json", PublicFinalizationPolicyInputSchema),
    describeRoute({
      tags: ["Grids:Table"],
      summary: "Enable record finalization",
      responses: {
        200: jsonResponse(PublicRecordFinalizationStatusSchema, "Record finalization status"),
        400: jsonResponse(ErrorResponseSchema, "Durable History prerequisite not met"),
        403: jsonResponse(ErrorResponseSchema, "Forbidden"),
        404: jsonResponse(ErrorResponseSchema, "Not found"),
        409: jsonResponse(ErrorResponseSchema, "Already enabled with another policy"),
      },
    }),
    async (c) => {
      const tableId = internalIdParam(c, "tableId")!;
      const table = await gridsService.table.get(tableId);
      if (!table) return c.json({ message: apiMessages(c).tableNotFound }, 404);
      const gate = await gateAt(c, { baseId: table.baseId }, "admin");
      if (!gate.ok) return respond(c, () => Promise.resolve(gate));
      const result = await recordFinalizationService.enable(tableId, c.req.valid("json"), currentActorUserId(c), getLocale(c));
      return result.ok ? c.json(toPublicRecordFinalizationStatus(result.data)) : respond(c, () => Promise.resolve(result));
    },
  )

  .post(
    "/:tableId/finalization/disable",
    requirePublicIdParam("tableId", "table", "Table"),
    describeRoute({
      tags: ["Grids:Table"],
      summary: "Disable record finalization before first use",
      responses: {
        200: jsonResponse(PublicRecordFinalizationStatusSchema, "Record finalization status"),
        403: jsonResponse(ErrorResponseSchema, "Forbidden"),
        404: jsonResponse(ErrorResponseSchema, "Not found"),
        409: jsonResponse(ErrorResponseSchema, "Finalization is permanent after first use"),
      },
    }),
    async (c) => {
      const tableId = internalIdParam(c, "tableId")!;
      const table = await gridsService.table.get(tableId);
      if (!table) return c.json({ message: apiMessages(c).tableNotFound }, 404);
      const gate = await gateAt(c, { baseId: table.baseId }, "admin");
      if (!gate.ok) return respond(c, () => Promise.resolve(gate));
      const result = await recordFinalizationService.disable(tableId, currentActorUserId(c), getLocale(c));
      return result.ok ? c.json(toPublicRecordFinalizationStatus(result.data)) : respond(c, () => Promise.resolve(result));
    },
  )

  .put(
    "/:tableId/finalization/policy",
    requirePublicIdParam("tableId", "table", "Table"),
    v("json", PublicFinalizationPolicyInputSchema),
    describeRoute({
      tags: ["Grids:Table"],
      summary: "Choose Direct or Four-eyes Record Finalization",
      responses: {
        200: jsonResponse(PublicRecordFinalizationStatusSchema, "Record finalization status"),
        400: jsonResponse(ErrorResponseSchema, "Invalid Finalization policy"),
        403: jsonResponse(ErrorResponseSchema, "Forbidden"),
        404: jsonResponse(ErrorResponseSchema, "Not found"),
      },
    }),
    async (c) => {
      const tableId = internalIdParam(c, "tableId")!;
      const table = await gridsService.table.get(tableId);
      if (!table) return c.json({ message: apiMessages(c).tableNotFound }, 404);
      const gate = await gateAt(c, { baseId: table.baseId }, "admin");
      if (!gate.ok) return respond(c, () => Promise.resolve(gate));
      const result = await recordFinalizationService.setPolicy(tableId, c.req.valid("json"), currentActorUserId(c), getLocale(c));
      return result.ok ? c.json(toPublicRecordFinalizationStatus(result.data)) : respond(c, () => Promise.resolve(result));
    },
  )

  .get(
    "/:tableId",
    requirePublicIdParam("tableId", "table", "Table"),
    describeRoute({
      tags: ["Grids:Table"],
      summary: "Get table",
      responses: {
        200: jsonResponse(PublicTableSchema, "Table"),
        403: jsonResponse(ErrorResponseSchema, "Forbidden"),
        404: jsonResponse(ErrorResponseSchema, "Not found"),
      },
    }),
    async (c) => {
      const tableId = internalIdParam(c, "tableId")!;
      const table = await gridsService.table.get(tableId);
      if (!table) return c.json({ message: apiMessages(c).tableNotFound }, 404);
      const gate = await gateAt(c, { baseId: table.baseId }, "read");
      if (!gate.ok) return respond(c, () => Promise.resolve(gate));
      return c.json(await toPublicTable(table));
    },
  )

  .patch(
    "/:tableId",
    requirePublicIdParam("tableId", "table", "Table"),
    describeRoute({
      tags: ["Grids:Table"],
      summary: "Update table",
      responses: {
        200: jsonResponse(PublicTableSchema, "Updated"),
        400: jsonResponse(ErrorResponseSchema, "Invalid input"),
        403: jsonResponse(ErrorResponseSchema, "Forbidden"),
        404: jsonResponse(ErrorResponseSchema, "Not found"),
        409: jsonResponse(ErrorResponseSchema, "Conflict"),
      },
    }),
    v("json", PublicUpdateTableSchema),
    async (c) => {
      const tableId = internalIdParam(c, "tableId")!;
      const table = await gridsService.table.get(tableId);
      if (!table) return c.json({ message: apiMessages(c).tableNotFound }, 404);
      const gate = await gateAt(c, { baseId: table.baseId }, "admin");
      if (!gate.ok) return respond(c, () => Promise.resolve(gate));
      const converted = await fromPublicUpdateTable(tableId, c.req.valid("json"));
      if (!converted.ok) return c.json({ message: converted.error.message }, converted.error.status);
      const result = await gridsService.table.update(tableId, converted.data, currentActorUserId(c));
      return result.ok ? c.json(await toPublicTable(result.data)) : c.json({ message: result.error.message }, result.error.status);
    },
  )

  .delete(
    "/:tableId",
    requirePublicIdParam("tableId", "table", "Table"),
    describeRoute({
      tags: ["Grids:Table"],
      summary: "Move a table to trash",
      responses: {
        204: { description: "Moved to trash" },
        403: jsonResponse(ErrorResponseSchema, "Forbidden"),
        404: jsonResponse(ErrorResponseSchema, "Not found"),
      },
    }),
    async (c) => {
      const tableId = internalIdParam(c, "tableId")!;
      const table = await gridsService.table.get(tableId);
      if (!table) return c.json({ message: apiMessages(c).tableNotFound }, 404);
      const gate = await gateAt(c, { baseId: table.baseId }, "admin");
      if (!gate.ok) return respond(c, () => Promise.resolve(gate));
      const result = await gridsService.table.remove(tableId, currentActorUserId(c));
      if (!result.ok) return c.json({ message: result.error.message }, result.error.status);
      return c.body(null, 204);
    },
  )

  .post(
    "/:tableId/restore",
    requireStoredPublicIdParam("tableId", "table", "Table"),
    describeRoute({
      tags: ["Grids:Table"],
      summary: "Restore a soft-deleted table",
      responses: {
        200: jsonResponse(PublicTableSchema, "Restored"),
        403: jsonResponse(ErrorResponseSchema, "Forbidden"),
        404: jsonResponse(ErrorResponseSchema, "Not found"),
        409: jsonResponse(ErrorResponseSchema, "Conflict"),
      },
    }),
    async (c) => {
      const tableId = internalIdParam(c, "tableId")!;
      const table = await gridsService.table.get(tableId, { includeDeleted: true });
      if (!table) return c.json({ message: apiMessages(c).tableNotFound }, 404);
      const gate = await gateAt(c, { baseId: table.baseId }, "admin");
      if (!gate.ok) return respond(c, () => Promise.resolve(gate));
      const result = await gridsService.table.restore(tableId, currentActorUserId(c));
      return result.ok ? c.json(await toPublicTable(result.data)) : c.json({ message: result.error.message }, result.error.status);
    },
  )

  .route("/", tableQueryRoutes)

  .get(
    "/:tableId/record-actors",
    requirePublicIdParam("tableId", "table", "Table"),
    describeRoute({
      tags: ["Grids:Table"],
      summary: "Search users available for record metadata filters",
      responses: {
        200: jsonResponse(RecordActorListResponseSchema, "Record actors"),
        403: jsonResponse(ErrorResponseSchema, "Forbidden"),
        404: jsonResponse(ErrorResponseSchema, "Table not found"),
      },
    }),
    v(
      "query",
      z.object({
        kind: z
          .union([RecordMetaUserKeySchema, z.literal("any")])
          .optional()
          .default("any"),
        q: z.string().optional().default(""),
        ids: z
          .string()
          .optional()
          .default("")
          .transform((s) =>
            s
              .split(",")
              .map((p) => p.trim())
              .filter(Boolean),
          )
          .pipe(z.array(z.string().uuid()).max(50)),
        limit: z.coerce.number().int().min(1).max(50).optional().default(12),
      }),
    ),
    async (c) => {
      const tableId = internalIdParam(c, "tableId")!;
      const table = await gridsService.table.get(tableId);
      if (!table) return c.json({ message: apiMessages(c).tableNotFound }, 404);
      const gate = await gateAt(c, { baseId: table.baseId }, "read");
      if (!gate.ok) return respond(c, () => Promise.resolve(gate));

      const { kind, q, ids, limit } = c.req.valid("query");
      const items = await gridsService.record.listActors({ tableId, kind, q, ids, limit });
      return c.json({ items });
    },
  )

  // Relation-picker search. Returns up to N records of the target table,
  // pre-labelled, so the client doesn't need to know about `presentable`.
  // Permission: needs `read` on the target table — same as listing it.
  .get(
    "/:tableId/lookup",
    requirePublicIdParam("tableId", "table", "Table"),
    describeRoute({
      tags: ["Grids:Table"],
      summary: "Search records of this table for the relation picker",
      responses: {
        200: jsonResponse(PublicRelationLookupResponseSchema, "Lookup results"),
        400: jsonResponse(ErrorResponseSchema, "Invalid query"),
        403: jsonResponse(ErrorResponseSchema, "Forbidden"),
        404: jsonResponse(ErrorResponseSchema, "Table not found"),
      },
    }),
    // Zod coerces and validates lookup params up front so invalid
    // limits and UUID lists surface as clean 400s.
    v(
      "query",
      z.object({
        q: z.string().optional().default(""),
        limit: z.coerce.number().int().min(1).max(50).optional().default(10),
        includeDeleted: z.enum(["true"]).optional(),
        excludeIds: z
          .string()
          .optional()
          .default("")
          .transform((s) =>
            s
              .split(",")
              .map((p) => p.trim())
              .filter(Boolean),
          )
          .pipe(z.array(ShortIdSchema)),
      }),
    ),
    async (c) => {
      const tableId = internalIdParam(c, "tableId")!;
      const table = await gridsService.table.get(tableId);
      if (!table) return c.json({ message: apiMessages(c).tableNotFound }, 404);
      const access = await gateAt(c, { baseId: table.baseId }, "read");
      if (!access.ok) return respond(c, () => Promise.resolve(access));

      const { q, limit, excludeIds, includeDeleted } = c.req.valid("query");
      const excluded = await resolvePublicIds("record", excludeIds);
      if (excluded.size !== new Set(excludeIds).size) return c.json({ message: apiMessages(c).unknownExcludedRecord }, 400);

      const result = await gridsService.relations.lookup({
        targetTableId: tableId,
        q,
        limit,
        excludeIds: excludeIds.map((id) => excluded.get(id)!),
        includeDeleted: includeDeleted === "true",
      });
      const publicIds = await projectPublicIds(
        "record",
        result.items.map((item) => item.id),
      );
      return c.json({ items: result.items.map((item) => ({ ...item, id: publicIds.get(item.id)! })) });
    },
  );

const app = new Hono<AuthContext>().use(auth.requireRole("authenticated")).route("/", tablesRoutes);
export default app;
