import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import type { User } from "../../contracts/shared";
import { type AuthenticatedOAuthToken, oauthTokens } from "../../services/oauth-tokens";
import {
  type AuthenticatedServiceAccountCredential,
  type ServiceAccountCredential,
  serviceAccountCredentials,
} from "../../services/service-account-credentials";
import type { ServiceAccount } from "../../services/service-accounts";
import { session } from "../../services/session";
import { buildProjectedUser } from "../../services/session/user";
import { type AuthContext, auth, isRequestCredentialCurrent } from "./auth";

const ada = buildProjectedUser({ id: "7bd9706e-6c70-4dd5-946f-0caac02bfc2a", uid: "ada", provider: "local", profile: "user" });
const bob = buildProjectedUser({ id: "0c4f9d1e-4f7e-4b8a-9d55-1f2a3b4c5d6e", uid: "bob", provider: "local", profile: "user" });
const serviceAccount = (id: string): ServiceAccount => ({
  id,
  name: "Reporting",
  kind: "standalone",
  status: "active",
  delegatedUserId: null,
  appId: null,
  resourceType: null,
  resourceId: null,
  createdBy: null,
  createdAt: "2026-09-02T00:00:00.000Z",
});
const reporting = serviceAccount("11111111-1111-4111-8111-111111111111");
const billing = serviceAccount("33333333-3333-4333-8333-333333333333");

const oauthUser = (user: User): AuthenticatedOAuthToken => ({ kind: "user", payload: {}, user, scopes: ["read"] });
const oauthServiceAccount = (account: ServiceAccount): AuthenticatedOAuthToken => ({
  kind: "service_account",
  payload: {},
  serviceAccount: account,
  delegatedUser: null,
  scopes: ["read"],
});

const apiToken = "cld_0123456789abcdef01234567_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const apiKey = (id: string, delegatedUser: User | null = ada): AuthenticatedServiceAccountCredential => ({
  serviceAccount: { ...reporting, kind: "user_delegated", delegatedUserId: delegatedUser?.id ?? null },
  delegatedUser,
  credential: {
    id,
    serviceAccountId: reporting.id,
    name: "CLI",
    kind: "api_token",
    status: "active",
    tokenPrefix: "0123456789abcdef01234567",
    scopes: ["read"],
    expiresAt: null,
    lastUsedAt: null,
    createdBy: null,
    createdAt: "2026-09-02T00:00:00.000Z",
    revokedAt: null,
    revokedBy: null,
  } satisfies ServiceAccountCredential,
});

const sessionLookup = spyOn(session, "authenticateRequest").mockImplementation(async (_c, token) =>
  token === "web-ada"
    ? { user: ada, data: { userId: ada.id, sid: "web", authEpoch: 0, expiresAt: "2099-01-01T00:00:00Z", kind: "web" } }
    : null,
);
const sessionRecheck = spyOn(session, "authenticateUserId");
const apiKeyLookup = spyOn(serviceAccountCredentials, "authenticateApiToken");
const oauthLookup = spyOn(oauthTokens, "verifyAccessToken");
afterEach(() => {
  sessionLookup.mockClear();
  sessionRecheck.mockReset();
  apiKeyLookup.mockReset();
  oauthLookup.mockReset();
});

/** Admits the request the way every route does, then asks again as a long-lived response would. */
const admittedProbe = new Hono<AuthContext>()
  .use(auth.requireRole("authenticated"))
  .get("/", async (c) => c.json({ current: await isRequestCredentialCurrent(c) }));

const isCurrent = async (headers: Record<string, string>): Promise<boolean> => {
  const response = await admittedProbe.request("/", { headers });
  expect(response.status).toBe(200);
  return ((await response.json()) as { current: boolean }).current;
};

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

