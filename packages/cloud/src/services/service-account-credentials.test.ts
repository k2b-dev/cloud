import { describe, expect, test } from "bun:test";
import { sql } from "bun";
import { Hono } from "hono";
import meApp from "../api/me";
import { type AuthContext, auth } from "../server/middleware/auth";
import { accounts } from "./accounts";
import { serviceAccountCredentials } from "./service-account-credentials";
import { serviceAccounts } from "./service-accounts";

const canUseDatabase = async () => {
  try {
    const [row] = await sql<
      {
        users: string | null;
        service_accounts: string | null;
        credentials: string | null;
        audit_events: string | null;
        ipa_effective_groups: string | null;
      }[]
    >`
      SELECT
        to_regclass('auth.users')::text AS users,
        to_regclass('auth.service_accounts')::text AS service_accounts,
        to_regclass('auth.service_account_credentials')::text AS credentials,
        to_regclass('audit.events')::text AS audit_events,
        to_regclass('auth.ipa_user_effective_groups')::text AS ipa_effective_groups
    `;
    return Boolean(row?.users && row.service_accounts && row.credentials && row.audit_events && row.ipa_effective_groups);
  } catch {
    return false;
  }
};

/** Reported as skipped rather than silently passing when the backing service is absent. */
const suite = (await canUseDatabase()) ? describe : describe.skip;

