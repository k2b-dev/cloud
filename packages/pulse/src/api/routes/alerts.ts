import { type AuthContext, jsonResponse, type Result, v } from "@k2b/cloud/server";
import { type Context, Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { z } from "zod";
import { alertRules } from "../../service/alert-rules";
import { AlertRuleSchema, AlertRulesPageSchema, AlertSaveSchema } from "../alert-schemas";

const ErrorBody = z.object({ code: z.string(), message: z.string() });
const metadata = (summary: string, schema: z.ZodType, status: 200 | 201 = 200) =>
  describeRoute({
    tags: ["Pulse"],
    summary,
    responses: {
      [status]: jsonResponse(schema, summary),
      400: jsonResponse(ErrorBody, "Invalid rule"),
      403: jsonResponse(ErrorBody, "Base access required"),
      404: jsonResponse(ErrorBody, "Rule not found"),
      409: jsonResponse(ErrorBody, "Revision, name, budget or idempotency conflict"),
    },
  });
const identity = (c: Context<AuthContext>) => ({
  actor: c.get("actor"),
  accessSubject: c.get("accessSubject"),
  baseId: c.req.param("baseId")!,
  requestId: c.req.header("x-request-id"),
});
const answer = <T>(c: Context<AuthContext>, result: Result<T>, status: 200 | 201 = 200) =>
  result.ok ? c.json(result.data, status) : c.json(result.error, result.error.status);
const routes = new Hono<AuthContext>()
  .get(
    "/bases/:baseId/alerts",
    metadata("List alert rules in a readable Pulse base", AlertRulesPageSchema),
    v(
      "query",
      z.object({ limit: z.coerce.number().int().min(1).max(1000).optional(), offset: z.coerce.number().int().nonnegative().optional() }),
    ),
    async (c) => answer(c, await alertRules.list({ ...identity(c), ...c.req.valid("query") })),
  )
  .get("/bases/:baseId/alerts/:ruleId", metadata("Read a Pulse alert rule", AlertRuleSchema), async (c) =>
    answer(c, await alertRules.get({ ...identity(c), ruleId: c.req.param("ruleId") })),
  )
  .post("/bases/:baseId/alerts", metadata("Create a Pulse alert rule", AlertRuleSchema, 201), v("json", AlertSaveSchema), async (c) =>
    answer(c, await alertRules.save({ ...identity(c), ...c.req.valid("json"), idempotencyKey: c.req.header("idempotency-key") }), 201),
  )
  .patch(
    "/bases/:baseId/alerts/:ruleId",
    metadata("Update a Pulse alert rule at its expected revision", AlertRuleSchema),
    v("json", AlertSaveSchema.safeExtend({ expectedRevision: z.number().int().positive() })),
    async (c) =>
      answer(
        c,
        await alertRules.save({
          ...identity(c),
          ...c.req.valid("json"),
          ruleId: c.req.param("ruleId")!,
          idempotencyKey: c.req.header("idempotency-key"),
        }),
      ),
  )
  .delete(
    "/bases/:baseId/alerts/:ruleId",
    metadata("Delete a Pulse alert rule at its expected revision", z.object({ deleted: z.boolean() })),
    v("json", z.object({ expectedRevision: z.number().int().positive() }).strict()),
    async (c) => {
      const result = await alertRules.remove({
        ...identity(c),
        ruleId: c.req.param("ruleId")!,
        ...c.req.valid("json"),
        idempotencyKey: c.req.header("idempotency-key"),
      });
      return result.ok ? c.json({ deleted: true }) : answer(c, result);
    },
  );
export default routes;