describe("isRequestCredentialCurrent", () => {
  test("follows the session that admitted the request", async () => {
    sessionRecheck.mockResolvedValueOnce(ada.id);
    expect(await isCurrent({ cookie: "session_token=web-ada" })).toBe(true);
    sessionRecheck.mockResolvedValueOnce(null);
    expect(await isCurrent({ cookie: "session_token=web-ada" })).toBe(false);
    sessionRecheck.mockResolvedValueOnce(bob.id);
    expect(await isCurrent({ cookie: "session_token=web-ada" })).toBe(false);
    expect(sessionRecheck.mock.calls.map(([token]) => token)).toEqual(["web-ada", "web-ada", "web-ada"]);
  });

  test("follows the API key that admitted the request", async () => {
    apiKeyLookup.mockResolvedValueOnce(apiKey("key-1")).mockResolvedValueOnce(apiKey("key-1"));
    expect(await isCurrent(bearer(apiToken))).toBe(true);
    apiKeyLookup.mockResolvedValueOnce(apiKey("key-1")).mockResolvedValueOnce(null);
    expect(await isCurrent(bearer(apiToken))).toBe(false);
    apiKeyLookup.mockResolvedValueOnce(apiKey("key-1")).mockResolvedValueOnce(apiKey("key-2"));
    expect(await isCurrent(bearer(apiToken))).toBe(false);
    apiKeyLookup
      .mockResolvedValueOnce(apiKey("key-1"))
      .mockResolvedValueOnce(apiKey("key-1", { ...ada, accountExpires: "2026-01-01T00:00:00.000Z" }));
    expect(await isCurrent(bearer(apiToken))).toBe(false);
  });

  test("follows an OAuth user token to the same person", async () => {
    oauthLookup.mockResolvedValueOnce(oauthUser(ada)).mockResolvedValueOnce(oauthUser(ada));
    expect(await isCurrent(bearer("oauth-access"))).toBe(true);
    oauthLookup.mockResolvedValueOnce(oauthUser(ada)).mockResolvedValueOnce(oauthUser(bob));
    expect(await isCurrent(bearer("oauth-access"))).toBe(false);
    oauthLookup.mockResolvedValueOnce(oauthUser(ada)).mockResolvedValueOnce(null);
    expect(await isCurrent(bearer("oauth-access"))).toBe(false);
    // The re-check uses the same token and the default audience the route admitted with.
    expect(oauthLookup.mock.calls.map((call) => call.slice(0, 2))).toEqual([
      ["oauth-access", undefined],
      ["oauth-access", undefined],
      ["oauth-access", undefined],
      ["oauth-access", undefined],
      ["oauth-access", undefined],
      ["oauth-access", undefined],
    ]);
  });

  test("follows an OAuth service-account token to the same account", async () => {
    oauthLookup.mockResolvedValueOnce(oauthServiceAccount(reporting)).mockResolvedValueOnce(oauthServiceAccount(reporting));
    expect(await isCurrent(bearer("oauth-access"))).toBe(true);
    oauthLookup.mockResolvedValueOnce(oauthServiceAccount(reporting)).mockResolvedValueOnce(oauthServiceAccount(billing));
    expect(await isCurrent(bearer("oauth-access"))).toBe(false);
    oauthLookup.mockResolvedValueOnce(oauthServiceAccount(reporting)).mockResolvedValueOnce(oauthUser(ada));
    expect(await isCurrent(bearer("oauth-access"))).toBe(false);
  });

  test("passes the route's OAuth audience to the re-check", async () => {
    const probe = new Hono<AuthContext>()
      .use(auth.requireRole("authenticated", { oauthAudience: "app:assistant" }))
      .get("/", async (c) => c.json({ current: await isRequestCredentialCurrent(c, { oauthAudience: async () => "app:assistant" }) }));
    oauthLookup.mockResolvedValueOnce(oauthUser(ada)).mockResolvedValueOnce(oauthUser(ada));
    const response = await probe.request("/", { headers: bearer("oauth-access") });
    expect(await response.json()).toEqual({ current: true });
    expect(oauthLookup.mock.calls.map((call) => call[1])).toEqual(["app:assistant", "app:assistant"]);
  });

  test("fails closed for invocations and requests without an actor", async () => {
    const invocation = new Hono<AuthContext>()
      .use(async (c, next) => {
        c.set("actor", { kind: "user", user: ada });
        c.set("accessSubject", { type: "user", userId: ada.id });
        c.set("credentialKind", "invocation");
        await next();
      })
      .get("/", async (c) => c.json({ current: await isRequestCredentialCurrent(c) }));
    expect(await (await invocation.request("/", { headers: bearer("invocation-token") })).json()).toEqual({ current: false });

    const anonymous = new Hono<AuthContext>().get("/", async (c) => c.json({ current: await isRequestCredentialCurrent(c) }));
    expect(await (await anonymous.request("/", { headers: bearer("oauth-access") })).json()).toEqual({ current: false });
    expect(oauthLookup).not.toHaveBeenCalled();
    expect(apiKeyLookup).not.toHaveBeenCalled();
    expect(sessionRecheck).not.toHaveBeenCalled();
  });
});
