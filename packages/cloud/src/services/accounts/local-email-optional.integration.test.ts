import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { redis, sql } from "bun";
import { Hono } from "hono";
import { suiteFor } from "../../../../../scripts/fixtures/test-infra";
import "../../../../../scripts/fixtures/authorization-preload";
import { createAuthRoutes } from "../../api/auth";
import { magicLink } from "../auth-flows";
import type { AuthNotificationSender } from "../auth-flows/notification-sender";
import * as settings from "../settings";
import { accountsAppService } from "./app";
import type { AccountsNotificationSender } from "./notification-sender";

// The emergency admin login creates a session, which needs the Core identity authority (NATS).
const suite = suiteFor("database", "valkey", "nats");
const SETTING = "user.local_email_optional";
const prefix = `no-mail-${crypto.randomUUID().slice(0, 8)}`;
const address = (name: string) => `${name}.${prefix}@example.test`;
const admin = { userId: crypto.randomUUID(), uid: `${prefix}-admin`, roles: ["admin"], provider: "local" };

const welcomes: string[] = [];
const loginLinks: { email: string; token: string }[] = [];
const accepted = { id: "test", status: "queued" as const };
const sender: AccountsNotificationSender = {
  sendLoginLink: async ({ email, token }) => {
    loginLinks.push({ email, token });
    return accepted;
  },
  sendFreeIpaWelcome: async () => accepted,
  sendLocalWelcome: async ({ userId }) => {
    welcomes.push(userId);
    return accepted;
  },
  sendRequestDenied: async () => accepted,
  sendAdministrativeMessage: async () => accepted,
};
const authSender: AuthNotificationSender = {
  sendMagicLink: async () => ({ id: "test", status: "suppressed" }),
  sendIpaLoginHint: async () => ({ id: "test", status: "suppressed" }),
  sendPasswordReset: async () => ({ id: "test", status: "suppressed" }),
};

const create = (data: { profile?: "user" | "guest"; email?: string | null; requestId?: string; displayName?: string }) =>
  accountsAppService.user.create({
    actor: admin,
    processedBy: admin.userId,
    notificationSender: sender,
    data: {
      provider: "local",
      profile: data.profile ?? "user",
      email: data.email,
      givenname: "Ada",
      sn: prefix,
      displayName: data.displayName,
      autoSendNotification: true,
      requestId: data.requestId,
    },
  });
const stored = async (id: string) =>
  (await sql<{ uid: string; mail: string | null }[]>`SELECT uid, mail FROM auth.users WHERE id = ${id}::uuid`)[0]!;
const update = (id: string, mail: string | null) => accountsAppService.user.update({ actor: admin, id, data: { mail } });
const createdId = async (result: Awaited<ReturnType<typeof create>>) => {
  if (!result.ok) throw new Error(result.error.message);
  return result.data.id;
};

