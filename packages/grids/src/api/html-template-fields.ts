import { ErrorResponseSchema } from "@valentinkolb/cloud/contracts";
import { type AuthContext, auth, getDateConfig, jsonResponse, respond } from "@valentinkolb/cloud/server";
import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { z } from "zod";
import { gridsService } from "../service";
import { apiMessages } from "./messages";
import { currentActorViewer, gateAt } from "./permissions";
import { internalIdParam, requirePublicIdParam } from "./route-params";
import { v } from "./validator";

const BodySchema = z.object({
  template: z.string().max(50_000),
  css: z.string().max(32_000),
  currentFieldId: z.string().length(6),
});

const ResponseSchema = z.object({
  ok: z.boolean(),
  diagnostics: z.array(
    z.object({
      code: z.enum(["html.invalid_config", "html.empty", "html.field_not_found", "html.render_failed"]),
      severity: z.enum(["error", "info"]),
      message: z.string(),
    }),
  ),
  rows: z.array(z.object({ recordId: z.string().length(6), html: z.string() })),
});

const app = new Hono<AuthContext>().use(auth.requireRole("authenticated")).post(
  "/by-table/:tableId/check",
  requirePublicIdParam("tableId", "table", "Table"),
  describeRoute({
    tags: ["Grids:HTMLTemplateField"],
    summary: "Validate an HTML template field and preview latest records",
    responses: {
      200: jsonResponse(ResponseSchema, "HTML template diagnostics and preview rows"),
      400: jsonResponse(ErrorResponseSchema, "Invalid input"),
      403: jsonResponse(ErrorResponseSchema, "Forbidden"),
      404: jsonResponse(ErrorResponseSchema, "Not found"),
    },
  }),
  v("json", BodySchema),
  async (c) => {
    const tableId = internalIdParam(c, "tableId")!;
    const table = await gridsService.table.get(tableId);
    if (!table) return c.json({ message: apiMessages(c).tableNotFound }, 404);
    const gate = await gateAt(c, { baseId: table.baseId }, "admin");
    if (!gate.ok) return respond(c, () => Promise.resolve(gate));
    const body = c.req.valid("json");
    const field = await gridsService.field.getByShortId(body.currentFieldId);
    if (!field || field.tableId !== tableId || field.type !== "html_template")
      return c.json({ message: apiMessages(c).fieldNotFound }, 404);
    const result = await gridsService.htmlTemplatePreview.check({
      tableId,
      fieldId: field.id,
      template: body.template,
      css: body.css,
      dateConfig: await getDateConfig(c),
      viewer: currentActorViewer(c),
    });
    return result.ok ? c.json(result.data) : respond(c, () => Promise.resolve(result));
  },
);

export default app;
