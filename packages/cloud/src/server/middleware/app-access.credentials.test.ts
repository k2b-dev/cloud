import { afterEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { Hono } from "hono";
import { person } from "../../_internal/define-app.test-fixture";
import { appAccess } from "../../contracts/app-access";
import { type AuthenticatedOAuthToken, oauthTokens } from "../../services/oauth-tokens";
import { type AuthenticatedServiceAccountCredential, serviceAccountCredentials } from "../../services/service-account-credentials";
import type { ServiceAccount } from "../../services/service-accounts";
import { session } from "../../services/session";
import { appAccessRevalidator } from "./app-access";
import { type AuthContext, auth } from "./auth";

const account: ServiceAccount = {
  id: "22222222-2222-4222-8222-222222222222",
  kind: "standalone",
  status: "active",
  name: "Fixture",
  delegatedUserId: null,
  appId: null,
  resourceType: null,
  resourceId: null,
  createdBy: null,
  createdAt: "2026-10-01T00:00:00Z",
};
const token = "cld_0123456789abcdef01234567_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const key = (scopes: string[], delegated = false): AuthenticatedServiceAccountCredential => ({
  serviceAccount: delegated ? { ...account, kind: "user_delegated", delegatedUserId: person.id } : account,
  delegatedUser: delegated ? person : null,
  credential: {
    id: "33333333-3333-4333-8333-333333333333",
    serviceAccountId: account.id,
    name: "Fixture",
    kind: "api_token",
    status: "active",
    tokenPrefix: "0123456789abcdef01234567",
    scopes,
    expiresAt: null,
    lastUsedAt: null,
    createdBy: null,
    createdAt: "2026-10-01T00:00:00Z",
    revokedAt: null,
    revokedBy: null,
  },
});
const spies: { mockRestore(): void }[] = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
  setSystemTime();
});
const admit = async (headers: Record<string, string>) => {
  let revalidate = async () => false;
  const app = new Hono<AuthContext>().use(auth.requireRole("authenticated")).get("/socket", (c) => {
    revalidate = appAccessRevalidator(c, { id: "demo", access: appAccess.signedIn() });
    return c.text("ready");
  });
  expect((await app.request("/socket", { headers })).status).toBe(200);
  return () => revalidate();
};

describe("fresh live credentials", () => {
  test("rechecks a key's current account, expiry and scopes instead of retaining handshake constraints", async () => {
    setSystemTime(new Date("2026-10-22T12:00:00Z"));
    spies.push(spyOn(session, "authenticateRequest").mockResolvedValue(null));
    const lookup = spyOn(serviceAccountCredentials, "authenticateApiToken").mockResolvedValue(key(["read"]));
    spies.push(lookup);
    const current = await admit({ authorization: `Bearer ${token}` });
    expect(await current()).toBe(true);
    lookup.mockResolvedValue(null);
    expect(await current()).toBe(false);
    lookup.mockResolvedValue(key([]));
    expect(await current()).toBe(false);
    lookup.mockResolvedValue({ ...key(["read"]), serviceAccount: { ...account, status: "disabled" } });
    expect(await current()).toBe(false);
    const expired = key(["read"]);
    expired.credential.expiresAt = "2026-10-21T00:00:00Z";
    lookup.mockResolvedValue(expired);
    expect(await current()).toBe(false);
  });

  test("a narrowed personal key cannot turn into the legacy empty-scope unrestricted form", async () => {
    spies.push(spyOn(session, "authenticateRequest").mockResolvedValue(null));
    const lookup = spyOn(serviceAccountCredentials, "authenticateApiToken").mockResolvedValue(key([], true));
    spies.push(lookup);
    const current = await admit({ authorization: `Bearer ${token}` });
    expect(await current()).toBe(true);
    lookup.mockResolvedValue(key(["other:read"], true));
    expect(await current()).toBe(false);
  });

  test("OAuth refresh keeps the principal and fails closed after scope changes or account expiry", async () => {
    setSystemTime(new Date("2026-10-22T12:00:00Z"));
    spies.push(spyOn(session, "authenticateRequest").mockResolvedValue(null));
    const value: AuthenticatedOAuthToken = { kind: "user", user: person, scopes: ["read"], payload: {} };
    const lookup = spyOn(oauthTokens, "verifyAccessToken").mockResolvedValue(value);
    spies.push(lookup);
    const current = await admit({ authorization: "Bearer oauth-fixture" });
    expect(await current()).toBe(true);
    lookup.mockResolvedValue({ ...value, scopes: ["admin"] });
    expect(await current()).toBe(false);
    lookup.mockResolvedValue({ ...value, user: { ...person, accountExpires: "2026-10-21T00:00:00Z" } });
    expect(await current()).toBe(false);
    lookup.mockResolvedValue({ ...value, user: { ...person, id: "44444444-4444-4444-8444-444444444444" } });
    expect(await current()).toBe(false);
  });
});
