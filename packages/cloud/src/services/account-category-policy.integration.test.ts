import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { redis, type Server, sql } from "bun";
import { Hono } from "hono";
import adminSettings from "../api/admin-core-settings";
import { createAuthRoutes } from "../api/auth";
import { DEFAULT_ACCOUNT_CATEGORY_POLICY } from "../contracts/account-categories";
import { isAccountCategoryAllowed, readAccountCategoryPolicy } from "./account-category-policy";
import { accounts } from "./accounts";
import { ipa, magicLink, passwordReset } from "./auth-flows";
import type { AuthNotificationSender } from "./auth-flows/notification-sender";
import { createIdentityPublicRoutes } from "./identity";
import { resolveInvocationAuthority } from "./identity/invocation-actor";
import type { CloudInvocationClaims } from "./identity/invocation-token";
import { invalidateIdentityRuntimeConfig } from "./identity/runtime-config";
import { mandates } from "./mandates";
import { resolveOAuthTokenActor } from "./oauth-tokens";
import { providers } from "./providers";
import { serviceAccountCredentials } from "./service-account-credentials";
import { session } from "./session";
import { createTestSession } from "./session/test-fixture";
import * as settings from "./settings";
import { encryptValue } from "./settings/crypto";

// Opt-in only: this suite changes access policy and must never use a developer DB/cache.
const requested = process.env.CLOUD_ACCOUNT_CATEGORY_TEST === "1";
const suite = requested ? describe : describe.skip;
const policyKeys = ["guest", "login", "freeipa"]
  .flatMap((category) => [`user.category.${category}.enabled`, `user.category.${category}.visible`])
  .concat("user.category.login.label");
const localFull = { provider: "local", profile: "user" } as const;
const deliveries: string[] = [];
const sender: AuthNotificationSender = {
  sendMagicLink: async ({ token }) => {
    deliveries.push(token);
    return { id: "test", status: "suppressed" };
  },
  sendIpaLoginHint: async () => ({ id: "test", status: "suppressed" }),
  sendPasswordReset: async () => ({ id: "test", status: "suppressed" }),
};

