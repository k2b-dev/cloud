import { afterAll, afterEach, beforeAll, beforeEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { SignJWT } from "jose";
import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
import { sql } from "../runtime/clients";
import "../../../../scripts/fixtures/authorization-preload";
import { accounts } from "../services/accounts";
import { prepareIdentitySigner } from "../services/identity/key-ring";
import { getIdentityRuntimeConfig } from "../services/identity/runtime-config";
import { providers } from "../services/providers";
import { serviceAccountCredentials } from "../services/service-account-credentials";
import { session } from "../services/session";
import { createTestAppSession, createTestSession } from "../services/session/session.test-fixture";
import * as settings from "../services/settings";
import { preserveTestSettings } from "../services/settings/settings.test-fixture";
import me from "./me";

const suite = databaseSuite();
const existingKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExistingKeyFixture000000000000000000000000 old@example.test";
const addedKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAddedKeyFixture00000000000000000000000000 new@example.test";
const fixtureUserIds: string[] = [];

const person = async (provider: "ipa" | "local", profile: "user" | "guest" = "user") => {
  const id = crypto.randomUUID();
  await sql`INSERT INTO auth.users(id,uid,provider,profile,mail,account_expires)
    VALUES(${id}::uuid,${`profile-${id}`},${provider},${profile},${`${id}@example.test`},now() + interval '30 days')`;
  if (provider === "ipa") {
    await sql`INSERT INTO auth.user_ipa_data(user_id, ssh_public_keys) VALUES(${id}::uuid, ARRAY[${existingKey}]::text[])`;
  }
  fixtureUserIds.push(id);
  const user = await accounts.users.get({ id });
  if (!user) throw new Error("Missing fixture account");
  const token = await createTestSession(id);
  const authenticated = await session.authenticate(token);
  if (!authenticated) throw new Error("Missing fixture session");
  const browserSignIn = { userId: id, sid: authenticated.data.sid };
  const key = await serviceAccountCredentials.createUserApiToken({ user, browserSignIn, name: "Existing key" });
  if (!key.ok) throw new Error(key.error.message);
  return { user, token, sid: authenticated.data.sid, apiKey: key.data.token };
};
const oauthUserToken = async (userId: string) => {
  const signer = await prepareIdentitySigner("oauth");
  const { issuer } = await getIdentityRuntimeConfig();
  const [user] = await sql<{ auth_epoch: string }[]>`SELECT auth_epoch FROM auth.users WHERE id = ${userId}::uuid`;
  return new SignJWT({ token_use: "access", client_id: "cloud-cli", id: userId, auth_epoch: Number(user!.auth_epoch), scope: "read write" })
    .setProtectedHeader({ alg: "RS256", kid: signer.kid, typ: "JWT" })
    .setIssuer(issuer)
    .setAudience("cloud")
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(signer.key);
};
const request = (method: string, path: string, token: string, body?: unknown) =>
  me.request(path, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const setKeys = (token: string, sshPublicKeys: string[]) => request("PATCH", "/", token, { ipa: { sshPublicKeys } });
const expectCode = async (response: Response, code: string) => {
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ code });
};

suite("profile changes that carry credentials", () => {
  preserveTestSettings(["security.rate_limit_per_second", "freeipa.enable", "user.account.local_guest_expires_days"]);
  let updates: Array<Record<string, unknown>> = [];
  let update: ReturnType<typeof spyOn<typeof providers.ipa.users, "update">>;
  let serviceSession: ReturnType<typeof spyOn<typeof providers.ipa.auth, "getServiceSession">>;

  beforeAll(async () => {
    await settings.set("security.rate_limit_per_second", 1000);
    await settings.set("freeipa.enable", true);
    await settings.set("user.account.local_guest_expires_days", 365);
  });
  beforeEach(async () => {
    const [clock] = await sql<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
    setSystemTime(new Date(clock!.now));
    updates = [];
    serviceSession = spyOn(providers.ipa.auth, "getServiceSession").mockResolvedValue("fixture-session");
    update = spyOn(providers.ipa.users, "update").mockImplementation(async ({ data }) => {
      updates.push(data as Record<string, unknown>);
      return { ok: true, data: undefined };
    });
  });
  afterEach(() => {
    setSystemTime();
    update.mockRestore();
    serviceSession.mockRestore();
  });
  afterAll(async () => {
    for (const id of fixtureUserIds) {
      await sql`DELETE FROM audit.events WHERE actor_user_id = ${id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${id}::uuid`;
    }
  });

  test("API keys, OAuth tokens and app sessions cannot add an SSH key", async () => {
    const owner = await person("ipa");
    const app = await createTestAppSession(owner.user.id);
    await expectCode(await setKeys(owner.apiKey, [existingKey, addedKey]), "BROWSER_SIGN_IN_REQUIRED");
    await expectCode(await setKeys(await oauthUserToken(owner.user.id), [existingKey, addedKey]), "BROWSER_SIGN_IN_REQUIRED");
    await expectCode(await setKeys(app.token, [existingKey, addedKey]), "FORBIDDEN");
    expect(updates).toEqual([]);
  });

  test("an older browser sign-in must confirm a new SSH key, a fresh one adds it", async () => {
    const owner = await person("ipa");
    await sql`UPDATE auth.session_families SET issued_at = now() - interval '11 minutes' WHERE sid = ${owner.sid}::uuid`;
    await expectCode(await setKeys(owner.token, [existingKey, addedKey]), "REAUTHENTICATE");
    expect(updates).toEqual([]);
    const fresh = await createTestSession(owner.user.id);
    expect((await setKeys(fresh, [existingKey, addedKey])).status).toBe(200);
    expect(updates).toEqual([{ ipa: { sshPublicKeys: [existingKey, addedKey] } }]);
  });

  test("removing an SSH key needs a confirmed browser sign-in too", async () => {
    const owner = await person("ipa");
    await expectCode(await setKeys(owner.apiKey, []), "BROWSER_SIGN_IN_REQUIRED");
    await expectCode(await setKeys(await oauthUserToken(owner.user.id), []), "BROWSER_SIGN_IN_REQUIRED");
    await sql`UPDATE auth.session_families SET issued_at = now() - interval '11 minutes' WHERE sid = ${owner.sid}::uuid`;
    await expectCode(await setKeys(owner.token, []), "REAUTHENTICATE");
    expect(updates).toEqual([]);
    expect((await setKeys(await createTestSession(owner.user.id), [])).status).toBe(200);
    expect(updates).toEqual([{ ipa: { sshPublicKeys: [] } }]);
  });

  test("other profile fields keep their credentials", async () => {
    const owner = await person("ipa");
    expect((await request("PATCH", "/", owner.apiKey, { displayName: "Ada", ipa: { phone: "+49 30 1234" } })).status).toBe(200);
    expect(updates).toEqual([{ displayName: "Ada", ipa: { phone: "+49 30 1234" } }]);
  });

  test("an API key cannot extend its own account", async () => {
    const owner = await person("local", "guest");
    const expiry = async () =>
      (await sql<{ account_expires: Date }[]>`SELECT account_expires FROM auth.users WHERE id = ${owner.user.id}::uuid`)[0]!
        .account_expires;
    const before = await expiry();
    await expectCode(await request("POST", "/account-extension", owner.apiKey), "FORBIDDEN");
    expect(await expiry()).toEqual(before);
    expect((await request("POST", "/account-extension", await oauthUserToken(owner.user.id))).status).toBe(200);
    expect((await request("POST", "/account-extension", owner.token)).status).toBe(200);
    expect((await expiry()).getTime()).toBeGreaterThan(before.getTime());
  });
});
