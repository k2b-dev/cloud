import { type AuthContext, auth, getLocale, jsonResponse, middleware, requiresAdmin, requiresAuth, respond, v } from "@k2b/cloud/server";
import { ok } from "@k2b/stdlib";
import { Hono } from "hono";
import { ActivityBasesInput, ActivityBasesPageSchema, ActivityBatchContextSchema, ShareAccessInput } from "../activity-contracts";
import {
  ActivityChainSchema,
  ActivityEntrySchema,
  ActivityIdInput,
  ActivityPageSchema,
  ActivityQuery,
  MovementChainQuery,
  ShareAccessCountsSchema,
  ShareAccessParam,
  ShareAccessQuery,
} from "../activity-transport";
import { EntryIdSchema } from "../contracts";
import { requestCall } from "../files-call";
import { FilesError, filesService } from "../service";

/** Mounted behind the Files user-role gate and its common error handler. */
export const activityApi = new Hono<AuthContext>()
  .use("/activity", middleware.noTransform())
  .use("/activity/*", middleware.noTransform())
  .use("/admin/activity/bases", middleware.noTransform())
  .get(
    "/admin/activity/bases",
    auth.requireRole("admin"),
    middleware.openapi({
      summary: "List recorded base identities for administrator history filters",
      ...requiresAdmin,
      responses: { 200: jsonResponse(ActivityBasesPageSchema, "Recorded base names") },
    }),
    v("query", ActivityBasesInput),
    async (c) =>
      respond(
        c,
        ok(
          await filesService.adminActivityBases(
            { ...requestCall(c), requestAbort: c.req.raw.signal, locale: getLocale(c) },
            c.req.valid("query"),
          ),
        ),
      ),
  )
  .get(
    "/activity/bases",
    middleware.openapi({ summary: "List addressable base names without provisioning storage", ...requiresAuth }),
    async (c) => respond(c, ok(await filesService.baseNames(requestCall(c)))),
  )
  .get(
    "/activity",
    middleware.openapi({
      summary: "List visible file history or search names and old paths",
      ...requiresAuth,
      responses: { 200: jsonResponse(ActivityPageSchema, "Visible history page") },
    }),
    v("query", ActivityQuery),
    async (c) => respond(c, ok(await filesService.activity({ ...requestCall(c), requestAbort: c.req.raw.signal }, c.req.valid("query")))),
  )
  .get(
    "/activity/entries/:id",
    middleware.openapi({
      summary: "Read history for a Cloud file reference without provisioning storage",
      ...requiresAuth,
      responses: { 200: jsonResponse(ActivityPageSchema, "Visible history page") },
    }),
    v("param", EntryIdSchema),
    v("query", ActivityQuery.omit({ baseId: true, itemId: true, path: true })),
    async (c) =>
      respond(
        c,
        ok(
          await filesService.activityForEntry(
            { ...requestCall(c), requestAbort: c.req.raw.signal },
            c.req.valid("param").id,
            c.req.valid("query"),
          ),
        ),
      ),
  )
  .get(
    "/activity/:activityId",
    middleware.openapi({
      summary: "Read one visible history event",
      ...requiresAuth,
      responses: { 200: jsonResponse(ActivityEntrySchema, "Visible history event") },
    }),
    v("param", ActivityIdInput),
    async (c) =>
      respond(c, ok(await filesService.activityEntry({ ...requestCall(c), requestAbort: c.req.raw.signal }, c.req.valid("param")))),
  )
  .get(
    "/activity/:activityId/batch",
    middleware.openapi({
      summary: "Count visible batch events anchored on a currently visible history event",
      ...requiresAuth,
      responses: { 200: jsonResponse(ActivityBatchContextSchema, "Visible batch count and completeness") },
    }),
    v("param", ActivityIdInput),
    async (c) =>
      respond(c, ok(await filesService.activityBatchContext({ ...requestCall(c), requestAbort: c.req.raw.signal }, c.req.valid("param")))),
  )
  .get(
    "/activity/:activityId/chain",
    middleware.openapi({
      summary: "Follow an authorized movement chain and check its current endpoint",
      ...requiresAuth,
      responses: { 200: jsonResponse(ActivityChainSchema, "Movement chain") },
    }),
    v("param", ActivityIdInput),
    v("query", MovementChainQuery.optional()),
    async (c) =>
      respond(
        c,
        ok(
          await filesService.movementChain(
            { ...requestCall(c), requestAbort: c.req.raw.signal },
            { ...c.req.valid("param"), ...c.req.valid("query") },
          ),
        ),
      ),
  )
  .get(
    "/shares/:shareId/access",
    middleware.openapi({
      summary: "Read public-link access counts as creator or administrator",
      ...requiresAuth,
      responses: { 200: jsonResponse(ShareAccessCountsSchema, "Public-link access counts") },
    }),
    v("param", ShareAccessParam),
    v("query", ShareAccessQuery),
    async (c) => {
      const input = ShareAccessInput.safeParse({ ...c.req.valid("param"), ...c.req.valid("query") });
      if (!input.success) throw new FilesError("invalid_activity_filter", 400);
      return respond(c, ok(await filesService.shareAccess({ ...requestCall(c), requestAbort: c.req.raw.signal }, input.data)));
    },
  );
