import { type AuthContext, middleware, requiresAuth, respond, v } from "@k2b/cloud/server";
import { Hono } from "hono";
import { z } from "zod";
import { requestCall } from "../files-call";
import type { createActivityActions } from "../service/activity-actions";

const reference = z.object({ activityId: z.uuid() });
const restoreInput = z.object({ name: z.string().min(1).max(255).optional() }).strict();

export function createActivityActionsApi(service: ReturnType<typeof createActivityActions>) {
  return new Hono<AuthContext>()
    .get(
      "/activity/:activityId/recovery",
      middleware.openapi({ summary: "Check current recovery options for a history entry", ...requiresAuth }),
      v("param", reference),
      async (c) => c.json(await service.recovery({ ...requestCall(c), requestAbort: c.req.raw.signal }, c.req.valid("param"))),
    )
    .post(
      "/activity/:activityId/restore",
      middleware.openapi({ summary: "Restore the trashed item named by a history entry", ...requiresAuth }),
      v("param", reference),
      v("json", restoreInput),
      async (c) =>
        respond(c, {
          ok: true,
          data: await service.restore(
            { ...requestCall(c), requestAbort: c.req.raw.signal },
            { ...c.req.valid("param"), ...c.req.valid("json") },
          ),
        }),
    )
    .post(
      "/activity/:activityId/move-back",
      middleware.openapi({ summary: "Move the verified item back to its recorded location", ...requiresAuth }),
      v("param", reference),
      async (c) =>
        respond(c, { ok: true, data: await service.moveBack({ ...requestCall(c), requestAbort: c.req.raw.signal }, c.req.valid("param")) }),
    )
    .post(
      "/activity/:activityId/recheck",
      middleware.openapi({ summary: "Recheck evidence for an uncertain history entry", ...requiresAuth }),
      v("param", reference),
      async (c) => c.json(await service.recheck({ ...requestCall(c), requestAbort: c.req.raw.signal }, c.req.valid("param"))),
    );
}
