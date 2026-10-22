import { afterAll, afterEach, beforeAll, beforeEach, expect, setSystemTime, spyOn, test } from "bun:test";
import * as webAuthnServer from "@simplewebauthn/server";
import { sql } from "bun";
import { SignJWT } from "jose";
import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
import "../../../../scripts/fixtures/authorization-preload";
import { accounts } from "../services/accounts";
import { prepareIdentitySigner } from "../services/identity/key-ring";
import { getIdentityRuntimeConfig } from "../services/identity/runtime-config";
import { serviceAccountCredentials } from "../services/service-account-credentials";
import { session } from "../services/session";
import { createTestAppSession, createTestSession } from "../services/session/session.test-fixture";
import * as settings from "../services/settings";
import me from "./me";

const suite = databaseSuite();
const fixtureUserIds: string[] = [];
let previousAppUrl: string;
let previousRateLimit: number;
const person = async () => {
  const id = crypto.randomUUID();
  await sql`INSERT INTO auth.users(id,uid,provider,profile) VALUES(${id}::uuid,${`access-${id}`},'local','user')`;
  fixtureUserIds.push(id);
  const user = await accounts.users.get({ id });
  if (!user) throw new Error("Missing fixture account");
  const token = await createTestSession(id);
  const authenticated = await session.authenticate(token);
  if (!authenticated) throw new Error("Missing fixture session");
  return { user, token, browserSignIn: { userId: id, sid: authenticated.data.sid } };
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
const post = (path: string, token: string, body: unknown = {}, language = "en") =>
  me.request(path, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Accept-Language": language },
    body: JSON.stringify(body),
  });
const age = async (sid: string) => sql`UPDATE auth.session_families SET issued_at = now() - interval '11 minutes' WHERE sid = ${sid}::uuid`;
const expectCode = async (response: Response, code: string) => {
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ code });
};

suite("personal access requires a confirmed browser sign-in", () => {
  beforeEach(async () => {
    const [clock] = await sql<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
    setSystemTime(new Date(clock!.now));
  });
  afterEach(() => setSystemTime());

  beforeAll(async () => {
    previousAppUrl = await settings.get<string>("app.url");
    previousRateLimit = await settings.get<number>("security.rate_limit_per_second");
    await settings.set("security.rate_limit_per_second", 1000);
    await settings.set("app.url", "https://cloud.example.test");
  });

  afterAll(async () => {
    for (const id of fixtureUserIds) {
      await sql`DELETE FROM audit.events WHERE actor_user_id = ${id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id = ${id}::uuid`;
    }
    await settings.set("app.url", previousAppUrl);
    await settings.set("security.rate_limit_per_second", previousRateLimit);
  });

  test("OAuth, personal API keys, and app sessions cannot create personal access", async () => {
    const owner = await person();
    const key = await serviceAccountCredentials.createUserApiToken({
      user: owner.user,
      browserSignIn: owner.browserSignIn,
      name: "Existing key",
    });
    if (!key.ok) throw new Error(key.error.message);
    const app = await createTestAppSession(owner.user.id);
    const oauthToken = await oauthUserToken(owner.user.id);
    for (const token of [oauthToken, key.data.token, app.token]) {
      for (const path of ["/api-keys", "/passkeys/registration/start", "/passkeys/registration/verify"]) {
        await expectCode(await post(path, token, { name: "New key" }), "BROWSER_SIGN_IN_REQUIRED");
      }
    }
    const response = await post("/api-keys", oauthToken, { name: "Neu" }, "de");
    expect(await response.json()).toMatchObject({
      code: "BROWSER_SIGN_IN_REQUIRED",
      message: "API-Schlüssel und Passkeys legst du im Browser an.",
    });
  });

  test("aged browser sessions fail both the route and the API key store boundary", async () => {
    const owner = await person();
    await age(owner.browserSignIn.sid);
    const denied = await post("/api-keys", owner.token, { name: "Old session key" }, "de");
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({
      code: "REAUTHENTICATE",
      message: "Melde dich erneut an, um zu bestätigen, dass du es bist.",
    });
    await expectCode(await post("/passkeys/registration/start", owner.token), "REAUTHENTICATE");
    const result = await serviceAccountCredentials.createUserApiToken({
      user: owner.user,
      browserSignIn: owner.browserSignIn,
      name: "Direct old session key",
    });
    expect(result).toMatchObject({ ok: false, error: { code: "REAUTHENTICATE", status: 403 } });
    expect(await sql`SELECT id FROM auth.service_account_credentials WHERE created_by = ${owner.user.id}::uuid`).toHaveLength(0);
    // The refused request does not leave the person's key holder behind either.
    expect(await sql`SELECT id FROM auth.service_accounts WHERE delegated_user_id = ${owner.user.id}::uuid`).toHaveLength(0);
    expect(
      await sql`SELECT id FROM audit.events WHERE actor_user_id = ${owner.user.id}::uuid AND action = 'service_account_credential.create' AND outcome = 'allowed'`,
    ).toHaveLength(0);
  });

  test("a fresh browser creates a key and a different user's sign-in is refused", async () => {
    const owner = await person();
    expect((await post("/api-keys", owner.token, { name: "Fresh key" })).status).toBe(201);
    const other = await person();
    const result = await serviceAccountCredentials.createUserApiToken({
      user: owner.user,
      browserSignIn: other.browserSignIn,
      name: "Wrong account",
    });
    expect(result).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
  });

  test("passkey verification rechecks the session in the insertion transaction", async () => {
    const owner = await person();
    const start = await post("/passkeys/registration/start", owner.token);
    expect(start.status).toBe(200);
    await age(owner.browserSignIn.sid);
    const credentialId = Buffer.from(owner.user.id).toString("base64url");
    const verification = spyOn(webAuthnServer, "verifyRegistrationResponse").mockResolvedValue({
      verified: true,
      registrationInfo: {
        fmt: "none",
        aaguid: "00000000-0000-0000-0000-000000000000",
        credential: { id: credentialId, publicKey: new Uint8Array([1, 2, 3]), counter: 0 },
        credentialType: "public-key",
        attestationObject: new Uint8Array(),
        userVerified: true,
        credentialDeviceType: "singleDevice",
        credentialBackedUp: false,
        origin: "https://cloud.example.test",
        rpID: "cloud.example.test",
      },
    });
    try {
      const registration = {
        name: "Laptop",
        response: {
          id: credentialId,
          rawId: credentialId,
          type: "public-key",
          clientExtensionResults: {},
          response: { clientDataJSON: "e30", attestationObject: "e30", transports: [] },
        },
      };
      await expectCode(await post("/passkeys/registration/verify", owner.token, registration), "REAUTHENTICATE");
      expect(verification).toHaveBeenCalledTimes(1);
      expect(await sql`SELECT id FROM auth.webauthn_credentials WHERE user_id = ${owner.user.id}::uuid`).toHaveLength(0);
      const fresh = await createTestSession(owner.user.id);
      expect((await post("/passkeys/registration/start", fresh)).status).toBe(200);
      expect((await post("/passkeys/registration/verify", fresh, registration)).status).toBe(201);
      expect(await sql`SELECT id FROM auth.webauthn_credentials WHERE user_id = ${owner.user.id}::uuid`).toHaveLength(1);
    } finally {
      verification.mockRestore();
    }
  });
});
