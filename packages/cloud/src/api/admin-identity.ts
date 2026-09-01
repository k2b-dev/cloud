import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import { type AuthContext, auth, v } from "../server";
import {
  getIdentitySigningKeyStatus,
  identityMetrics,
  rewrapIdentitySigningKeys,
  revokeIdentitySigningKey,
} from "../services/identity";

type IdentityAdminDependencies = {
  status: typeof getIdentitySigningKeyStatus;
  rewrap: typeof rewrapIdentitySigningKeys;
  revoke: typeof revokeIdentitySigningKey;
};

const dependencies: IdentityAdminDependencies = {
  status: getIdentitySigningKeyStatus,
  rewrap: rewrapIdentitySigningKeys,
  revoke: revokeIdentitySigningKey,
};

export const createAdminIdentityRoutes = (
  authenticate: MiddlewareHandler<AuthContext> = auth.requireRole("admin"),
  service: IdentityAdminDependencies = dependencies,
) =>
  new Hono<AuthContext>()
    .use(authenticate)
    .get("/keys", async (c) => c.json({ keys: await service.status(), metrics: identityMetrics.snapshot() }))
    .post("/keys/rewrap", async (c) => c.json({ rewrapped: await service.rewrap() }))
    .post(
      "/keys/:kid/revoke",
      v("param", z.object({ kid: z.uuid() })),
      v("json", z.object({ reason: z.string().trim().min(1).max(500) })),
      async (c) => {
        const revoked = await service.revoke({
          kid: c.req.valid("param").kid,
          reason: c.req.valid("json").reason,
        });
        return revoked ? c.json({ revoked: true }) : c.json({ message: "Signing key not found" }, 404);
      },
    );

export default createAdminIdentityRoutes();
