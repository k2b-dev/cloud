import { ErrorResponseSchema } from "@valentinkolb/cloud/contracts";
import { type AuthContext, auth, getDateConfig, jsonResponse, respond } from "@valentinkolb/cloud/server";
import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { z } from "zod";
import { gridsService } from "../service";
import { checkFormula } from "../service/formula-preview";
import { projectPublicIds, resolvePublicId } from "../service/public-resources";
import { apiMessages } from "./messages";
import { currentActorViewer, gateAt } from "./permissions";
import { internalIdParam, requirePublicIdParam } from "./route-params";
import { v } from "./validator";

const FormulaCheckBodySchema = z.object({
  expression: z.string().max(10_000),
  currentFieldId: z.string().length(6).nullable().optional(),
});

const FormulaPreviewResponseSchema = z.object({
  ok: z.boolean(),
  diagnostics: z.array(
    z.object({
      code: z.enum(["formula.empty", "formula.syntax", "formula.unknown_field", "formula.evaluation"]),
      severity: z.enum(["error", "info"]),
      message: z.string(),
    }),
  ),
  fields: z.array(
    z.object({
      id: z.string().length(6),
      name: z.string(),
      type: z.string(),
    }),
  ),
  rows: z.array(
    z.object({
      recordId: z.string().length(6),
      values: z.record(z.string(), z.unknown()),
      result: z.unknown(),
    }),
  ),
});

const app = new Hono<AuthContext>().use(auth.requireRole("authenticated")).post(
  "/by-table/:tableId/check",
  requirePublicIdParam("tableId", "table", "Table"),
  describeRoute({
    tags: ["Grids:Formula"],
    summary: "Validate a formula and preview latest records",
    responses: {
      200: jsonResponse(FormulaPreviewResponseSchema, "Formula diagnostics and preview rows"),
      403: jsonResponse(ErrorResponseSchema, "Forbidden"),
      404: jsonResponse(ErrorResponseSchema, "Table not found"),
    },
  }),
  v("json", FormulaCheckBodySchema),
  async (c) => {
    const tableId = internalIdParam(c, "tableId")!;
    const table = await gridsService.table.get(tableId);
    if (!table) return c.json({ message: apiMessages(c).tableNotFound }, 404);
    const gate = await gateAt(c, { baseId: table.baseId }, "read");
    if (!gate.ok) return respond(c, () => Promise.resolve(gate));
    const body = c.req.valid("json");
    const currentFieldId = body.currentFieldId ? await resolvePublicId("field", body.currentFieldId) : null;
    if (body.currentFieldId && !currentFieldId) return c.json({ message: apiMessages(c).fieldNotFound }, 404);
    if (currentFieldId) {
      const currentField = await gridsService.field.get(currentFieldId);
      if (!currentField || currentField.tableId !== tableId) return c.json({ message: apiMessages(c).fieldNotFound }, 404);
    }
    const dateConfig = await getDateConfig(c);
    const result = await checkFormula({
      tableId,
      expression: body.expression,
      currentFieldId,
      dateConfig,
      viewer: currentActorViewer(c),
    });
    if (!result.ok) return respond(c, () => Promise.resolve(result));
    const fieldIds = await projectPublicIds(
      "field",
      result.data.fields.map((field) => field.id),
    );
    const recordIds = await projectPublicIds(
      "record",
      result.data.rows.map((row) => row.recordId),
    );
    return c.json({
      ...result.data,
      fields: result.data.fields.map(({ shortId: _shortId, ...field }) => ({ ...field, id: fieldIds.get(field.id)! })),
      rows: result.data.rows.map((row) => ({
        ...row,
        recordId: recordIds.get(row.recordId)!,
        values: Object.fromEntries(Object.entries(row.values).map(([fieldId, value]) => [fieldIds.get(fieldId)!, value])),
      })),
    });
  },
);

export default app;
