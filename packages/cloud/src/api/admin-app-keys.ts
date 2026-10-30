import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { z } from "zod";
import { validateAppKeyAppId } from "../app-key";
import { type AuthContext, auth, respond, v } from "../server";
import { noTransform } from "../server/middleware/no-transform";
import { appKeys } from "../services/app-keys";

const appId = z.string().refine((value) => {
  try {
    validateAppKeyAppId(value);
    return true;
  } catch {
    return false;
  }
}, "Invalid or reserved app ID");
const params = z.object({ appId });
const pagination = z.object({
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(500).default(100),
});
const input = z
  .object({ publicKey: z.string().length(43), name: z.string().trim().min(1).max(120).optional(), expiresAt: z.iso.datetime().optional() })
  .strict();

export const createAdminAppKeyRoutes = (
  authenticate: MiddlewareHandler<AuthContext> = auth.requireRole("admin"),
  service: typeof appKeys = appKeys,
) =>
  new Hono<AuthContext>()
    .use("*", noTransform())
    .use(authenticate)
    .use("*", async (c, next) => {
      c.header("Cache-Control", "no-store");
      if (["POST", "DELETE"].includes(c.req.method)) return auth.requireOAuthScope("write", "admin")(c, next);
      return next();
    })
    .get(
      "/keys",
      describeRoute({ tags: ["App keys"], summary: "List apps with enrolled keys and the installation ID" }),
      v("query", pagination),
      (c) => respond(c, () => service.listApps({ actor: c.get("user"), ...c.req.valid("query") })),
    )
    .get(
      "/:appId/keys",
      describeRoute({ tags: ["App keys"], summary: "List app public keys and lifecycle metadata" }),
      v("param", params),
      v("query", pagination),
      (c) => respond(c, () => service.list({ actor: c.get("user"), ...c.req.valid("param"), ...c.req.valid("query") })),
    )
    .post(
      "/:appId/keys",
      describeRoute({ tags: ["App keys"], summary: "Idempotently enroll an Ed25519 public key; at most two active keys per app" }),
      v("param", params),
      v("json", input),
      (c) => respond(c, () => service.register({ actor: c.get("user"), ...c.req.valid("param"), ...c.req.valid("json") })),
    )
    .delete(
      "/:appId/keys/:keyId",
      describeRoute({ tags: ["App keys"], summary: "Idempotently revoke an app key" }),
      v("param", params.extend({ keyId: z.uuid() })),
      (c) => respond(c, () => service.revoke({ actor: c.get("user"), ...c.req.valid("param") })),
    );

export default createAdminAppKeyRoutes();
