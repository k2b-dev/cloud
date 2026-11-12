import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import { suiteFor } from "../../../../../scripts/fixtures/test-infra";
import "../../../../../scripts/fixtures/authorization-preload";
import { useTestAppRegistry } from "../../../../../scripts/fixtures/app-registry";
import { sql } from "../../runtime/clients";
import { freeipa } from "../../server/services";
import { accountLifecycle } from "../account-lifecycle";
import { accounts } from "../accounts";
import { resolveInvocationAuthority } from "../identity/invocation-actor";
import type { CloudInvocationClaims } from "../identity/invocation-token";
import { mandates } from "../mandates";
import { resolveOAuthTokenActor } from "../oauth-tokens";
import { serviceAccountCredentials } from "../service-account-credentials";
import { session } from "../session";
import { createTestBrowserSignIn, createTestSession } from "../session/session.test-fixture";
import * as settings from "../settings";
import { preserveTestSettings } from "../settings/settings.test-fixture";
import { syncFromIpa, syncUser } from "./sync";

const config = {
  "freeipa.enable": true,
  "freeipa.url": "ipa.example.test",
  "freeipa.service_user": "example",
  "freeipa.service_password": "fictional",
  "freeipa.groups.base_sync": ["cloud"],
  "freeipa.groups.base_ipa_realm": ["people"],
  "freeipa.account_transition_policy": "delete",
  "freeipa.sync_guard.max_user_change_percent": 100,
};

