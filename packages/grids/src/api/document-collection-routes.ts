import { ErrorResponseSchema } from "@valentinkolb/cloud/contracts";
import { type AuthContext, getDateConfig, jsonResponse, respond } from "@valentinkolb/cloud/server";
import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { gridsService } from "../service";
import {
  DocumentBrowseQuerySchema,
  gateTemplate,
  loadTemplateAndTable,
  PublicDocumentBrowseResponseSchema,
  PublicDocumentListQuerySchema,
  PublicDocumentListSchema,
  PublicDocumentPageQuerySchema,
  projectDocuments,
} from "./documents-api-shared";
import { apiMessages } from "./messages";
import { gateAt } from "./permissions";
import { resolvePublicIdParam } from "./route-params";
import { v } from "./validator";

export const createDocumentCollectionRoutes = () =>
  new Hono<AuthContext>()
    .get(
      "/by-template/:templateId",
      describeRoute({
        tags: ["Grids:Document"],
        summary: "List generated Documents for a template",
        responses: {
          200: jsonResponse(PublicDocumentListSchema, "Documents"),
          403: jsonResponse(ErrorResponseSchema, "Forbidden"),
        },
      }),
      v("query", PublicDocumentListQuerySchema),
      async (c) => {
        const loaded = await loadTemplateAndTable(c.req.param("templateId")!);
        if (!loaded) return c.json({ message: apiMessages(c).documentTemplateNotFound }, 404);
        const gate = await gateTemplate(c, loaded, "read");
        if (!gate.ok) return respond(c, () => Promise.resolve(gate));
        const query = c.req.valid("query");
        const page = await gridsService.document.listDocumentsForTemplate({
          templateId: loaded.template.id,
          q: query.q,
          tags: query.tags,
          limit: query.limit,
          cursor: query.cursor || null,
        });
        return c.json({
          items: await projectDocuments(page.items.map(gridsService.document.summarizeDocument)),
          hasMore: page.hasMore,
          cursor: page.nextCursor,
        });
      },
    )

    .get(
      "/by-template/:templateId/browse",
      describeRoute({
        tags: ["Grids:Document"],
        summary: "Browse generated Documents as list items or year/month folders",
        responses: {
          200: jsonResponse(PublicDocumentBrowseResponseSchema, "Document browser page"),
          403: jsonResponse(ErrorResponseSchema, "Forbidden"),
        },
      }),
      v("query", DocumentBrowseQuerySchema),
      async (c) => {
        const loaded = await loadTemplateAndTable(c.req.param("templateId")!);
        if (!loaded) return c.json({ message: apiMessages(c).documentTemplateNotFound }, 404);
        const gate = await gateTemplate(c, loaded, "read");
        if (!gate.ok) return respond(c, () => Promise.resolve(gate));
        const query = c.req.valid("query");
        const page = await gridsService.document.browseDocumentsForTemplate({
          templateId: loaded.template.id,
          q: query.q,
          tags: query.tags,
          limit: query.limit,
          cursor: query.cursor || null,
          path: query.path,
          mode: query.mode,
          timeZone: (await getDateConfig(c)).timeZone,
        });
        return c.json({
          path: page.path,
          folders: page.folders,
          items: await projectDocuments(page.items.map(gridsService.document.summarizeDocument)),
          hasMore: page.hasMore ?? false,
          cursor: page.nextCursor ?? null,
        });
      },
    )

    .get(
      "/by-template/:templateId/:recordId",
      describeRoute({
        tags: ["Grids:Document"],
        summary: "List generated Documents for a template and record",
        responses: {
          200: jsonResponse(PublicDocumentListSchema, "Documents"),
          403: jsonResponse(ErrorResponseSchema, "Forbidden"),
        },
      }),
      v("query", PublicDocumentPageQuerySchema),
      async (c) => {
        const loaded = await loadTemplateAndTable(c.req.param("templateId")!);
        if (!loaded) return c.json({ message: apiMessages(c).documentTemplateNotFound }, 404);
        const recordId = await resolvePublicIdParam(c, "recordId", "record");
        if (!recordId) return c.json({ message: apiMessages(c).recordNotFound }, 404);
        const gate = await gateTemplate(c, loaded, "read");
        if (!gate.ok) return respond(c, () => Promise.resolve(gate));
        const query = c.req.valid("query");
        const page = await gridsService.document.listForRecord({
          baseId: loaded.table.baseId,
          tableId: loaded.table.id,
          recordId,
          templateId: loaded.template.id,
          limit: query.limit,
          cursor: query.cursor || null,
        });
        return c.json({
          items: await projectDocuments(page.items.map(gridsService.document.summarizeDocument)),
          cursor: page.nextCursor,
          hasMore: page.hasMore,
        });
      },
    )

    .get(
      "/by-record/:tableId/:recordId",
      describeRoute({
        tags: ["Grids:Document"],
        summary: "List generated Documents for a record",
        responses: {
          200: jsonResponse(PublicDocumentListSchema, "Documents"),
          403: jsonResponse(ErrorResponseSchema, "Forbidden"),
        },
      }),
      v("query", PublicDocumentPageQuerySchema),
      async (c) => {
        const tableId = await resolvePublicIdParam(c, "tableId", "table");
        const recordId = await resolvePublicIdParam(c, "recordId", "record");
        if (!tableId || !recordId) return c.json({ message: apiMessages(c).recordNotFound }, 404);
        const table = await gridsService.table.get(tableId);
        if (!table) return c.json({ message: apiMessages(c).tableNotFound }, 404);
        const gate = await gateAt(c, { baseId: table.baseId }, "read");
        if (!gate.ok) return respond(c, () => Promise.resolve(gate));
        const query = c.req.valid("query");
        const page = await gridsService.document.listForRecord({
          baseId: table.baseId,
          tableId,
          recordId,
          limit: query.limit,
          cursor: query.cursor || null,
        });
        return c.json({
          items: await projectDocuments(page.items.map(gridsService.document.summarizeDocument)),
          cursor: page.nextCursor,
          hasMore: page.hasMore,
        });
      },
    );
