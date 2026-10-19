import { type AuthContext, auth, jsonResponse, requiresAdmin } from "@k2b/cloud/server";
import { Hono } from "hono";
import { describeRoute, resolver } from "hono-openapi";
import { z } from "zod";
import {
  addInternalTarget,
  adminBaseAction,
  BaseAdminError,
  deleteOrphan,
  listAdminBases,
  listInternalTargets,
  listOrphans,
  removeInternalTarget,
  updateBaseLimits,
} from "../../service/base-admin";
import { getPolicy, setPolicy } from "../../service/base-policy";
import { ADMIN_ERROR_CODES } from "../../store/admin-contracts";
import { AdminBaseRowSchema, LimitsUpdateSchema, PulsePolicySchema, PulsePolicyUpdateSchema } from "../../store/admin-schemas";
import { BaseStoreError } from "../../store/base-store";
import { StoreQueryError } from "../../store/client";
import { StoreAdminError } from "../../store/service";

const page = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
  q: z.string().max(500).optional(),
  baseId: z
    .string()
    .regex(/^[0-9A-Za-z]{6}$/)
    .optional(),
});
const TargetInput = z.object({ baseId: z.string().regex(/^[0-9A-Za-z]{6}$/), entry: z.string().min(1).max(300) }).strict();
const TargetSchema = z.object({
  id: z.string(),
  baseId: z.string(),
  baseName: z.string(),
  entry: z.string(),
  scope: z.enum(["host", "host_port", "network"]),
  port: z.number().nullable(),
  createdAt: z.string(),
});
const metadata = (summary: string, schema: z.ZodType, input?: z.ZodType, success: 200 | 201 = 200) =>
  describeRoute({
    tags: ["Pulse administration"],
    summary,
    ...requiresAdmin,
    ...(input ? { requestBody: { required: true, content: { "application/json": { schema: resolver(input) } } } } : {}),
    responses: {
      [success]: jsonResponse(schema, summary),
      400: jsonResponse(z.object({ code: z.enum(ADMIN_ERROR_CODES) }), "Invalid input"),
      403: jsonResponse(z.object({ code: z.literal("ACCESS_DENIED") }), "Cloud admin required"),
      404: jsonResponse(z.object({ code: z.enum(ADMIN_ERROR_CODES) }), "Not found"),
      409: jsonResponse(z.object({ code: z.enum(ADMIN_ERROR_CODES) }), "Operation conflicts with current state"),
      503: jsonResponse(z.object({ code: z.enum(ADMIN_ERROR_CODES) }), "Data store unavailable"),
    },
  });
const routes = new Hono<AuthContext>()
  .use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
    if (c.res.status === 403) c.res = c.json({ code: "ACCESS_DENIED" }, 403);
  })
  .use("*", auth.requireOAuthScope("admin"))
  .use("*", auth.requireRole("admin"))
  .onError((error, c) => {
    if (error instanceof BaseAdminError || error instanceof StoreAdminError) return c.json({ code: error.code }, error.status);
    if (error instanceof BaseStoreError || error instanceof StoreQueryError)
      return c.json(
        { code: error instanceof BaseStoreError && error.code === "STORE_NOT_CONFIGURED" ? "STORE_NOT_CONFIGURED" : "STORE_UNAVAILABLE" },
        503,
      );
    if (error instanceof z.ZodError || error instanceof SyntaxError) return c.json({ code: "INVALID_INPUT" }, 400);
    return c.json({ code: "ADMIN_REQUEST_FAILED" }, 500);
  })
  .get("/policy", metadata("Read Pulse base policy", PulsePolicySchema), async (c) =>
    c.json(await getPolicy({ actor: c.get("actor"), accessSubject: c.get("accessSubject") })),
  )
  .put("/policy", metadata("Update Pulse base policy", PulsePolicySchema, PulsePolicyUpdateSchema), async (c) =>
    c.json(
      await setPolicy({ actor: c.get("actor"), accessSubject: c.get("accessSubject") }, PulsePolicyUpdateSchema.parse(await c.req.json())),
    ),
  )
  .get(
    "/bases",
    metadata(
      "List Pulse bases and store status",
      z.object({
        items: z.array(AdminBaseRowSchema),
        total: z.number(),
        nextOffset: z.number().nullable(),
        usedBytes: z.number(),
        disk: z.object({ freeBytes: z.number(), totalBytes: z.number(), measuredAt: z.string() }).nullable(),
      }),
    ),
    async (c) => c.json(await listAdminBases({ actor: c.get("actor"), accessSubject: c.get("accessSubject") }, page.parse(c.req.query()))),
  )
  .put("/bases/:baseId/limits", metadata("Update Pulse base limits", AdminBaseRowSchema, LimitsUpdateSchema), async (c) =>
    c.json(
      await updateBaseLimits({ actor: c.get("actor"), accessSubject: c.get("accessSubject") }, c.req.param("baseId"), await c.req.json()),
    ),
  )
  .post("/bases/:baseId/retry", metadata("Retry Pulse base operation", AdminBaseRowSchema), async (c) =>
    c.json(await adminBaseAction({ actor: c.get("actor"), accessSubject: c.get("accessSubject") }, c.req.param("baseId"), "retry")),
  )
  .post("/bases/:baseId/recheck", metadata("Recheck Pulse base after restore", AdminBaseRowSchema), async (c) =>
    c.json(await adminBaseAction({ actor: c.get("actor"), accessSubject: c.get("accessSubject") }, c.req.param("baseId"), "recheck")),
  )
  .post("/bases/:baseId/recreate", metadata("Recreate an empty Pulse base store", AdminBaseRowSchema), async (c) =>
    c.json(await adminBaseAction({ actor: c.get("actor"), accessSubject: c.get("accessSubject") }, c.req.param("baseId"), "recreate")),
  )
  .get(
    "/orphans",
    metadata(
      "List orphan Pulse databases",
      z.object({ items: z.array(z.object({ database: z.string() })), nextOffset: z.number().nullable() }),
    ),
    async (c) => c.json(await listOrphans({ actor: c.get("actor"), accessSubject: c.get("accessSubject") }, page.parse(c.req.query()))),
  )
  .delete("/orphans/:database", metadata("Delete an orphan Pulse database", z.object({ ok: z.literal(true) })), async (c) =>
    c.json(await deleteOrphan({ actor: c.get("actor"), accessSubject: c.get("accessSubject") }, c.req.param("database"))),
  )
  .get(
    "/targets",
    metadata(
      "List internal targets per base",
      z.object({ items: z.array(TargetSchema), total: z.number(), nextOffset: z.number().nullable() }),
    ),
    async (c) =>
      c.json(await listInternalTargets({ actor: c.get("actor"), accessSubject: c.get("accessSubject") }, page.parse(c.req.query()))),
  )
  .post("/targets", metadata("Release an internal target for a base", TargetSchema, TargetInput, 201), async (c) =>
    c.json(
      await addInternalTarget({ actor: c.get("actor"), accessSubject: c.get("accessSubject") }, TargetInput.parse(await c.req.json())),
      201,
    ),
  )
  .delete("/targets/:targetId", metadata("Revoke an internal target", z.object({ ok: z.literal(true) })), async (c) =>
    c.json(await removeInternalTarget({ actor: c.get("actor"), accessSubject: c.get("accessSubject") }, c.req.param("targetId"))),
  );
export default routes;
