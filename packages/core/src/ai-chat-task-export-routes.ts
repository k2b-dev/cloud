import { ChatTaskExportForbiddenError, ChatTaskExportQuerySchema, exportChatTasks } from "@k2b/cloud/ai";
import { type AuthContext, auth, err, fail, middleware, ok, rateLimit, respond, v } from "@k2b/cloud/server";
import { Hono } from "hono";

const protectExport = [middleware.noTransform(), rateLimit(), auth.requireRole("authenticated"), auth.requireUser()] as const;

export const aiChatTaskExportRoutes = new Hono<AuthContext>()
  .get("/tasks/export", ...protectExport, auth.requireOAuthScope("read", "admin"), v("query", ChatTaskExportQuerySchema), async (c) => {
    c.header("Cache-Control", "no-store");
    try {
      return respond(c, ok(await exportChatTasks(c.get("actor"), c.req.valid("query"))));
    } catch (error) {
      if (error instanceof ChatTaskExportForbiddenError) return respond(c, fail(err.forbidden(error.message)));
      throw error;
    }
  })
  .get(
    "/admin/tasks/export",
    ...protectExport,
    auth.requireRole("admin"),
    auth.requireOAuthScope("read", "admin"),
    v("query", ChatTaskExportQuerySchema),
    async (c) => {
      c.header("Cache-Control", "no-store");
      try {
        return respond(c, ok(await exportChatTasks(c.get("actor"), { ...c.req.valid("query"), all: true })));
      } catch (error) {
        if (error instanceof ChatTaskExportForbiddenError) return respond(c, fail(err.forbidden(error.message)));
        throw error;
      }
    },
  );