suite("local accounts without email", () => {
  beforeAll(async () => {
    for (const name of ["auth", "settings", "audit", "logging"])
      await (await import(`../../../../core/src/migrate/core/${name}.ts`)).migrate();
  }, 30000);
  beforeEach(() => {
    welcomes.length = 0;
    loginLinks.length = 0;
  });
  afterEach(async () => {
    await settings.remove(SETTING);
  });
  afterAll(async () => {
    await sql`DELETE FROM auth.users WHERE sn = ${prefix} OR lower(mail) LIKE ${`%${prefix}%`}`;
  });

  test("full accounts need an email until the setting allows none; guests and requests always do", async () => {
    const refused = await create({});
    expect(refused).toMatchObject({ ok: false, error: { code: "BAD_INPUT" } });
    if (!refused.ok) expect(refused.error.message).toContain("need an email address");
    // The refused account has no uid or email yet, so its audit entry names the person.
    const [attempt] = await sql<{ outcome: string }[]>`
      SELECT outcome FROM audit.events WHERE action = 'accounts.user.create' AND target_label = ${`Ada ${prefix}`} LIMIT 1`;
    expect(attempt?.outcome).toBe("failed");

    await settings.set(SETTING, true);
    const first = await create({ displayName: `No mail ${prefix}` });
    const second = await create({ email: "   " });
    const firstId = await createdId(first);
    expect((await stored(firstId)).mail).toBeNull();
    expect((await stored(await createdId(second))).mail).toBeNull();
    expect(first).toMatchObject({ ok: true, data: { notificationSent: false } });
    expect(welcomes).toHaveLength(0);
    const [event] = await sql<{ target_label: string }[]>`
      SELECT target_label FROM audit.events WHERE action = 'accounts.user.create' AND target_id = ${firstId} LIMIT 1`;
    expect(event?.target_label).toBe((await stored(firstId)).uid);

    expect(await create({ profile: "guest" })).toMatchObject({ ok: false, error: { code: "BAD_INPUT" } });
    const request = await create({ requestId: crypto.randomUUID() });
    expect(request).toMatchObject({ ok: false, error: { code: "BAD_INPUT" } });
    if (!request.ok) expect(request.error.message).toContain("email address from the request");

    // Uniqueness still applies whenever an address is present.
    expect(await createdId(await create({ email: address("taken") }))).toBeString();
    expect(await create({ email: address("taken").toUpperCase() })).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
  });

  test("an email is removed only while allowed and never from guests or FreeIPA accounts", async () => {
    const id = await createdId(await create({ email: address("removable") }));
    expect(await update(id, null)).toMatchObject({ ok: false, error: { code: "BAD_INPUT" } });
    expect((await stored(id)).mail).toBe(address("removable"));

    await settings.set(SETTING, true);
    expect(await update(id, null)).toMatchObject({ ok: true });
    expect((await stored(id)).mail).toBeNull();
    expect(await accountsAppService.user.setProfile({ actor: admin, id, profile: "guest" })).toMatchObject({
      ok: false,
      error: { code: "BAD_INPUT" },
    });
    expect(await update(id, address("readded"))).toMatchObject({ ok: true });
    expect((await stored(id)).mail).toBe(address("readded"));

    const guest = await createdId(await create({ profile: "guest", email: address("guest") }));
    expect(await update(guest, null)).toMatchObject({ ok: false, error: { code: "BAD_INPUT" } });
    const [ipa] = await sql<{ id: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, mail, sn) VALUES (${`${prefix}-ipa`}, 'ipa', 'user', ${address("ipa")}, ${prefix}) RETURNING id`;
    expect(await update(ipa!.id, null)).toMatchObject({ ok: false, error: { code: "BAD_INPUT" } });
    expect((await stored(ipa!.id)).mail).toBe(address("ipa"));
  });

  test("login tokens are bound to the account, single use and independent of its email", async () => {
    await settings.set(SETTING, true);
    const id = await createdId(await create({}));
    const created = await accountsAppService.user.createLoginToken({ actor: admin, id });
    if (!created.ok) throw new Error(created.error.message);
    const ttl = await redis.ttl(`email-login:${created.data.token}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(300);
    expect(await magicLink.verify({ token: created.data.token })).toMatchObject({ ok: true, userId: id, email: null });
    expect(await magicLink.verify({ token: created.data.token })).toMatchObject({ ok: false, status: 401 });

    expect(await accountsAppService.user.sendLoginLink({ actor: admin, id, notificationSender: sender })).toMatchObject({ ok: false });
    expect(await update(id, address("linked"))).toMatchObject({ ok: true });
    expect(await accountsAppService.user.sendLoginLink({ actor: admin, id, notificationSender: sender })).toMatchObject({ ok: true });
    expect(loginLinks.map((link) => link.email)).toEqual([address("linked")]);
    expect(await update(id, address("changed"))).toMatchObject({ ok: true });
    expect(await magicLink.verify({ token: loginLinks[0]!.token })).toMatchObject({ ok: true, userId: id });

    const expired = await accountsAppService.user.createLoginToken({ actor: admin, id });
    if (!expired.ok) throw new Error(expired.error.message);
    await sql`UPDATE auth.users SET account_expires = now() - interval '1 minute' WHERE id = ${id}::uuid`;
    expect(await magicLink.verify({ token: expired.data.token })).toMatchObject({ ok: false, status: 403 });
  });

  test("the emergency admin account stays without email and gets no administrator-issued sign-in", async () => {
    const previousToken = process.env.ADMIN_LOGIN_TOKEN;
    process.env.ADMIN_LOGIN_TOKEN = `${prefix}-${crypto.randomUUID()}`;
    const app = new Hono().route("/auth", createAuthRoutes(authSender));
    const login = () =>
      app.request("/auth/admin-login", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": `${prefix}-admin-login` },
        body: JSON.stringify({ token: process.env.ADMIN_LOGIN_TOKEN }),
      });
    const [before] = await sql<{ mail: string | null }[]>`SELECT mail FROM auth.users WHERE uid = 'admin'`;
    try {
      expect((await login()).status).toBe(200);
      const [row] = await sql<{ id: string; mail: string | null }[]>`SELECT id, mail FROM auth.users WHERE uid = 'admin'`;
      const id = row!.id;
      await sql`UPDATE auth.users SET mail = NULL WHERE id = ${id}::uuid`;
      expect(await accountsAppService.user.update({ actor: admin, id, data: { displayName: "Admin" } })).toMatchObject({ ok: true });
      expect(await update(id, address("admin"))).toMatchObject({ ok: true });
      // No administrator-issued link or token reaches the shared break-glass identity, with or without an address.
      expect(await accountsAppService.user.sendLoginLink({ actor: admin, id, notificationSender: sender })).toMatchObject({
        ok: false,
        error: { code: "FORBIDDEN" },
      });
      expect(loginLinks).toHaveLength(0);
      expect(await update(id, null)).toMatchObject({ ok: true });
      expect((await login()).status).toBe(200);
      expect((await stored(id)).mail).toBeNull();
      expect(await accountsAppService.user.createLoginToken({ actor: admin, id })).toMatchObject({
        ok: false,
        error: { code: "FORBIDDEN", message: expect.stringContaining("admin login token") },
      });
    } finally {
      await sql`UPDATE auth.users SET mail = ${before?.mail ?? null} WHERE uid = 'admin'`;
      if (previousToken === undefined) delete process.env.ADMIN_LOGIN_TOKEN;
      else process.env.ADMIN_LOGIN_TOKEN = previousToken;
    }
  });
});
