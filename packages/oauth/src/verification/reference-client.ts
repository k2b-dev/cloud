import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createRemoteJWKSet, type JWTPayload, jwtVerify } from "jose";
import { z } from "zod";

// Deliberately no Cloud imports, database reads, signer access, or fetch mocks.
// Expectations are the pre-JWT public wire contract, not production schemas.
const TokenResponse = z
  .object({
    access_token: z.string(),
    token_type: z.literal("Bearer"),
    expires_in: z.literal(3600),
    scope: z.string(),
    refresh_token: z.string().optional(),
    id_token: z.string().optional(),
  })
  .strict();
export type Tokens = z.infer<typeof TokenResponse>;
export type Client = { clientId: string; clientSecret?: string; id?: string; isPublic: boolean };
export const issuer = "http://127.0.0.1:4300";
export const callback = "http://127.0.0.1:4399/callback";
export const resource = `${issuer}/api/reference`;
const jwks = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`), { cooldownDuration: 0 });
export const request = (path: string, init?: RequestInit) =>
  fetch(new URL(path, issuer), {
    ...init,
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  });
export const json = async (response: Response, status = 200): Promise<unknown> => {
  // Do not include potentially credential-bearing bodies in assertion output.
  assert.equal(response.status, status, `HTTP status for ${new URL(response.url).pathname}`);
  assert.match(response.headers.get("content-type") ?? "", /application\/json/);
  return response.json();
};
export const login = async () => {
  const response = await request("/api/auth/admin-login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: process.env.ADMIN_LOGIN_TOKEN }),
  });
  const body = z.object({ session_token: z.string(), user: z.object({ id: z.string() }) }).parse(await json(response));
  const cookie = response.headers.get("set-cookie") ?? "";
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Lax/i);
  assert(cookie.startsWith("session_token="));
  return { cookie: cookie.split(";")[0]!, token: body.session_token, userId: body.user.id };
};
export const createClient = async (cookie: string, name: string, isPublic: boolean, serviceAccountId?: string): Promise<Client> => {
  const response = await request("/api/oauth/admin/clients", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({
      name,
      isPublic,
      redirectUris: [callback],
      audiences: ["cloud", resource],
      scopes: serviceAccountId ? ["read", "write"] : ["openid", "profile", "email", "groups", "offline_access", "read", "write"],
      ...(serviceAccountId ? { serviceAccountId } : {}),
    }),
  });
  return z
    .object({ clientId: z.string(), id: z.string(), clientSecret: z.string().optional(), isPublic: z.boolean() })
    .parse(await json(response));
};
export const authorize = async (client: Client, cookie: string, options: { resource?: string; pkce?: boolean; groups?: boolean } = {}) => {
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(16).toString("hex");
  const nonce = randomBytes(16).toString("hex");
  const query = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: callback,
    response_type: "code",
    scope: "openid profile email offline_access read",
    state,
    nonce,
  });
  if (options.groups) query.set("scope", `${query.get("scope")} groups`);
  if (options.pkce !== false) {
    query.set("code_challenge", createHash("sha256").update(verifier).digest("base64url"));
    query.set("code_challenge_method", "S256");
  }
  if (options.resource) query.set("resource", options.resource);
  const response = await request(`/oauth/authorize?${query}`, { headers: { cookie } });
  assert.equal(response.status, 302);
  let location = new URL(response.headers.get("location")!, issuer);
  if (location.pathname === "/oauth/consent") {
    assert.equal(location.origin, issuer);
    const consent = location.searchParams.get("request");
    assert(consent);
    const approved = await request("/oauth/consent", {
      method: "POST",
      headers: { cookie, origin: issuer, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ request: consent, decision: "approve" }),
    });
    assert.equal(approved.status, 302);
    location = new URL(approved.headers.get("location")!, issuer);
  }
  assert.equal(location.origin + location.pathname, callback);
  assert.equal(location.searchParams.get("state"), state);
  assert.equal(location.searchParams.get("iss"), issuer);
  const code = location.searchParams.get("code");
  assert(code, "Authorization did not return a code");
  return { code, verifier, nonce, resource: options.resource };
};
export const register = async (): Promise<Client> => {
  const response = await request("/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Dynamic reference",
      redirect_uris: [callback],
      application_type: "native",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: "openid profile email offline_access read",
    }),
  });
  const metadata = z
    .object({
      client_id: z.string(),
      client_id_issued_at: z.number(),
      client_name: z.literal("Dynamic reference"),
      application_type: z.literal("native"),
      redirect_uris: z.array(z.string()),
      grant_types: z.array(z.string()),
      response_types: z.array(z.string()),
      token_endpoint_auth_method: z.literal("none"),
      scope: z.string(),
    })
    .strict()
    .parse(await json(response, 201));
  assert.deepEqual(metadata.redirect_uris, [callback]);
  assert.deepEqual(metadata.grant_types, ["authorization_code", "refresh_token"]);
  assert.deepEqual(metadata.response_types, ["code"]);
  assert.equal(metadata.scope, "openid profile email offline_access read");
  return { clientId: metadata.client_id, isPublic: true };
};
export const tokenRequest = (client: Client, fields: Record<string, string>, basic = false) => {
  const headers = new Headers({ "content-type": "application/x-www-form-urlencoded" });
  const body = new URLSearchParams(fields);
  if (basic) headers.set("authorization", `Basic ${Buffer.from(`${client.clientId}:${client.clientSecret}`).toString("base64")}`);
  else {
    body.set("client_id", client.clientId);
    if (client.clientSecret) body.set("client_secret", client.clientSecret);
  }
  return request("/oauth/token", { method: "POST", headers, body });
};
export const tokens = async (response: Response): Promise<Tokens> => {
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);
  assert.equal(response.headers.get("pragma"), "no-cache");
  return TokenResponse.parse(await json(response));
};
export const exchange = (client: Client, grant: Awaited<ReturnType<typeof authorize>>, basic = false) =>
  tokenRequest(
    client,
    {
      grant_type: "authorization_code",
      code: grant.code,
      redirect_uri: callback,
      code_verifier: grant.verifier,
      ...(grant.resource ? { resource: grant.resource } : {}),
    },
    basic,
  );
export const refresh = (client: Client, token: string, scope?: string, audience?: string) =>
  tokenRequest(client, {
    grant_type: "refresh_token",
    refresh_token: token,
    ...(scope ? { scope } : {}),
    ...(audience ? { resource: audience } : {}),
  });
export const verify = async (token: string, audience: string): Promise<JWTPayload> => {
  const result = await jwtVerify(token, jwks, { issuer, audience, algorithms: ["RS256"] });
  assert.equal(result.payload.exp! - result.payload.iat!, 3600);
  assert.equal(result.protectedHeader.alg, "RS256");
  assert.equal(typeof result.protectedHeader.kid, "string");
  assert.deepEqual(Object.keys(result.protectedHeader).sort(), ["alg", "kid"]);
  return result.payload;
};
export const userinfo = async (token: string) => json(await request("/oauth/userinfo", { headers: { authorization: `Bearer ${token}` } }));
export const error = async (response: Response, expected: string, status = 400) => {
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);
  const body = z
    .object({ error: z.string(), error_description: z.string().optional() })
    .strict()
    .parse(await json(response, status));
  assert.equal(body.error, expected);
  return { status, ...body };
};
