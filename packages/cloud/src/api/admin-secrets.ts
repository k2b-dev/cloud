import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { z } from "zod";
import { CapabilityAppIdSchema } from "../contracts/capabilities";
import { SecretRotationStatusSchema } from "../contracts/secret-status";
import { type AuthContext, auth, jsonResponse, respond, v } from "../server";
import { noTransform } from "../server/middleware/no-transform";
import { readSecretRotationStatus } from "../services/secret-status";

export const createAdminSecretsRoutes = (
  authenticate: MiddlewareHandler<AuthContext> = auth.requireRole("admin"),
  readStatus = readSecretRotationStatus,
) =>
  new Hono<AuthContext>()
    .use("*", noTransform())
    .use(authenticate)
    .use("*", auth.requireOAuthScope("read", "admin"))
    .use("*", async (c, next) => {
      c.header("Cache-Control", "no-store");
      await next();
    })
    .get(
      "/status",
      describeRoute({
        tags: ["Secrets"],
        summary: "Inspect application secret rings and owner checks",
        responses: { 200: jsonResponse(SecretRotationStatusSchema, "Registry secret rotation readiness") },
      }),
      v(
        "query",
        z
          .object({ expect: z.string().optional() })
          .transform((query) => ({
            expect: (query.expect ?? "").split(/[\s,]+/).filter(Boolean),
          }))
          .pipe(z.object({ expect: z.array(CapabilityAppIdSchema) })),
      ),
      (c) => respond(c, () => readStatus({ actor: c.get("user"), ...c.req.valid("query") })),
    );
