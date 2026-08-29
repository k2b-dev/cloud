import { ErrorResponseSchema } from "@valentinkolb/cloud/contracts";
import { type AuthContext, getLocale, jsonResponse, respond } from "@valentinkolb/cloud/server";
import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { CreateDocumentTemplateSchema, UpdateDocumentTemplateSchema } from "../contracts";
import { gridsService } from "../service";
import { resolvePublicIds } from "../service/public-resources";
import { ALL_RECORD_ACCESS } from "../service/record-access";
import {
  DocumentTemplateSummaryQuerySchema,
  gateEnabledTemplateWrite,
  gateTemplate,
  loadTemplateAndTable,
  PublicDocumentTemplateListSchema,
  PublicDocumentTemplateSchema,
  PublicDocumentTemplateSummaryListSchema,
  PublicRelationLookupResponseSchema,
  PublicReorderDocumentTemplatesSchema,
  projectDocumentTemplateSummaries,
  projectDocumentTemplates,
  projectRelationLookup,
  RecordLookupQuerySchema,
} from "./documents-api-shared";
import { apiMessages } from "./messages";
import { currentActorUserId, gateAt } from "./permissions";
import { resolvePublicIdParam, resolveStoredPublicIdParam } from "./route-params";
import { v } from "./validator";