suiteFor(
  "database",
  "valkey",
  "nats",
)("a FreeIPA account lock", () => {
  preserveTestSettings(Object.keys(config));
  useTestAppRegistry(["mail", "spaces"]);
  const uid = `locked-${crypto.randomUUID().slice(0, 8)}`;
  const remote: Record<string, unknown> = {
    uid: [uid],
    givenname: ["Ada"],
    sn: ["Lovelace"],
    mail: [`${uid}@example.test`],
    uidnumber: ["41000"],
    gidnumber: ["41000"],
    nsaccountlock: false,
  };
  let inScope = true;
  let rpc: ReturnType<typeof spyOn<typeof freeipa.client, "call">>;
  let ipaSession: ReturnType<typeof spyOn<typeof freeipa.session, "getServiceSession">>;
  const list = (result: unknown) => ({ id: 0, error: null, result: { truncated: false, result } });
  const userId = async () => (await sql<{ id: string }[]>`SELECT id FROM auth.users WHERE uid = ${uid} AND provider = 'ipa'`)[0]!.id;
  const epoch = async (id: string) =>
    Number((await sql<{ auth_epoch: string }[]>`SELECT auth_epoch FROM auth.users WHERE id = ${id}::uuid`)[0]!.auth_epoch);
  const invocation = (id: string): CloudInvocationClaims => ({
    iss: "http://example.test",
    aud: "app:mail",
    token_use: "invocation",
    sub: id,
    principal_type: "user",
    access_subject_type: "user",
    access_subject_id: id,
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
  });

  const issues = async (id: string) => {
    const app = new Hono().post("/login", async (c) => c.json({ token: await session.create(c, id, { method: "passkey", notify: null }) }));
    return (await app.request("/login", { method: "POST" })).status;
  };

  beforeEach(async () => {
    inScope = true;
    for (const [key, value] of Object.entries(config)) await settings.set(key, value);
    ipaSession = spyOn(freeipa.session, "getServiceSession").mockResolvedValue("fictional-session");
    rpc = spyOn(freeipa.client, "call").mockImplementation(async ({ method }) => {
      if (method === "user_find") return list([remote]);
      if (method === "group_find")
        return list([
          { cn: ["cloud"], member_user: inScope ? [uid] : [] },
          { cn: ["people"], member_user: [uid] },
        ]);
      if (method === "user_show") return { id: 0, error: null, result: { result: remote } };
      throw new Error(`Unexpected FreeIPA call ${method}`);
    });
  });
  afterEach(() => {
    rpc.mockRestore();
    ipaSession.mockRestore();
  });
  afterAll(async () => {
    await sql`DELETE FROM auth.users WHERE uid = ${uid}`;
  });

  test("ends every credential at the next sync and unlocking restores the account", async () => {
    remote.nsaccountlock = false;
    await syncFromIpa();
    const id = await userId();
    const owner = await accounts.users.get({ id });
    if (!owner) throw new Error("Missing synced user");
    const token = await createTestSession(id);
    const apiKey = await serviceAccountCredentials.createUserApiToken({
      user: owner,
      browserSignIn: await createTestBrowserSignIn(id),
      name: "Lock test",
    });
    if (!apiKey.ok) throw new Error(apiKey.error.message);
    const created = await mandates.create({
      authority: { kind: "interactive", userId: id },
      subject: { type: "user", id },
      ownerAppId: "mail",
      workloadType: "incoming.automation",
      workloadId: crypto.randomUUID(),
      policy: { version: 1, apps: ["spaces"], operations: ["capability.query:space.read"], actions: "deny" },
    });
    if (!created.ok) throw new Error(created.error.message);
    const mandate = { mandateId: created.data.id, ownerAppId: "mail", targetAppId: "spaces", operation: "capability.query:space.read" };
    const oauth = async () => ({ client_id: "cloud-cli", id, sub: id, scope: "write", auth_epoch: await epoch(id) });

    expect((await session.authenticate(token))?.user.id).toBe(id);
    expect(await serviceAccountCredentials.authenticateApiToken(apiKey.data.token)).not.toBeNull();
    expect(await resolveOAuthTokenActor(await oauth(), [])).not.toBeNull();
    expect(await resolveInvocationAuthority(invocation(id), sql, [])).not.toBeNull();
    expect((await mandates.validateIssueAuthority(mandate)).ok).toBe(true);

    remote.nsaccountlock = true;
    await syncFromIpa();

    expect(await userId()).toBe(id);
    expect(await session.authenticate(token)).toBeNull();
    await expect(createTestSession(id)).rejects.toThrow("403");
    expect(await serviceAccountCredentials.authenticateApiToken(apiKey.data.token)).toBeNull();
    expect(await resolveOAuthTokenActor(await oauth(), [])).toBeNull();
    expect(await resolveInvocationAuthority(invocation(id), sql, [])).toBeNull();
    expect((await mandates.validateIssueAuthority(mandate)).ok).toBe(false);
    expect((await syncUser(uid)).status).toBe("locked");

    remote.nsaccountlock = false;
    await syncFromIpa();

    expect(await session.authenticate(token)).toBeNull();
    expect((await session.authenticate(await createTestSession(id)))?.user.id).toBe(id);
    expect(await serviceAccountCredentials.authenticateApiToken(apiKey.data.token)).not.toBeNull();
    expect(await resolveOAuthTokenActor(await oauth(), [])).not.toBeNull();
    expect(await resolveInvocationAuthority(invocation(id), sql, [])).not.toBeNull();
    expect((await mandates.validateIssueAuthority(mandate)).ok).toBe(true);
    expect((await syncUser(uid)).status).toBe("synced");
  });

  test("a lock seen at sign-in ends the account's existing sessions", async () => {
    remote.nsaccountlock = false;
    await syncFromIpa();
    const id = await userId();
    const token = await createTestSession(id);
    remote.nsaccountlock = true;
    expect((await syncUser(uid)).status).toBe("locked");
    expect(await session.authenticate(token)).toBeNull();
    await expect(createTestSession(id)).rejects.toThrow("403");
    remote.nsaccountlock = false;
    expect((await syncUser(uid)).status).toBe("synced");
    expect((await session.authenticate(await createTestSession(id)))?.user.id).toBe(id);
  });

  test("an app request cannot open a session for a locked account", async () => {
    remote.nsaccountlock = true;
    await syncFromIpa();
    const id = await userId();
    const app = new Hono().post("/login", async (c) => c.json({ token: await session.create(c, id, { method: "passkey", notify: null }) }));
    expect((await app.request("/login", { method: "POST" })).status).toBe(403);
  });

  test("an unlocked observation that started before a newer lock keeps the lock", async () => {
    remote.nsaccountlock = false;
    await syncFromIpa();
    const id = await userId();
    // A lock recorded after the observation started, as by a concurrent sync.
    await sql`UPDATE auth.user_ipa_data SET locked_at = now() + interval '1 hour' WHERE user_id = ${id}::uuid`;
    expect((await syncUser(uid)).status).toBe("synced");
    expect(await issues(id)).toBe(403);
    await sql`UPDATE auth.user_ipa_data SET locked_at = now() - interval '1 hour' WHERE user_id = ${id}::uuid`;
    expect((await syncUser(uid)).status).toBe("synced");
    expect(await issues(id)).toBe(200);
  });

  test("a locked account that expires or leaves scope keeps its lock until FreeIPA unlocks it", async () => {
    remote.nsaccountlock = true;
    await syncFromIpa();
    const id = await userId();
    inScope = false;
    await syncFromIpa();
    expect(await userId()).toBe(id);
    await sql`UPDATE auth.users SET account_expires = now() - interval '1 day' WHERE id = ${id}::uuid`;
    // Expiry cleanup would delete the FreeIPA account (user_del, refused by the fixture) and demote it.
    expect((await accountLifecycle.demoteExpiredIpaUsers()).scanned).toBe(0);
    expect((await syncUser(uid)).status).toBe("locked");
    expect((await sql<{ provider: string }[]>`SELECT provider FROM auth.users WHERE id = ${id}::uuid`)[0]?.provider).toBe("ipa");
    expect(await issues(id)).toBe(403);
    remote.nsaccountlock = false;
    await syncFromIpa();
    // Unlocked and out of scope: the configured transition (delete) applies now.
    expect(await sql`SELECT id FROM auth.users WHERE id = ${id}::uuid`).toHaveLength(0);
  });
});
