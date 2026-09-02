import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { User } from "../../contracts/shared";
import type { CloudInvocationClaims } from "../../services/identity/invocation-token";
import type { AuthContext } from "./auth";
import { requireInvocation, requireInvocationOrLegacy } from "./invocation";

const user: User = {
  id: "11111111-1111-4111-8111-111111111111",
  uid: "reviewer",
  provider: "local",
  profile: "user",
  roles: ["user", "local", "local/user"],
  givenname: "Review",
  sn: "User",
  displayName: "Review User",
  mail: null,
  avatarHash: null,
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
  ipa: null,
};

const claims: CloudInvocationClaims = {
  iss: "https://cloud.example",
  aud: "app:demo",
  token_use: "invocation",
  sub: user.id,
  principal_type: "user",
  access_subject_type: "user",
  access_subject_id: user.id,
  act: { sub: "app:core" },
  credential_kind: "oauth",
  scopes: ["read"],
  op: "capability.query:read",
  schema_hash: "a".repeat(64),
  ver: 1,
  jti: "22222222-2222-4222-8222-222222222222",
  iat: 100,
  nbf: 100,
  exp: 130,
};

const expected = () => ({ targetAppId: "demo", operation: claims.op, schemaHash: claims.schema_hash });
const invocationCandidate = `${Buffer.from(
  JSON.stringify({ alg: "RS256", kid: "33333333-3333-4333-8333-333333333333", typ: "cloud-invocation+jwt" }),
).toString("base64url")}.e30.signature`;

describe("invocation middleware", () => {
  test("installs the current resolved authority and source OAuth scopes", async () => {
    const app = new Hono<AuthContext>()
      .use(
        requireInvocation(expected, {
          verify: async () => claims,
          resolve: async () => ({
            actor: { kind: "user", user },
            accessSubject: { type: "user", userId: user.id },
            credentialKind: "invocation",
            scopes: ["read"],
          }),
        }),
      )
      .get("/", (c) => c.json({ kind: c.get("credentialKind"), scopes: c.get("oauthScopes"), userId: c.get("user").id }));

    const response = await app.request("/", { headers: { authorization: `Bearer ${invocationCandidate}` } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ kind: "invocation", scopes: ["read"], userId: user.id });
  });

  test("strict mode rejects non-invocation credentials before verification", async () => {
    let verified = false;
    const app = new Hono<AuthContext>()
      .use(
        requireInvocation(expected, {
          verify: async () => {
            verified = true;
            return claims;
          },
        }),
      )
      .get("/", (c) => c.text("ok"));

    const response = await app.request("/", { headers: { authorization: "Bearer cld_source" } });
    expect(response.status).toBe(401);
    expect(verified).toBeFalse();
  });

  test("rolling compatibility delegates only non-invocation credentials to legacy auth", async () => {
    let legacyCalls = 0;
    const legacy = async (_c: Parameters<ReturnType<typeof requireInvocationOrLegacy>>[0], next: () => Promise<void>) => {
      legacyCalls += 1;
      await next();
    };
    const app = new Hono<AuthContext>().use(requireInvocationOrLegacy(expected, legacy)).get("/", (c) => c.text("ok"));

    expect((await app.request("/", { headers: { authorization: "Bearer cld_source" } })).status).toBe(200);
    expect(legacyCalls).toBe(1);
  });
});
