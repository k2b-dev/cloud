import assert from "node:assert/strict";
import { redis, sql } from "bun";
import { Hono } from "hono";
import { createAuthRoutes } from "../../../cloud/src/api/auth";
import { type AuthContext, auth, rateLimit, v } from "../../../cloud/src/server";

// Maintainer-only fixture, also copied into the pre-JWT checkout. Never mount
// this router in an application. The driver supplies an offline disposable DB.
assert.match(new URL(process.env.DATABASE_URL!).pathname, /^\/cloud_oauth_verify_[a-z0-9_]+$/);
assert.equal(new URL(process.env.DATABASE_URL!).hostname, "127.0.0.1");
const current = process.env.OAUTH_VERIFY_VERSION === "current";
const core = process.env.APP_ID === "core";
const router = new Hono<AuthContext>();
if (core) {
  for (const name of ["auth", "audit", "settings", "logging"]) {
    await (await import(`../../../core/src/migrate/core/${name}.ts`)).migrate();
  }
  // Settings are seeded in the fixture's own Valkey, not overridden functions.
  for (const [key, value] of Object.entries({
    "app.url": process.env.OAUTH_VERIFY_ISSUER ?? "http://127.0.0.1:4300",
    "freeipa.groups.admin": ["admins"],
    "user.session.expiry_hours": 24,
    "security.rate_limit_per_second": 1000,
  }))
    await redis.set(`settings:${key}`, JSON.stringify(value));
  await sql`INSERT INTO auth.users (uid, provider, profile, admin, display_name, given_name, sn, mail)
    VALUES ('admin', 'local', 'user', true, 'Reference User', 'Reference', 'User', 'reference@example.test')
    ON CONFLICT (uid) DO NOTHING`;
  await sql`INSERT INTO auth.groups (cn, provider, name)
    VALUES ('reference-child', 'local', 'Reference child'), ('reference-parent', 'local', 'Reference parent')
    ON CONFLICT DO NOTHING`;
  await sql`INSERT INTO auth.user_groups_v2 (user_id, group_id)
    SELECT u.id, g.id FROM auth.users u, auth.groups g WHERE u.uid = 'admin' AND g.cn = 'reference-child'
    ON CONFLICT DO NOTHING`;
  await sql`INSERT INTO auth.group_groups_v2 (parent_group_id, child_group_id)
    SELECT parent.id, child.id FROM auth.groups parent, auth.groups child
    WHERE parent.cn = 'reference-parent' AND child.cn = 'reference-child' ON CONFLICT DO NOTHING`;
  await sql`INSERT INTO auth.service_accounts (name, kind, app_id, resource_type, resource_id)
    SELECT 'Reference resource', 'resource_bound', 'oauth-test', 'fixture', 'reference'
    WHERE NOT EXISTS (SELECT 1 FROM auth.service_accounts WHERE app_id = 'oauth-test' AND resource_id = 'reference')`;
  const unusedNotification = async (): Promise<never> => {
    throw new Error("This fixture must not send notifications");
  };
  router.route(
    "/api/auth",
    createAuthRoutes({
      sendMagicLink: unusedNotification,
      sendIpaLoginHint: unusedNotification,
      sendPasswordReset: unusedNotification,
    }),
  );
  if (current) {
    const { createIdentityPublicRoutes } = await import("../../../cloud/src/services/identity");
    const { createAdminIdentityRoutes } = await import("../../../cloud/src/api/admin-identity");
    const { createIdentityOAuthIssuanceRoutes } = await import("../../../core/src/api/identity-oauth-issuance");
    router.route("/", createIdentityPublicRoutes());
    router.route("/api/admin/identity", createAdminIdentityRoutes());
    router.route("/api/_internal/identity/v1", createIdentityOAuthIssuanceRoutes());
  }
} else {
  assert(!process.env.CLOUD_IDENTITY_KEY_ENCRYPTION_KEY, "OAuth must not receive Core's KEK");
  const { migrate } = await import("../migrate");
  await migrate();
  const { default: oauthRoutes } = await import("../oauth");
  const { default: adminRoutes } = await import("../api");
  const { ConsentDecisionSchema, completeConsent } = await import("../frontend/consent-action");
  if (current) {
    const tokens = await import("../service/tokens");
    await tokens.ensureConfiguredIssuanceMode();
  }
  router.route("/", oauthRoutes);
  router.route("/api/oauth/admin/clients", adminRoutes);
  router.post("/oauth/consent", rateLimit(), auth.requireRole("authenticated"), auth.requireUser(), v("form", ConsentDecisionSchema), (c) =>
    completeConsent(c, c.req.valid("form")),
  );
}
// Probe only observes the actual platform guard. No actor is injected.
router.get("/_verify/actor", auth.requireRole("authenticated"), (c) =>
  c.json({
    kind: c.get("actor").kind,
    accessSubject: c.get("accessSubject"),
  }),
);
const server = Bun.serve({ hostname: "127.0.0.1", port: core ? 4301 : 4302, fetch: router.fetch });
process.on("message", async (message: unknown) => {
  if (message === "stop") {
    await server.stop(true);
    await sql.close();
    redis.close();
    process.exit(0);
  }
  if (message === "revoke-browser-sessions" && core && current) {
    const [user] = await sql<{ id: string }[]>`SELECT id FROM auth.users WHERE uid = 'admin'`;
    assert(user);
    await auth.session.revokeAllForUser(user.id);
    process.send?.("revoked");
  }
});
process.send?.("ready");
