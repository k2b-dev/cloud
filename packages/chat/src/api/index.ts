import { type AuthContext, auth, jsonResponse, rateLimit, requiresAdmin, respond } from "@k2b/cloud/server";
import { ok } from "@k2b/stdlib";
import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { ChatHealthSchema, chatService } from "../service";

const app = new Hono<AuthContext>().use(rateLimit()).get(
  "/admin/health",
  auth.requireRole("admin"),
  describeRoute({
    tags: ["Chat"],
    summary: "Read the chat app's operational health",
    ...requiresAdmin,
    responses: {
      200: jsonResponse(ChatHealthSchema, "Health snapshot"),
    },
  }),
  async (c) => respond(c, ok(await chatService.health())),
);

export default app;
export type ApiType = typeof app;
