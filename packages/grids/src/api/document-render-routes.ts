import { ErrorResponseSchema } from "@valentinkolb/cloud/contracts";
import { type AuthContext, getDateConfig, getLocale, jsonResponse, respond } from "@valentinkolb/cloud/server";
import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { gridsService } from "../service";
import {
  addDraftDocumentMetadata,
  documentActor,
  draftTemplateFromBody,
  errorResponse,
  gateEnabledTemplateWrite,
  gateTemplate,
  liveRenderData,
  loadTemplateAndTable,
  PublicDocumentGenerateBodySchema,
  PublicDocumentPreviewResponseSchema,
  PublicDocumentRecordBodySchema,
  PublicDocumentTemplateDraftPreviewSchema,
  projectDocumentPreviewData,
  renderDraftDataResponse,
  renderDraftPdfResponse,
  resolveDocumentRecordId,
  snapshotTableReadAuthorizer,
} from "./documents-api-shared";
import { encodeHeaderValue, pdfResponse } from "./download-response";
import { apiMessages } from "./messages";
import { currentActorViewer, gateAt } from "./permissions";
import { resolvePublicIdParam } from "./route-params";
import { v } from "./validator";

export const createDocumentRenderRoutes = () =>
  new Hono<AuthContext>()
    .post(
      "/templates/by-table/:tableId/preview-draft",
      describeRoute({
        tags: ["Grids:Document"],
        summary: "Render a draft document template PDF preview",
        responses: {
          200: { description: "Draft PDF preview" },
          403: jsonResponse(ErrorResponseSchema, "Forbidden"),
        },
      }),
      v("json", PublicDocumentTemplateDraftPreviewSchema),
      async (c) => {
        const tableId = await resolvePublicIdParam(c, "tableId", "table");
        if (!tableId) return c.json({ message: apiMessages(c).tableNotFound, phase: "data" }, 404);
        const table = await gridsService.table.get(tableId);
        if (!table) return c.json({ message: apiMessages(c).tableNotFound, phase: "data" }, 404);
        const gate = await gateAt(c, { baseId: table.baseId }, "admin");
        if (!gate.ok) return respond(c, () => Promise.resolve(gate));

        const body = c.req.valid("json");
        const recordId = await resolveDocumentRecordId(body.recordId);
        if (!recordId) return c.json({ message: apiMessages(c).recordNotFound, phase: "data" }, 404);
        return renderDraftPdfResponse(c, { template: draftTemplateFromBody(body), tableId, recordId });
      },
    )

    .post(
      "/templates/by-table/:tableId/preview-data-draft",
      describeRoute({
        tags: ["Grids:Document"],
        summary: "Render draft document template data for one preview record",
        responses: {
          200: jsonResponse(PublicDocumentPreviewResponseSchema, "Draft document preview data"),
          403: jsonResponse(ErrorResponseSchema, "Forbidden"),
        },
      }),
      v("json", PublicDocumentTemplateDraftPreviewSchema),
      async (c) => {
        const tableId = await resolvePublicIdParam(c, "tableId", "table");
        if (!tableId) return c.json({ message: apiMessages(c).tableNotFound, phase: "data" }, 404);
        const table = await gridsService.table.get(tableId);
        if (!table) return c.json({ message: apiMessages(c).tableNotFound, phase: "data" }, 404);
        const gate = await gateAt(c, { baseId: table.baseId }, "admin");
        if (!gate.ok) return respond(c, () => Promise.resolve(gate));

        const body = c.req.valid("json");
        const recordId = await resolveDocumentRecordId(body.recordId);
        if (!recordId) return c.json({ message: apiMessages(c).recordNotFound, phase: "data" }, 404);
        return renderDraftDataResponse(c, { template: draftTemplateFromBody(body), tableId, recordId });
      },
    )

    .post(
      "/templates/:templateId/preview-draft",
      describeRoute({
        tags: ["Grids:Document"],
        summary: "Render a draft document template PDF preview using template admin access",
        responses: {
          200: { description: "Draft PDF preview" },
          403: jsonResponse(ErrorResponseSchema, "Forbidden"),
        },
      }),
      v("json", PublicDocumentTemplateDraftPreviewSchema),
      async (c) => {
        const loaded = await loadTemplateAndTable(c.req.param("templateId")!);
        if (!loaded) return c.json({ message: apiMessages(c).documentTemplateNotFound, phase: "data" }, 404);
        const gate = await gateTemplate(c, loaded, "admin");
        if (!gate.ok) return respond(c, () => Promise.resolve(gate));

        const body = c.req.valid("json");
        const recordId = await resolveDocumentRecordId(body.recordId);
        if (!recordId) return c.json({ message: apiMessages(c).recordNotFound, phase: "data" }, 404);
        return renderDraftPdfResponse(c, {
          template: draftTemplateFromBody(body, loaded.template),
          tableId: loaded.table.id,
          recordId,
        });
      },
    )

    .post(
      "/templates/:templateId/preview-data-draft",
      describeRoute({
        tags: ["Grids:Document"],
        summary: "Render draft document template data using template admin access",
        responses: {
          200: jsonResponse(PublicDocumentPreviewResponseSchema, "Draft document preview data"),
          403: jsonResponse(ErrorResponseSchema, "Forbidden"),
        },
      }),
      v("json", PublicDocumentTemplateDraftPreviewSchema),
      async (c) => {
        const loaded = await loadTemplateAndTable(c.req.param("templateId")!);
        if (!loaded) return c.json({ message: apiMessages(c).documentTemplateNotFound, phase: "data" }, 404);
        const gate = await gateTemplate(c, loaded, "admin");
        if (!gate.ok) return respond(c, () => Promise.resolve(gate));

        const body = c.req.valid("json");
        const recordId = await resolveDocumentRecordId(body.recordId);
        if (!recordId) return c.json({ message: apiMessages(c).recordNotFound, phase: "data" }, 404);
        return renderDraftDataResponse(c, {
          template: draftTemplateFromBody(body, loaded.template),
          tableId: loaded.table.id,
          recordId,
        });
      },
    )

    .post(
      "/templates/:templateId/preview",
      describeRoute({
        tags: ["Grids:Document"],
        summary: "Preview a document template for one record",
        responses: {
          200: jsonResponse(PublicDocumentPreviewResponseSchema, "Rendered HTML preview"),
          403: jsonResponse(ErrorResponseSchema, "Forbidden"),
        },
      }),
      v("json", PublicDocumentRecordBodySchema),
      async (c) => {
        const loaded = await loadTemplateAndTable(c.req.param("templateId")!);
        if (!loaded) return c.json({ message: apiMessages(c).documentTemplateNotFound }, 404);
        const gate = await gateTemplate(c, loaded, "admin");
        if (!gate.ok) return respond(c, () => Promise.resolve(gate));

        const recordId = await resolveDocumentRecordId(c.req.valid("json").recordId);
        if (!recordId) return c.json({ message: apiMessages(c).recordNotFound }, 404);
        const createdAt = new Date();
        const dateConfig = await getDateConfig(c);
        const rendered = await liveRenderData(c, {
          template: loaded.template,
          tableId: loaded.table.id,
          recordId,
          createdAt,
          dateConfig,
        });
        if (!rendered.ok) return errorResponse(c, rendered.message, rendered.status);
        const data = await addDraftDocumentMetadata(c, { template: loaded.template, data: rendered.data, createdAt, dateConfig });
        if (!data.ok) return data.response;
        if (loaded.template.renderer.kind === "profile") {
          const input = await gridsService.document.renderProfileInput(loaded.template, data.data, getLocale(c));
          if (!input.ok) return c.json({ message: input.error.message, phase: "profile" }, input.error.status);
          return c.json({ html: "", source: rendered.source, data: await projectDocumentPreviewData(data.data) });
        }
        const html = await gridsService.document.renderHtml(loaded.template, data.data, getLocale(c));
        if (!html.ok) return c.json({ message: html.error.message }, html.error.status);
        return c.json({ html: html.data, source: rendered.source, data: await projectDocumentPreviewData(data.data) });
      },
    )

    .post(
      "/templates/:templateId/preview-pdf",
      describeRoute({
        tags: ["Grids:Document"],
        summary: "Render a saved document template PDF preview",
        responses: {
          200: { description: "PDF preview" },
          403: jsonResponse(ErrorResponseSchema, "Forbidden"),
        },
      }),
      v("json", PublicDocumentRecordBodySchema),
      async (c) => {
        const loaded = await loadTemplateAndTable(c.req.param("templateId")!);
        if (!loaded) return c.json({ message: apiMessages(c).documentTemplateNotFound }, 404);
        const gate = await gateEnabledTemplateWrite(c, loaded);
        if (!gate.ok) return respond(c, () => Promise.resolve(gate));
        const recordId = await resolveDocumentRecordId(c.req.valid("json").recordId);
        if (!recordId) return c.json({ message: apiMessages(c).recordNotFound }, 404);
        const createdAt = new Date();
        const dateConfig = await getDateConfig(c);
        const rendered = await liveRenderData(c, {
          template: loaded.template,
          tableId: loaded.table.id,
          recordId,
          createdAt,
          dateConfig,
        });
        if (!rendered.ok) return errorResponse(c, rendered.message, rendered.status);
        const data = await addDraftDocumentMetadata(c, { template: loaded.template, data: rendered.data, createdAt, dateConfig });
        if (!data.ok) return data.response;
        if (loaded.template.renderer.kind === "profile") {
          const input = await gridsService.document.renderProfileInput(loaded.template, data.data, getLocale(c));
          if (!input.ok) return c.json({ message: input.error.message, phase: "profile" }, input.error.status);
          const preview = await gridsService.document.preview({
            profileId: loaded.template.renderer.id,
            profileVersion: loaded.template.renderer.version,
            snapshot: input.data,
            issuedAt: createdAt,
          });
          if (!preview.ok) return c.json({ message: preview.error.message, phase: "profile" }, preview.error.status);
          const artifact = preview.data.find((candidate) => candidate.key === "pdf");
          if (!artifact) return c.json({ message: apiMessages(c).documentProducedNoPdf }, 500);
          return pdfResponse(artifact.bytes, artifact.filename, {}, "inline");
        }
        const pdf = await gridsService.document.renderPdfPreview(
          loaded.template,
          data.data,
          `${loaded.template.shortId}-preview.html`,
          undefined,
          getLocale(c),
        );
        if (!pdf.ok) {
          return c.json(
            { message: pdf.error.message, phase: pdf.error.phase, code: pdf.error.code },
            pdf.error.status === 400 ? 400 : pdf.error.status === 502 ? 502 : 500,
          );
        }
        return pdfResponse(pdf.pdf.pdf, `${loaded.template.name}.pdf`, {}, "inline");
      },
    )

    .post(
      "/templates/:templateId/generate",
      describeRoute({
        tags: ["Grids:Document"],
        summary: "Generate and store an immutable PDF Document for one record",
        responses: {
          200: { description: "Generated PDF" },
          403: jsonResponse(ErrorResponseSchema, "Forbidden"),
        },
      }),
      v("json", PublicDocumentGenerateBodySchema),
      async (c) => {
        const loaded = await loadTemplateAndTable(c.req.param("templateId")!);
        if (!loaded) return c.json({ message: apiMessages(c).documentTemplateNotFound }, 404);
        if (!loaded.template.enabled) return c.json({ message: apiMessages(c).documentTemplateDisabled }, 400);
        const gate = await gateTemplate(c, loaded, "write");
        if (!gate.ok) return respond(c, () => Promise.resolve(gate));

        const body = c.req.valid("json");
        const recordId = await resolveDocumentRecordId(body.recordId);
        if (!recordId) return c.json({ message: apiMessages(c).recordNotFound }, 404);
        const dateConfig = await getDateConfig(c);
        const issued = await gridsService.document.createDocumentForRecord({
          template: loaded.template,
          table: loaded.table,
          recordId,
          actor: documentActor(c.get("actor")),
          idempotencyKey: body.idempotencyKey,
          canReadTable: snapshotTableReadAuthorizer(c),
          viewer: currentActorViewer(c),
          dateConfig,
          filename: body.filename,
          tags: body.tags,
        });
        if (!issued.ok) return c.json({ message: issued.error.message }, issued.error.status);
        const artifact = await gridsService.document.getDocumentArtifact(issued.data.id, "pdf", getLocale(c));
        if (!artifact.ok) return c.json({ message: artifact.error.message }, artifact.error.status);
        return pdfResponse(artifact.data.bytes, artifact.data.filename, {
          "X-Grids-Document-Id": issued.data.shortId,
          "X-Grids-Document-Number": issued.data.documentNumber,
          "X-Grids-Document-Filename": encodeHeaderValue(artifact.data.filename),
        });
      },
    );
