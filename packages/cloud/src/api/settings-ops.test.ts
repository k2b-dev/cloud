import { afterEach, beforeAll, expect, mock, spyOn, test } from "bun:test";
import { Hono } from "hono";
import { createLocalJWKSet, exportJWK, generateKeyPair, type JWTVerifyGetKey, SignJWT } from "jose";
import type { AuthContext } from "../server";
import { requireInvocation } from "../server/middleware/invocation";
import { type CloudInvocationClaims, verifyInvocationToken } from "../services/identity/invocation-token";
import { buildProjectedUser } from "../services/session/user";
import { settingsService } from "../services/settings/app";
import { registerSettings } from "../services/settings/defaults";
import * as diagnostics from "../services/settings/env-status";
import { createSettingsOpsRoutes, settingsInvocationOperation } from "./settings-ops";

const key = "test.env_migration";
registerSettings([
  { key, kind: "string", default: "", group: "test", description: "Test setting", envBootstrap: () => undefined },
  { key: "test.custom_hook", kind: "string", default: "", group: "test", description: "Setting with an app-owned write hook" },
]);
const user = buildProjectedUser({ id: "11111111-1111-4111-8111-111111111111", provider: "local", profile: "user", effective_admin: true });
const kid = "33333333-3333-4333-8333-333333333333";
let signingKey: CryptoKey;
let verificationKey: JWTVerifyGetKey;
beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  signingKey = pair.privateKey;
  verificationKey = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), kid, alg: "RS256", use: "sig" }] });
});
afterEach(() => mock.restore());
const claims = (method: string, route: string): CloudInvocationClaims => ({
  iss: "https://cloud.example",
  aud: "app:demo",
  token_use: "invocation",
  sub: user.id,
  principal_type: "user",
  access_subject_type: "user",
  access_subject_id: user.id,
  act: { sub: "app:core" },
  credential_kind: "oauth",
  scopes: ["admin"],
  op: settingsInvocationOperation(method, route),
  schema_hash: null,
  ver: 1,
  jti: "22222222-2222-4222-8222-222222222222",
  iat: 100,
  nbf: 100,
  exp: 130,
});
const request = async (
  method: "GET" | "PUT",
  route: string,
  options: { admin?: boolean; scopes?: string[]; tokenRoute?: string; body?: unknown } = {},
) => {
  const app = new Hono<AuthContext>()
    .use(
      "/_internal/settings/*",
      requireInvocation(
        (c) => ({
          targetAppId: "demo",
          operation: settingsInvocationOperation(c.req.method, new URL(c.req.url).pathname.slice("/_internal/settings/".length)),
          schemaHash: null,
        }),
        {
          getApp: async () => ({ id: "demo" }),
          verify: (token, expectation, verifyOptions) =>
            verifyInvocationToken(token, expectation, {
              ...verifyOptions,
              issuer: "https://cloud.example",
              key: verificationKey,
              now: new Date(110_000),
            }),
          resolve: async () => ({
            actor: { kind: "user", user: options.admin === false ? { ...user, roles: [] } : user },
            accessSubject: { type: "user", userId: user.id },
            credentialKind: "invocation",
            scopes: options.scopes ?? ["admin"],
          }),
        },
      ),
    )
    .route("/_internal/settings", createSettingsOpsRoutes([key, "test.custom_hook"]));
  const token = await new SignJWT(claims(method, options.tokenRoute ?? route))
    .setProtectedHeader({ alg: "RS256", kid, typ: "cloud-invocation+jwt" })
    .sign(signingKey);
  return app.request(`/_internal/settings/${route}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
};
test("a real signed admin invocation reaches app diagnostics without session reauthentication", async () => {
  const read = spyOn(diagnostics, "readEnvSettingsStatus").mockResolvedValue([]);
  expect((await request("GET", "env")).status).toBe(200);
  expect(read).toHaveBeenCalledTimes(1);
  expect((await request("GET", "env", { admin: false })).status).toBe(403);
  expect((await request("GET", "env", { scopes: ["read"] })).status).toBe(403);
  expect((await request("GET", "env", { tokenRoute: "other" })).status).toBe(401);
  expect(read).toHaveBeenCalledTimes(1);
});
test("migration repair rejects settings with custom write paths and carries replacement intent", async () => {
  const update = spyOn(settingsService.entry, "update").mockResolvedValue({ ok: true, data: undefined });
  expect((await request("PUT", "test.custom_hook", { body: { value: "changed" } })).status).toBe(400);
  expect(update).not.toHaveBeenCalled();
  expect((await request("PUT", key, { body: { value: "repaired", replaceUnreadable: true } })).status).toBe(200);
  expect(update).toHaveBeenCalledWith({ key, value: "repaired", replaceUnreadable: true });
});
test("malformed encoded paths fail authentication without throwing", () => {
  expect(settingsInvocationOperation("GET", "%")).toBe("settings.invalid");
});