suite("isolated account category policy", () => {
  let server: Server<unknown>;
  const user = async (provider = "local", profile = "user") => {
    const uid = `category-${crypto.randomUUID()}`;
    const [row] = await sql<
      { id: string; mail: string }[]
    >`INSERT INTO auth.users(uid, provider, profile, mail) VALUES (${uid}, ${provider}, ${profile}, ${`${uid}@example.test`}) RETURNING id, mail`;
    return row!;
  };
  beforeAll(async () => {
    if (
      new URL(process.env.DATABASE_URL!).pathname !== "/cloud_category_test" ||
      new URL(process.env.DATABASE_URL!).hostname !== "127.0.0.1" ||
      new URL(process.env.REDIS_URL!).port !== "56389"
    )
      throw new Error("Dedicated category-test database and cache required");
    for (const name of ["auth", "settings", "audit", "logging"])
      await (await import(`../../../core/src/migrate/core/${name}.ts`)).migrate();
    await (await import("../../../oauth/src/migrate.ts")).migrate();
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: createIdentityPublicRoutes().fetch });
    await settings.set("app.url", `http://127.0.0.1:${server.port}`);
    invalidateIdentityRuntimeConfig();
  }, 30000);
  beforeEach(async () => {
    for (const key of policyKeys) await settings.remove(key);
    await settings.set("user.allow_self_registration", false);
    deliveries.length = 0;
  });
  afterAll(async () => {
    await server?.stop(true);
  });

  test("absent settings preserve access and custom labels have one policy snapshot", async () => {
    expect(await readAccountCategoryPolicy()).toEqual(DEFAULT_ACCOUNT_CATEGORY_POLICY);
    await settings.set("user.category.login.label", "  Firmenaccount  ");
    await settings.set("user.category.guest.visible", false);
    expect((await readAccountCategoryPolicy()).login.label).toBe("Firmenaccount");
    expect(await isAccountCategoryAllowed({ provider: "local", profile: "guest" })).toBe(true);
  });

  test("disabled FreeIPA rejects password operations before contacting the provider", async () => {
    await settings.set("user.category.freeipa.enabled", false);
    const login = spyOn(providers.ipa.auth, "login");
    const change = spyOn(providers.ipa.auth, "changeExpiredPassword");
    try {
      expect(await ipa.login({ username: "nobody", password: "unused" })).toMatchObject({ ok: false, status: 403 });
      expect(await ipa.changeExpiredPassword({ username: "nobody", currentPassword: "unused", newPassword: "unused" })).toMatchObject({
        ok: false,
        status: 403,
      });
      expect(await passwordReset.request({ email: "nobody@example.test" }, sender)).toMatchObject({ ok: true });
      expect(await passwordReset.complete({ token: "unused", newPassword: "unused" })).toMatchObject({ ok: false, status: 403 });
      expect(login).not.toHaveBeenCalled();
      expect(change).not.toHaveBeenCalled();
    } finally {
      login.mockRestore();
      change.mockRestore();
    }
  });

  test("durable denial beats a stale cache and malformed values fail closed", async () => {
    await settings.set("user.category.login.enabled", false);
    await redis.set("settings:user.category.login.enabled", "true");
    expect(await isAccountCategoryAllowed(localFull)).toBe(false);
    await sql`UPDATE settings.entries SET value = ${await encryptValue("false")} WHERE key = 'user.category.login.enabled'`;
    await expect(isAccountCategoryAllowed(localFull)).rejects.toThrow("Invalid account category");
    await expect(readAccountCategoryPolicy()).rejects.toThrow("Invalid account category");
  });

  test("admin API authorizes, saves atomically, audits, and enforces self-disable on the next request", async () => {
    const existing = await user();
    const token = await createTestSession(existing.id);
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    expect((await adminSettings.request("/account-categories")).status).toBe(401);
    expect((await adminSettings.request("/account-categories", { headers })).status).toBe(403);
    await sql`UPDATE auth.users SET admin = true WHERE id = ${existing.id}::uuid`;
    expect((await adminSettings.request("/account-categories", { headers })).status).toBe(200);
    const save = (updates: Record<string, unknown>) =>
      adminSettings.request("/", { method: "PUT", headers, body: JSON.stringify({ updates }) });
    expect((await save({ "user.category.login.label": "Must roll back", "user.category.guest.enabled": "invalid" })).status).toBe(400);
    expect((await readAccountCategoryPolicy()).login.label).toBe("Login");
    expect((await save({ "user.category.login.label": "Firmenaccount", "user.category.login.visible": false })).status).toBe(204);
    expect((await adminSettings.request("/account-categories", { headers })).status).toBe(200);
    expect((await readAccountCategoryPolicy()).login).toEqual({ enabled: true, visible: false, label: "Firmenaccount" });
    expect(
      await sql`SELECT id FROM audit.events WHERE action = 'accounts.categories.configure' AND actor_user_id = ${existing.id}::uuid`,
    ).toHaveLength(1);
    expect((await save({ "user.category.login.enabled": false })).status).toBe(204);
    expect((await adminSettings.request("/account-categories", { headers })).status).toBe(401);
  });

  test("hidden accounts keep sessions; disabling gates existing and new sessions without deletion", async () => {
    const existing = await user();
    const token = await createTestSession(existing.id);
    await settings.set("user.category.login.visible", false);
    expect((await session.authenticate(token))?.user.id).toBe(existing.id);
    await settings.set("user.category.login.enabled", false);
    expect(await session.authenticate(token)).toBeNull();
    await expect(createTestSession(existing.id)).rejects.toThrow("403");
    expect(await sql`SELECT id FROM auth.users WHERE id = ${existing.id}::uuid`).toHaveLength(1);
    await settings.set("user.category.login.enabled", true);
    expect((await session.authenticate(token))?.user.id).toBe(existing.id);
  });

  test("local creation and promotion reject disabled target categories", async () => {
    await settings.set("user.category.login.enabled", false);
    expect(
      await providers.local.users.create({ data: { email: "new@example.test" }, profile: "user", accountExpires: null }),
    ).toMatchObject({ ok: false, status: 403 });
    const guest = await user("local", "guest");
    expect(await providers.local.users.setProfile({ id: guest.id, profile: "user", accountExpires: null })).toMatchObject({
      ok: false,
      status: 403,
    });
    expect((await sql`SELECT profile FROM auth.users WHERE id = ${guest.id}::uuid`)[0]!.profile).toBe("guest");
  });

  test("category-bound magic links prevent crossover; legacy links remain valid", async () => {
    const existing = await user();
    expect(await magicLink.request({ email: existing.mail, category: "guest" }, sender)).toEqual({ ok: true });
    expect(deliveries).toHaveLength(0);
    await magicLink.request({ email: existing.mail, category: "login" }, sender);
    expect(deliveries).toHaveLength(1);
    expect(await magicLink.verify({ token: deliveries[0]! })).toMatchObject({ ok: true, userId: existing.id });
    const legacy = await providers.local.auth.createMagicLinkToken({ email: existing.mail });
    expect(await magicLink.verify({ token: legacy })).toMatchObject({ ok: true, userId: existing.id });
    const pending = await providers.local.auth.createMagicLinkToken({ email: existing.mail, category: "login" });
    await settings.set("user.category.login.enabled", false);
    expect(await magicLink.verify({ token: pending })).toMatchObject({ ok: false, status: 403 });
  });

  test("guest registration cannot create full accounts or disabled guests", async () => {
    await settings.set("user.allow_self_registration", true);
    await magicLink.request({ email: "never-full@example.test", category: "login" }, sender);
    expect(deliveries).toHaveLength(0);
    const pending = await providers.local.auth.createMagicLinkToken({ email: "never-guest@example.test", category: "guest" });
    await settings.set("user.category.guest.enabled", false);
    expect(await magicLink.verify({ token: pending })).toMatchObject({ ok: false });
    expect(await sql`SELECT id FROM auth.users WHERE mail = 'never-guest@example.test'`).toHaveLength(0);
  });

  test("OAuth and cross-app invocations recheck the current category", async () => {
    const existing = await user("ipa", "guest");
    const oauth = { client_id: "cloud-cli", id: existing.id, sub: existing.id, scope: "read" };
    const claims: CloudInvocationClaims = {
      iss: "http://example.test",
      aud: "app:mail",
      token_use: "invocation",
      sub: existing.id,
      principal_type: "user",
      access_subject_type: "user",
      access_subject_id: existing.id,
      act: { sub: "app:core" },
      credential_kind: "session",
      scopes: [],
      op: "capability.query:messages",
      schema_hash: null,
      ver: 1,
      jti: crypto.randomUUID(),
      iat: 1,
      nbf: 1,
      exp: 30,
    };
    expect(await resolveOAuthTokenActor(oauth, [])).not.toBeNull();
    expect(await resolveInvocationAuthority(claims, sql, [])).not.toBeNull();
    await settings.set("user.category.freeipa.enabled", false);
    expect(await resolveOAuthTokenActor(oauth, [])).toBeNull();
    expect(await resolveInvocationAuthority(claims, sql, [])).toBeNull();
  });

  test("emergency recovery requires a valid token and explicit restoration", async () => {
    const [before] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM audit.events WHERE action = 'auth.admin-recovery'`;
    await settings.set("user.category.login.enabled", false);
    await settings.set("user.category.login.visible", false);
    const app = new Hono().route("/auth", createAuthRoutes(sender));
    const login = (token: string, restoreLocalLogin = false) =>
      app.request("/auth/admin-login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, restoreLocalLogin }),
      });
    expect((await login("invalid", true)).status).toBe(401);
    expect((await login(process.env.ADMIN_LOGIN_TOKEN!)).status).toBe(403);
    expect(await isAccountCategoryAllowed(localFull)).toBe(false);
    expect((await login(process.env.ADMIN_LOGIN_TOKEN!, true)).status).toBe(200);
    expect(await isAccountCategoryAllowed(localFull)).toBe(true);
    expect((await readAccountCategoryPolicy()).login.visible).toBe(false);
    expect(await sql`SELECT id FROM audit.events WHERE action = 'auth.admin-recovery'`).toHaveLength(before!.count + 1);
  });

  test("delegated API keys stop with their user, while independent resource credentials remain valid", async () => {
    const existing = await user();
    const owner = await accounts.users.get({ id: existing.id });
    if (!owner) throw new Error("Missing fixture user");
    const delegated = await serviceAccountCredentials.createUserApiToken({ user: owner, name: "Category test" });
    if (!delegated.ok) throw new Error(delegated.error.message);
    const [resource] = await sql<
      { id: string }[]
    >`INSERT INTO auth.service_accounts(name, kind, app_id, resource_type, resource_id) VALUES ('Category resource', 'resource_bound', 'mail', 'mailbox', ${crypto.randomUUID()}) RETURNING id`;
    const independent = await serviceAccountCredentials.createApiToken({ serviceAccountId: resource!.id, name: "Independent" });
    if (!independent.ok) throw new Error(independent.error.message);
    expect(await serviceAccountCredentials.authenticateApiToken(delegated.data.token)).not.toBeNull();
    await settings.set("user.category.login.enabled", false);
    expect(await serviceAccountCredentials.authenticateApiToken(delegated.data.token)).toBeNull();
    expect(await serviceAccountCredentials.authenticateApiToken(independent.data.token)).not.toBeNull();
  });

  test("background mandates recheck category access without revoking the mandate", async () => {
    const existing = await user();
    const created = await mandates.create({
      authority: { kind: "interactive", userId: existing.id },
      subject: { type: "user", id: existing.id },
      ownerAppId: "mail",
      workloadType: "incoming.automation",
      workloadId: crypto.randomUUID(),
      policy: { version: 1, apps: ["spaces"], operations: ["capability.query:space.read"], actions: "deny" },
    });
    if (!created.ok) throw new Error(created.error.message);
    const request = { mandateId: created.data.id, ownerAppId: "mail", targetAppId: "spaces", operation: "capability.query:space.read" };
    expect((await mandates.validateIssueAuthority(request)).ok).toBe(true);
    await settings.set("user.category.login.enabled", false);
    expect((await mandates.validateIssueAuthority(request)).ok).toBe(false);
    await settings.set("user.category.login.enabled", true);
    expect((await mandates.validateIssueAuthority(request)).ok).toBe(true);
  });
});
