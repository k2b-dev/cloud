import { ErrorResponseSchema } from "@valentinkolb/cloud/contracts";
import { type AuthContext, auth, getLocale, jsonResponse, respond } from "@valentinkolb/cloud/server";
import { type Context, Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { z } from "zod";
import { ShortIdSchema } from "../contracts";
import {
  EVIDENCE_EXPORT_SECTIONS,
  EvidenceExportListSchema,
  EvidenceExportPreflightSchema,
  EvidenceExportRequestSchema,
  EvidenceExportSchema,
} from "../evidence-export-contracts";
import { gridsService } from "../service";
import { apiMessages } from "./messages";
import { currentActorUser, gateAt } from "./permissions";
import { internalIdParam, requirePublicIdParam } from "./route-params";
import { v } from "./validator";

const RangeQuerySchema = z
  .object({
    tableId: ShortIdSchema.optional(),
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
    sections: z.string().max(128).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.from && value.to && Date.parse(value.from) > Date.parse(value.to)) {
      ctx.addIssue({ code: "custom", path: ["to"], message: "End must not be before start" });
    }
  });

const loadTableScope = async (baseId: string, tablePublicId: string | null | undefined) => {
  if (!tablePublicId) return { ok: true as const, tableId: null };
  const table = await gridsService.table.getByShortIdForBase(baseId, tablePublicId);
  return table ? { ok: true as const, tableId: table.id } : { ok: false as const };
};

const loadExportAndGate = async (c: Context<AuthContext>) => {
  const exportItem = await gridsService.evidenceExport.getByShortId(c.req.param("exportId") ?? "");
  if (!exportItem) return { ok: false as const, response: c.json({ message: apiMessages(c).evidenceExportNotFound }, 404) };
  const base = await gridsService.base.getByShortId(exportItem.baseId);
  if (!base) return { ok: false as const, response: c.json({ message: apiMessages(c).evidenceExportNotFound }, 404) };
  const gate = await gateAt(c, { baseId: base.id }, "admin");
  if (!gate.ok) return { ok: false as const, response: c.json({ message: apiMessages(c).evidenceExportNotFound }, 404) };
  return { ok: true as const, exportItem, base };
};

