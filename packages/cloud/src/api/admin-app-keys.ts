import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { z } from "zod";
import { validateAppKeyAppId } from "../app-key";
import { type AuthContext, auth, jsonResponse, respond, v } from "../server";
import { noTransform } from "../server/middleware/no-transform";
import { appKeys } from "../services/app-keys";
import { readAppMigrationStatus } from "../services/app-migration";

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
  .object({
    publicKey: z.string().length(43),
    name: z.string().trim().min(1).max(120).optional(),
    expiresAt: z.iso.datetime().optional(),
    grants: z.array(z.literal("oauth:issue")).max(1).optional(),
  })
  .strict();

const keyListResponse = z.object({
  installationId: z.uuid(),
  items: z.array(
    z.object({
      keyId: z.uuid(),
      appId: z.string(),
      serviceAccountId: z.uuid(),
      kind: z.literal("app_key"),
      name: z.string(),
      publicKey: z.string(),
      grants: z.array(z.literal("oauth:issue")),
      fingerprint: z.string(),
      status: z.enum(["active", "expired", "revoked"]),
      accountStatus: z.enum(["active", "disabled"]),
      createdAt: z.iso.datetime(),
      createdBy: z.uuid().nullable(),
      expiresAt: z.iso.datetime().nullable(),
      revokedAt: z.iso.datetime().nullable(),
      revokedBy: z.uuid().nullable(),
      lastUsedAt: z.iso.datetime().nullable(),
    }),
  ),
  lastRejectedStart: z
    .object({
      at: z.iso.datetime(),
      reason: z.enum(["revoked", "expired", "disabled", "connections_not_permitted"]),
      keyId: z.uuid().nullable(),
    })
    .nullable(),
  page: z.number().int(),
  perPage: z.number().int(),
  total: z.number().int(),
  hasNext: z.boolean(),
});

export const createAdminAppKeyRoutes = (
  authenticate: MiddlewareHandler<AuthContext> = auth.requireRole("admin"),
  service: typeof appKeys = appKeys,
  migration: typeof readAppMigrationStatus = readAppMigrationStatus,
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
      "/status",
      describeRoute({ tags: ["App keys"], summary: "Check all expected apps and per-instance bootstrap sources" }),
      v(
        "query",
        z
          .object({ expect: z.string().optional(), allowEnv: z.string().optional() })
          .transform((q) => ({
            expect: (q.expect ?? "").split(/[\s,]+/).filter(Boolean),
            allowEnv: (q.allowEnv ?? "").split(/[\s,]+/).filter(Boolean),
          }))
          .pipe(z.object({ expect: z.array(appId), allowEnv: z.array(appId) })),
      ),
      (c) => respond(c, () => migration({ actor: c.get("user"), ...c.req.valid("query") })),
    )
    .get(
      "/keys",
      describeRoute({ tags: ["App keys"], summary: "List apps with enrolled keys and the installation ID" }),
      v("query", pagination),
      (c) => respond(c, () => service.listApps({ actor: c.get("user"), ...c.req.valid("query") })),
    )
    .get(
      "/:appId/keys",
      describeRoute({
        tags: ["App keys"],
        summary: "List app public keys, lifecycle metadata and last rejected start",
        responses: { 200: jsonResponse(keyListResponse, "App keys and last rejected start") },
      }),
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