export const createDocumentTemplateRoutes = () =>
  new Hono<AuthContext>()
    .get(
      "/templates/by-table/:tableId",
      describeRoute({
        tags: ["Grids:Document"],
        summary: "List document templates for a table",
        responses: {
          200: jsonResponse(PublicDocumentTemplateSummaryListSchema, "Document templates"),
          403: jsonResponse(ErrorResponseSchema, "Forbidden"),
        },
      }),
      v("query", DocumentTemplateSummaryQuerySchema),
      async (c) => {
        const tableId = await resolvePublicIdParam(c, "tableId", "table");
        if (!tableId) return c.json({ message: apiMessages(c).tableNotFound }, 404);
        const table = await gridsService.table.get(tableId);
        if (!table) return c.json({ message: apiMessages(c).tableNotFound }, 404);
        const tableGate = await gateAt(c, { baseId: table.baseId }, c.req.valid("query").min);
        if (!tableGate.ok) return respond(c, () => Promise.resolve(tableGate));
        const templates = await gridsService.document.listTemplatesForTable(tableId);
        return c.json(await projectDocumentTemplateSummaries(templates));
      },
    )

    .get(
      "/templates/by-table/:tableId/full",
      describeRoute({
        tags: ["Grids:Document"],
        summary: "List full document templates for table admins",
        responses: {
          200: jsonResponse(PublicDocumentTemplateListSchema, "Document templates"),
          403: jsonResponse(ErrorResponseSchema, "Forbidden"),
        },
      }),
      async (c) => {
        const tableId = await resolvePublicIdParam(c, "tableId", "table");
        if (!tableId) return c.json({ message: apiMessages(c).tableNotFound }, 404);
        const table = await gridsService.table.get(tableId);
        if (!table) return c.json({ message: apiMessages(c).tableNotFound }, 404);
        const gate = await gateAt(c, { baseId: table.baseId }, "admin");
        if (!gate.ok) return respond(c, () => Promise.resolve(gate));
        return c.json(await projectDocumentTemplates(await gridsService.document.listTemplatesForTable(tableId)));
      },
    )

    .post(
      "/templates/by-table/:tableId",
      describeRoute({
        tags: ["Grids:Document"],
        summary: "Create a document template",
        responses: {
          201: jsonResponse(PublicDocumentTemplateSchema, "Created document template"),
          403: jsonResponse(ErrorResponseSchema, "Forbidden"),
        },
      }),
      v("json", CreateDocumentTemplateSchema),
      async (c) => {
        const tableId = await resolvePublicIdParam(c, "tableId", "table");
        if (!tableId) return c.json({ message: apiMessages(c).tableNotFound }, 404);
        const table = await gridsService.table.get(tableId);
        if (!table) return c.json({ message: apiMessages(c).tableNotFound }, 404);
        const gate = await gateAt(c, { baseId: table.baseId }, "admin");
        if (!gate.ok) return respond(c, () => Promise.resolve(gate));
        const created = await gridsService.document.createTemplate(tableId, c.req.valid("json"), currentActorUserId(c), getLocale(c));
        if (!created.ok) return c.json({ message: created.error.message }, created.error.status);
        return c.json((await projectDocumentTemplates([created.data]))[0]!, 201);
      },
    )

    .patch(
      "/templates/by-table/:tableId/reorder",
      describeRoute({
        tags: ["Grids:Document"],
        summary: "Reorder document templates",
        responses: {
          204: { description: "Document templates reordered" },
          403: jsonResponse(ErrorResponseSchema, "Forbidden"),
          409: jsonResponse(ErrorResponseSchema, "Template list changed"),
        },
      }),
      v("json", PublicReorderDocumentTemplatesSchema),
      async (c) => {
        const tableId = await resolvePublicIdParam(c, "tableId", "table");
        if (!tableId) return c.json({ message: apiMessages(c).tableNotFound }, 404);
        const table = await gridsService.table.get(tableId);
        if (!table) return c.json({ message: apiMessages(c).tableNotFound }, 404);
        const gate = await gateAt(c, { baseId: table.baseId }, "admin");
        if (!gate.ok) return respond(c, () => Promise.resolve(gate));
        const publicTemplateIds = c.req.valid("json").templateIds;
        const resolvedTemplateIds = await resolvePublicIds("documentTemplate", publicTemplateIds);
        if (resolvedTemplateIds.size !== publicTemplateIds.length) return c.json({ message: apiMessages(c).documentTemplateNotFound }, 404);
        const result = await gridsService.document.reorderTemplates(
          tableId,
          publicTemplateIds.map((id) => resolvedTemplateIds.get(id)!),
          currentActorUserId(c),
          getLocale(c),
        );
        if (!result.ok) return c.json({ message: result.error.message }, result.error.status);
        return c.body(null, 204);
      },
    )

    .get(
      "/templates/:templateId",
      describeRoute({
        tags: ["Grids:Document"],
        summary: "Get a document template",
        responses: {
          200: jsonResponse(PublicDocumentTemplateSchema, "Document template"),
          403: jsonResponse(ErrorResponseSchema, "Forbidden"),
        },
      }),
      async (c) => {
        const loaded = await loadTemplateAndTable(c.req.param("templateId")!);
        if (!loaded) return c.json({ message: apiMessages(c).documentTemplateNotFound }, 404);
        const gate = await gateTemplate(c, loaded, "admin");
        if (!gate.ok) return respond(c, () => Promise.resolve(gate));
        return c.json((await projectDocumentTemplates([loaded.template]))[0]!);
      },
    )

    .patch(
      "/templates/:templateId",
      describeRoute({
        tags: ["Grids:Document"],
        summary: "Update a document template",
        responses: {
          200: jsonResponse(PublicDocumentTemplateSchema, "Updated document template"),
          403: jsonResponse(ErrorResponseSchema, "Forbidden"),
        },
      }),
      v("json", UpdateDocumentTemplateSchema),
      async (c) => {
        const loaded = await loadTemplateAndTable(c.req.param("templateId")!);
        if (!loaded) return c.json({ message: apiMessages(c).documentTemplateNotFound }, 404);
        const gate = await gateTemplate(c, loaded, "admin");
        if (!gate.ok) return respond(c, () => Promise.resolve(gate));
        const updated = await gridsService.document.updateTemplate(
          loaded.template.id,
          c.req.valid("json"),
          currentActorUserId(c),
          getLocale(c),
        );
        if (!updated.ok) return c.json({ message: updated.error.message }, updated.error.status);
        return c.json((await projectDocumentTemplates([updated.data]))[0]!);
      },
    )

    .delete(
      "/templates/:templateId",
      describeRoute({
        tags: ["Grids:Document"],
        summary: "Delete a document template",
        responses: {
          204: { description: "Deleted" },
          403: jsonResponse(ErrorResponseSchema, "Forbidden"),
        },
      }),
      async (c) => {
        const loaded = await loadTemplateAndTable(c.req.param("templateId")!);
        if (!loaded) return c.json({ message: apiMessages(c).documentTemplateNotFound }, 404);
        const gate = await gateTemplate(c, loaded, "admin");
        if (!gate.ok) return respond(c, () => Promise.resolve(gate));
        const result = await gridsService.document.removeTemplate(loaded.template.id, currentActorUserId(c), getLocale(c));
        if (!result.ok) return c.json({ message: result.error.message }, result.error.status);
        return c.body(null, 204);
      },
    )

    .post(
      "/templates/:templateId/restore",
      describeRoute({
        tags: ["Grids:Document"],
        summary: "Restore a soft-deleted document template",
        responses: {
          200: jsonResponse(PublicDocumentTemplateSchema, "Restored document template"),
          403: jsonResponse(ErrorResponseSchema, "Forbidden"),
          404: jsonResponse(ErrorResponseSchema, "Not found"),
        },
      }),
      async (c) => {
        const templateId = await resolveStoredPublicIdParam(c, "templateId", "documentTemplate");
        if (!templateId) return c.json({ message: apiMessages(c).documentTemplateNotFound }, 404);
        const template = await gridsService.document.getStoredTemplate(templateId);
        if (!template) return c.json({ message: apiMessages(c).documentTemplateNotFound }, 404);
        const table = await gridsService.table.get(template.tableId);
        if (!table) return c.json({ message: apiMessages(c).tableNotFound }, 404);
        const gate = await gateAt(c, { baseId: table.baseId }, "admin");
        if (!gate.ok) return respond(c, () => Promise.resolve(gate));
        const restored = await gridsService.document.restoreTemplate(templateId, currentActorUserId(c), getLocale(c));
        if (!restored.ok) return c.json({ message: restored.error.message }, restored.error.status);
        return c.json((await projectDocumentTemplates([restored.data]))[0]!);
      },
    )

    .get(
      "/templates/:templateId/records/lookup",
      describeRoute({
        tags: ["Grids:Document"],
        summary: "Search records for a document template",
        responses: {
          200: jsonResponse(PublicRelationLookupResponseSchema, "Lookup results"),
          403: jsonResponse(ErrorResponseSchema, "Forbidden"),
        },
      }),
      v("query", RecordLookupQuerySchema),
      async (c) => {
        const loaded = await loadTemplateAndTable(c.req.param("templateId")!);
        if (!loaded) return c.json({ message: apiMessages(c).documentTemplateNotFound }, 404);
        const gate = await gateEnabledTemplateWrite(c, loaded);
        if (!gate.ok) return respond(c, () => Promise.resolve(gate));
        const { q, limit, excludeIds: publicExcludeIds } = c.req.valid("query");
        const excludeIds = await resolvePublicIds("record", publicExcludeIds);
        if (excludeIds.size !== publicExcludeIds.length) return c.json({ message: apiMessages(c).recordNotFound }, 404);
        return c.json(
          await projectRelationLookup(
            await gridsService.relations.lookup({
              targetTableId: loaded.table.id,
              q,
              limit,
              excludeIds: publicExcludeIds.map((id) => excludeIds.get(id)!),
              recordAccess: ALL_RECORD_ACCESS,
            }),
          ),
        );
      },
    );