const api = new Hono<AuthContext>()
  .use(auth.requireRole("authenticated"))
  .get(
    "/by-base/:baseId/preflight",
    requirePublicIdParam("baseId", "base", "Base"),
    describeRoute({
      tags: ["Grids:EvidenceExport"],
      summary: "Estimate a bounded evidence export",
      responses: {
        200: jsonResponse(EvidenceExportPreflightSchema, "Known scope and history coverage"),
        400: jsonResponse(ErrorResponseSchema, "Invalid range"),
        403: jsonResponse(ErrorResponseSchema, "Base admin required"),
        404: jsonResponse(ErrorResponseSchema, "Base or table not found"),
      },
    }),
    v("query", RangeQuerySchema),
    async (c) => {
      const baseId = internalIdParam(c, "baseId")!;
      const gate = await gateAt(c, { baseId }, "admin");
      if (!gate.ok) return respond(c, () => Promise.resolve(gate));
      const query = c.req.valid("query");
      const sections = query.sections
        ? query.sections
            .split(",")
            .filter((section): section is (typeof EVIDENCE_EXPORT_SECTIONS)[number] =>
              EVIDENCE_EXPORT_SECTIONS.includes(section as (typeof EVIDENCE_EXPORT_SECTIONS)[number]),
            )
        : undefined;
      if (
        query.sections &&
        (!sections ||
          sections.length === 0 ||
          sections.length !== query.sections.split(",").length ||
          new Set(sections).size !== sections.length)
      ) {
        return c.json({ message: apiMessages(c).invalidEvidenceExportSections }, 400);
      }
      const table = await loadTableScope(baseId, query.tableId);
      if (!table.ok) return c.json({ message: apiMessages(c).tableNotFound }, 404);
      return c.json(
        await gridsService.evidenceExport.preflight({
          baseId,
          tableId: table.tableId,
          from: query.from ?? null,
          to: query.to ?? null,
          sections,
          locale: getLocale(c),
        }),
      );
    },
  )
  .get(
    "/by-base/:baseId",
    requirePublicIdParam("baseId", "base", "Base"),
    describeRoute({
      tags: ["Grids:EvidenceExport"],
      summary: "List evidence exports for a Base",
      responses: {
        200: jsonResponse(EvidenceExportListSchema, "Evidence exports"),
        403: jsonResponse(ErrorResponseSchema, "Base admin required"),
        404: jsonResponse(ErrorResponseSchema, "Base not found"),
      },
    }),
    async (c) => {
      const baseId = internalIdParam(c, "baseId")!;
      const gate = await gateAt(c, { baseId }, "admin");
      if (!gate.ok) return respond(c, () => Promise.resolve(gate));
      return c.json({ items: await gridsService.evidenceExport.listByBase(baseId) });
    },
  )
  .post(
    "/by-base/:baseId",
    requirePublicIdParam("baseId", "base", "Base"),
    describeRoute({
      tags: ["Grids:EvidenceExport"],
      summary: "Request a bounded evidence export",
      responses: {
        201: jsonResponse(EvidenceExportSchema, "Queued evidence export"),
        400: jsonResponse(ErrorResponseSchema, "Invalid or over-budget scope"),
        403: jsonResponse(ErrorResponseSchema, "Base admin required"),
        404: jsonResponse(ErrorResponseSchema, "Base or table not found"),
      },
    }),
    v("json", EvidenceExportRequestSchema),
    async (c) => {
      const baseId = internalIdParam(c, "baseId")!;
      const gate = await gateAt(c, { baseId }, "admin");
      if (!gate.ok) return respond(c, () => Promise.resolve(gate));
      const body = c.req.valid("json");
      const table = await loadTableScope(baseId, body.tableId);
      if (!table.ok) return c.json({ message: apiMessages(c).tableNotFound }, 404);
      const actor = currentActorUser(c);
      const result = await gridsService.evidenceExport.create({
        baseId,
        tableId: table.tableId,
        from: body.from ?? null,
        to: body.to ?? null,
        sections: body.sections,
        requestedBy: actor?.id ?? null,
        requestedByDisplayName: actor ? actor.displayName || actor.uid : null,
        locale: getLocale(c),
      });
      return result.ok ? c.json(result.data, 201) : respond(c, () => Promise.resolve(result));
    },
  )
  .get(
    "/:exportId",
    describeRoute({
      tags: ["Grids:EvidenceExport"],
      summary: "Inspect an evidence export",
      responses: {
        200: jsonResponse(EvidenceExportSchema, "Evidence export"),
        404: jsonResponse(ErrorResponseSchema, "Evidence export unavailable"),
      },
    }),
    async (c) => {
      if (!ShortIdSchema.safeParse(c.req.param("exportId")).success) return c.json({ message: apiMessages(c).evidenceExportNotFound }, 404);
      const loaded = await loadExportAndGate(c);
      return loaded.ok ? c.json(loaded.exportItem) : loaded.response;
    },
  )
  .post(
    "/:exportId/retry",
    v("param", z.object({ exportId: ShortIdSchema })),
    describeRoute({
      tags: ["Grids:EvidenceExport"],
      summary: "Retry a failed or canceled evidence export",
      responses: {
        200: jsonResponse(EvidenceExportSchema, "Queued evidence export"),
        404: jsonResponse(ErrorResponseSchema, "Evidence export unavailable"),
        409: jsonResponse(ErrorResponseSchema, "Export cannot be retried"),
      },
    }),
    async (c) => {
      const loaded = await loadExportAndGate(c);
      if (!loaded.ok) return loaded.response;
      return respond(c, () => gridsService.evidenceExport.retry(loaded.exportItem.id, getLocale(c)));
    },
  )
  .post(
    "/:exportId/cancel",
    v("param", z.object({ exportId: ShortIdSchema })),
    describeRoute({
      tags: ["Grids:EvidenceExport"],
      summary: "Cancel a queued or running evidence export",
      responses: {
        200: jsonResponse(EvidenceExportSchema, "Canceled or cancellation-requested export"),
        404: jsonResponse(ErrorResponseSchema, "Evidence export unavailable"),
        409: jsonResponse(ErrorResponseSchema, "Export cannot be canceled"),
      },
    }),
    async (c) => {
      const loaded = await loadExportAndGate(c);
      if (!loaded.ok) return loaded.response;
      return respond(c, () => gridsService.evidenceExport.cancel(loaded.exportItem.id, getLocale(c)));
    },
  )
  .get(
    "/:exportId/download",
    v("param", z.object({ exportId: ShortIdSchema })),
    describeRoute({
      tags: ["Grids:EvidenceExport"],
      summary: "Download a completed evidence package",
      responses: {
        200: { description: "Exact stored TAR package" },
        404: jsonResponse(ErrorResponseSchema, "Package unavailable, unauthorized, or expired"),
      },
    }),
    async (c) => {
      const loaded = await loadExportAndGate(c);
      if (!loaded.ok) return loaded.response;
      const result = await gridsService.evidenceExport.download(loaded.exportItem.id, getLocale(c));
      if (!result.ok) return respond(c, () => Promise.resolve(result));
      return new Response(result.data.body, {
        headers: {
          "Content-Type": "application/x-tar",
          "Content-Length": String(result.data.sizeBytes),
          "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(result.data.filename)}`,
          ETag: `"${result.data.sha256}"`,
          "Cache-Control": "private, no-store",
        },
      });
    },
  );

export default api;