const insertUser = async () => {
  const suffix = crypto.randomUUID();
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO auth.users (uid, provider, profile, display_name, mail, given_name, sn)
    VALUES (${`api-key-${suffix}`}, 'local', 'user', 'API Key Test', ${`api-key-${suffix}@example.test`}, 'API', 'Key')
    RETURNING id
  `;
  return row!.id;
};

const credentialState = async (credentialId: string) => {
  const [row] = await sql<{ secret_hash: string; last_used_at: Date | null }[]>`
    SELECT secret_hash, last_used_at
    FROM auth.service_account_credentials
    WHERE id = ${credentialId}::uuid
  `;
  return row ?? null;
};

const successfulAuthenticationEvents = async (credentialId: string): Promise<number> => {
  const [row] = await sql<{ count: string }[]>`
    SELECT COUNT(*)::text AS count
    FROM audit.events
    WHERE action = 'service_account_credential.authenticate'
      AND outcome = 'allowed'
      AND target_type = 'service_account_credential'
      AND target_id = ${credentialId}
  `;
  return Number.parseInt(row?.count ?? "0", 10);
};

const deniedAuthenticationEvents = async (credentialId: string): Promise<number> => {
  const [row] = await sql<{ count: string }[]>`
    SELECT COUNT(*)::text AS count
    FROM audit.events
    WHERE action = 'service_account_credential.authenticate'
      AND outcome = 'denied'
      AND target_type = 'service_account_credential'
      AND target_id = ${credentialId}
  `;
  return Number.parseInt(row?.count ?? "0", 10);
};

suite("serviceAccountCredentials", () => {
  test("creates, authenticates, lists, and revokes user delegated API keys", async () => {
    const userId = await insertUser();
    try {
      const user = await accounts.users.get({ id: userId });
      expect(user).not.toBeNull();
      if (!user) return;

      const created = await serviceAccountCredentials.createUserApiToken({
        user,
        name: "Test key",
        expiresAt: null,
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      expect(created.data.token).toMatch(/^cld_[0-9a-f]{24}_[0-9a-f]{64}$/);
      expect(created.data.credential.name).toBe("Test key");
      expect((await credentialState(created.data.credential.id))?.secret_hash).toMatch(/^sha256:[0-9a-f]{64}$/);

      const authenticated = await serviceAccountCredentials.authenticateApiToken(created.data.token);
      expect(authenticated?.delegatedUser?.id).toBe(user.id);
      expect(authenticated?.serviceAccount.kind).toBe("user_delegated");

      const app = new Hono<AuthContext>().use(auth.requireRole("authenticated")).get("/me", (c) =>
        c.json({
          actorKind: c.get("actor").kind,
          userId: c.get("user").id,
          accessSubject: c.get("accessSubject"),
        }),
      );
      const response = await app.request("/me", {
        headers: { Authorization: `Bearer ${created.data.token}` },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        actorKind: "service_account",
        userId: user.id,
        accessSubject: { type: "user", userId: user.id },
      });

      const meResponse = await meApp.request("/", {
        headers: { Authorization: `Bearer ${created.data.token}` },
      });
      expect(meResponse.status).toBe(200);
      expect((await meResponse.json()).id).toBe(user.id);
      expect(await successfulAuthenticationEvents(created.data.credential.id)).toBe(1);

      const listed = await serviceAccountCredentials.listForDelegatedUser({ userId: user.id });
      expect(listed.map((key) => key.id)).toContain(created.data.credential.id);

      const overview = await serviceAccountCredentials.listOverview({
        filter: { userId: user.id, serviceAccountKind: "user_delegated", credentialStatus: "active" },
      });
      expect(overview.items.map((key) => key.id)).toContain(created.data.credential.id);
      expect(overview.items.find((key) => key.id === created.data.credential.id)?.owner).toMatchObject({
        type: "user",
        userId: user.id,
      });
      expect(await serviceAccountCredentials.getOverview({ id: created.data.credential.id })).toMatchObject({
        id: created.data.credential.id,
        serviceAccount: { kind: "user_delegated", delegatedUserId: user.id },
        owner: { type: "user", userId: user.id },
      });
      expect(await serviceAccountCredentials.getOverview({ id: "not-a-uuid" })).toBeNull();

      await expect(
        sql.begin(async (tx) => {
          const rolledBack = await serviceAccountCredentials.revoke(
            {
              credentialId: created.data.credential.id,
              actor: user,
            },
            { db: tx },
          );
          expect(rolledBack.ok).toBe(true);
          throw new Error("roll back credential revocation fixture");
        }),
      ).rejects.toThrow("roll back credential revocation fixture");
      expect((await serviceAccountCredentials.authenticateApiToken(created.data.token))?.delegatedUser?.id).toBe(user.id);

      const adminRevoked = await serviceAccountCredentials.revoke({
        credentialId: created.data.credential.id,
        actor: user,
      });
      expect(adminRevoked.ok).toBe(true);
      expect((await serviceAccountCredentials.revoke({ credentialId: created.data.credential.id, actor: user })).ok).toBe(true);

      const afterAdminRevoke = await serviceAccountCredentials.authenticateApiToken(created.data.token);
      expect(afterAdminRevoke).toBeNull();

      const second = await serviceAccountCredentials.createUserApiToken({
        user,
        name: "Second test key",
        expiresAt: null,
      });
      expect(second.ok).toBe(true);
      if (!second.ok) return;

      const revoked = await serviceAccountCredentials.revokeForDelegatedUser({
        credentialId: second.data.credential.id,
        user,
      });
      expect(revoked.ok).toBe(true);

      const afterRevoke = await serviceAccountCredentials.authenticateApiToken(second.data.token);
      expect(afterRevoke).toBeNull();
    } finally {
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });

  test("upgrades legacy hashes and coalesces concurrent successful authentication activity", async () => {
    const userId = await insertUser();
    try {
      const user = await accounts.users.get({ id: userId });
      expect(user).not.toBeNull();
      if (!user) return;

      const created = await serviceAccountCredentials.createUserApiToken({
        user,
        name: "Concurrent legacy key",
        expiresAt: null,
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;

      const secret = created.data.token.split("_")[2];
      expect(secret).toHaveLength(64);
      if (!secret) return;

      await sql`
        UPDATE auth.service_account_credentials
        SET secret_hash = ${await Bun.password.hash(secret)},
          last_used_at = NULL
        WHERE id = ${created.data.credential.id}::uuid
      `;

      const authenticated = await Promise.all(
        Array.from({ length: 8 }, () => serviceAccountCredentials.authenticateApiToken(created.data.token)),
      );
      expect(authenticated.every((result) => result?.delegatedUser?.id === user.id)).toBe(true);

      const state = await credentialState(created.data.credential.id);
      expect(state?.secret_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(state?.last_used_at).toBeInstanceOf(Date);
      expect(await successfulAuthenticationEvents(created.data.credential.id)).toBe(1);

      const second = await serviceAccountCredentials.authenticateApiToken(created.data.token);
      expect(second?.delegatedUser?.id).toBe(user.id);
      expect(await successfulAuthenticationEvents(created.data.credential.id)).toBe(1);

      const invalidToken = `${created.data.token.slice(0, -1)}${created.data.token.endsWith("0") ? "1" : "0"}`;
      const deniedBefore = await deniedAuthenticationEvents(created.data.credential.id);
      const denied = await Promise.all(Array.from({ length: 8 }, () => serviceAccountCredentials.authenticateApiToken(invalidToken)));
      expect(denied.every((result) => result === null)).toBe(true);
      expect(await deniedAuthenticationEvents(created.data.credential.id)).toBe(deniedBefore + denied.length);

      const revokedDuringVerification = await serviceAccountCredentials.createUserApiToken({
        user,
        name: "Concurrent revocation key",
        expiresAt: null,
      });
      expect(revokedDuringVerification.ok).toBe(true);
      if (!revokedDuringVerification.ok) return;
      const revokedSecret = revokedDuringVerification.data.token.split("_")[2];
      expect(revokedSecret).toHaveLength(64);
      if (!revokedSecret) return;
      await sql`
        UPDATE auth.service_account_credentials
        SET secret_hash = ${await Bun.password.hash(revokedSecret)}
        WHERE id = ${revokedDuringVerification.data.credential.id}::uuid
      `;
      const verificationBeforeRevoke = serviceAccountCredentials.authenticateApiToken(revokedDuringVerification.data.token);
      await Bun.sleep(20);
      await sql`
        UPDATE auth.service_account_credentials
        SET status = 'revoked', revoked_at = now()
        WHERE id = ${revokedDuringVerification.data.credential.id}::uuid
      `;
      const verificationAfterRevoke = serviceAccountCredentials.authenticateApiToken(revokedDuringVerification.data.token);
      expect(await verificationAfterRevoke).toBeNull();
      expect(await verificationBeforeRevoke).toBeNull();

      await sql`
        UPDATE auth.service_account_credentials
        SET last_used_at = now() - interval '2 minutes'
        WHERE id = ${created.data.credential.id}::uuid
      `;
      expect((await serviceAccountCredentials.authenticateApiToken(created.data.token))?.delegatedUser?.id).toBe(user.id);
      expect(await successfulAuthenticationEvents(created.data.credential.id)).toBe(2);

      await sql`
        UPDATE auth.service_account_credentials
        SET expires_at = now() - interval '1 second'
        WHERE id = ${created.data.credential.id}::uuid
      `;
      expect(await serviceAccountCredentials.authenticateApiToken(created.data.token)).toBeNull();

      await sql`
        UPDATE auth.service_account_credentials
        SET expires_at = NULL
        WHERE id = ${created.data.credential.id}::uuid
      `;
      await sql`
        UPDATE auth.service_accounts
        SET status = 'disabled'
        WHERE id = ${created.data.credential.serviceAccountId}::uuid
      `;
      expect(await serviceAccountCredentials.authenticateApiToken(created.data.token)).toBeNull();
    } finally {
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });

  test("creates, authenticates, lists, and revokes resource-bound API keys", async () => {
    const userId = await insertUser();
    const resourceId = crypto.randomUUID();
    let serviceAccountId: string | null = null;

    try {
      const user = await accounts.users.get({ id: userId });
      expect(user).not.toBeNull();
      if (!user) return;

      const serviceAccount = await serviceAccounts.getOrCreateResourceBound({
        name: "Test notebook integration",
        appId: "notebooks",
        resourceType: "notebook",
        resourceId,
        createdBy: user.id,
      });
      expect(serviceAccount.ok).toBe(true);
      if (!serviceAccount.ok) return;
      serviceAccountId = serviceAccount.data.id;

      const sameServiceAccount = await serviceAccounts.getOrCreateResourceBound({
        name: "Ignored duplicate name",
        appId: "notebooks",
        resourceType: "notebook",
        resourceId,
        createdBy: user.id,
      });
      expect(sameServiceAccount.ok).toBe(true);
      expect(sameServiceAccount.ok ? sameServiceAccount.data.id : null).toBe(serviceAccount.data.id);

      const created = await serviceAccountCredentials.createResourceApiToken({
        serviceAccountId: serviceAccount.data.id,
        actor: user,
        name: "Resource key",
        expiresAt: null,
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      expect(created.data.token).toMatch(/^cld_[0-9a-f]{24}_[0-9a-f]{64}$/);

      const authenticated = await serviceAccountCredentials.authenticateApiToken(created.data.token);
      expect(authenticated?.delegatedUser).toBeNull();
      expect(authenticated?.serviceAccount).toMatchObject({
        kind: "resource_bound",
        appId: "notebooks",
        resourceType: "notebook",
        resourceId,
      });

      const meResponse = await meApp.request("/", {
        headers: { Authorization: `Bearer ${created.data.token}` },
      });
      expect(meResponse.status).toBe(403);
      expect(await meResponse.json()).toEqual({
        message: "Self-service endpoints require a user-backed actor",
        code: "FORBIDDEN",
      });

      const overview = await serviceAccountCredentials.listOverview({
        filter: {
          appId: "notebooks",
          resourceType: "notebook",
          resourceId,
          serviceAccountKind: "resource_bound",
          credentialStatus: "active",
        },
      });
      expect(overview.items.map((key) => key.id)).toContain(created.data.credential.id);
      expect(overview.items.find((key) => key.id === created.data.credential.id)?.owner).toEqual({
        type: "resource",
        appId: "notebooks",
        resourceType: "notebook",
        resourceId,
      });
      expect(await serviceAccountCredentials.getOverview({ id: created.data.credential.id })).toMatchObject({
        id: created.data.credential.id,
        serviceAccount: { id: serviceAccount.data.id, kind: "resource_bound" },
        owner: { type: "resource", appId: "notebooks", resourceType: "notebook", resourceId },
      });

      const revoked = await serviceAccountCredentials.revoke({
        credentialId: created.data.credential.id,
        actor: user,
      });
      expect(revoked.ok).toBe(true);
      expect(await serviceAccountCredentials.authenticateApiToken(created.data.token)).toBeNull();
    } finally {
      if (serviceAccountId) await sql`DELETE FROM auth.service_accounts WHERE id = ${serviceAccountId}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  });
});
