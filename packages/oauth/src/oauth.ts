import { type AuthContext, auth, jsonResponse, rateLimit, v } from "@valentinkolb/cloud/server";
import { accounts, get, isAccountCategoryAllowed, logger } from "@valentinkolb/cloud/services";
import { isAccountExpired } from "@valentinkolb/cloud/services/account-model";
import { createLoginRedirectUrl, publicCloudOrigin } from "@valentinkolb/cloud/shared";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { describeRoute, validator as openApiValidator } from "hono-openapi";
import { z } from "zod";
import {
  DYNAMIC_CLIENT_SCOPES,
  DynamicClientRegistrationErrorSchema,
  DynamicClientRegistrationRequestSchema,
  DynamicClientRegistrationResponseSchema,
  ErrorResponseSchema,
  type OAuthScope,
} from "@/contracts";
import { oauth } from "./service/oauth";

const log = logger("oauth");

const getIssuer = async (): Promise<string> => {
  const appUrl = await get<string>("app.url");
  return publicCloudOrigin(appUrl);
};

const OAUTH_SCOPES: OAuthScope[] = ["openid", "profile", "email", "groups", "offline_access", "read", "write", "admin"];
const DEFAULT_AUTHORIZATION_SCOPES: OAuthScope[] = ["openid"];
const PKCE_VALUE_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;
const DYNAMIC_REGISTRATION_MAX_BYTES = 8 * 1024;
const OAUTH_FORM_MAX_BYTES = 16 * 1024;
const isOAuthScope = (value: string): value is OAuthScope => OAUTH_SCOPES.includes(value as OAuthScope);

const parseScopes = (value: string | undefined): string[] =>
  value
    ?.split(" ")
    .map((scope) => scope.trim())
    .filter((scope) => scope.length > 0) ?? [];

const resolveRequestedScopes = (clientScopes: OAuthScope[], requestedScope: string | undefined): OAuthScope[] | null => {
  const requested = parseScopes(requestedScope);
  if (requested.length === 0) {
    const allowed = new Set(clientScopes);
    return DEFAULT_AUTHORIZATION_SCOPES.filter((scope) => allowed.has(scope));
  }
  const allowed = new Set(clientScopes);
  if (requested.some((scope) => !isOAuthScope(scope) || !allowed.has(scope as OAuthScope))) return null;
  return Array.from(new Set(requested)) as OAuthScope[];
};

const isPkceValue = (value: string | undefined): value is string => Boolean(value && PKCE_VALUE_PATTERN.test(value));

const ResourceIndicatorSchema = z
  .string()
  .url()
  .refine((value) => {
    try {
      return new URL(value).hash === "";
    } catch {
      return false;
    }
  }, "Resource indicator must not contain a fragment");

/**
 * Decode `Authorization: Basic base64(client_id:client_secret)` into its parts.
 * This is the OAuth `client_secret_basic` method (RFC 6749 §2.3.1). The
 * discovery document advertises it alongside `client_secret_post`, so the
 * token endpoint accepts credentials from either source.
 */
const parseBasicAuth = (header: string | undefined): { clientId: string; clientSecret: string } | null => {
  if (!header?.startsWith("Basic ")) return null;
  let decoded: string;
  try {
    decoded = atob(header.slice("Basic ".length));
  } catch {
    return null;
  }
  const colon = decoded.indexOf(":");
  if (colon === -1) return null;
  return {
    clientId: decoded.slice(0, colon),
    clientSecret: decoded.slice(colon + 1),
  };
};

const resolveClientCredentials = (
  authorization: string | undefined,
  body: { client_id?: string; client_secret?: string },
):
  | { ok: true; clientId: string; clientSecret: string | undefined }
  | { ok: false; error: "invalid_client" | "invalid_request"; description: string } => {
  const basic = parseBasicAuth(authorization);
  if (authorization && !basic) return { ok: false, error: "invalid_client", description: "Invalid client authentication" };
  if (basic && (body.client_id !== undefined || body.client_secret !== undefined)) {
    return { ok: false, error: "invalid_request", description: "Use exactly one client authentication method" };
  }
  const clientId = basic?.clientId ?? body.client_id;
  if (!clientId) return { ok: false, error: "invalid_request", description: "Missing client_id" };
  return { ok: true, clientId, clientSecret: basic?.clientSecret ?? body.client_secret };
};

const AuthorizeQuerySchema = z.object({
  client_id: z.string().min(1),
  redirect_uri: z.url(),
  response_type: z.literal("code"),
  scope: z.string().optional(),
  resource: ResourceIndicatorSchema.optional(),
  state: z.string().optional(),
  nonce: z.string().optional(),
  code_challenge: z.string().optional(),
  // Parse legacy `plain` so a valid client receives an OAuth redirect error; the handler rejects it before issuing a code.
  code_challenge_method: z.enum(["S256", "plain"]).optional(),
});

const TokenBodySchema = z.discriminatedUnion("grant_type", [
  z.object({
    grant_type: z.literal("authorization_code"),
    code: z.string().min(1),
    redirect_uri: z.url(),
    // Optional in the schema: client_id may also arrive via
    // `Authorization: Basic` (RFC 6749 §2.3.1). The handler enforces that one
    // source provides it and 400s otherwise.
    client_id: z.string().min(1).optional(),
    client_secret: z.string().optional(),
    code_verifier: z.string().optional(),
    resource: z.string().optional(),
  }),
  z.object({
    grant_type: z.literal("client_credentials"),
    client_id: z.string().min(1).optional(),
    client_secret: z.string().optional(),
    scope: z.string().optional(),
    resource: z.string().optional(),
  }),
  z.object({
    grant_type: z.literal("refresh_token"),
    refresh_token: z.string().min(1),
    client_id: z.string().min(1).optional(),
    client_secret: z.string().optional(),
    scope: z.string().optional(),
    resource: z.string().optional(),
  }),
]);

const TokenResponseSchema = z.object({
  access_token: z.string(),
  token_type: z.literal("Bearer"),
  expires_in: z.number(),
  id_token: z.string().optional(),
  scope: z.string(),
  refresh_token: z.string().optional(),
});

const TokenErrorResponseSchema = z.object({
  error: z.string(),
  error_description: z.string().optional(),
});

const tokenError = (c: Context<AuthContext>, error: string, description: string, status: 400 | 401 | 403 | 500 = 400) =>
  c.json({ error, error_description: description }, status);

const invalidClient = (c: Context<AuthContext>, description = "Invalid client credentials") => {
  c.header("WWW-Authenticate", 'Basic realm="oauth"');
  return tokenError(c, "invalid_client", description, 401);
};

const noStore = async (c: Context<AuthContext>, next: () => Promise<void>) => {
  c.header("Cache-Control", "no-store");
  c.header("Pragma", "no-cache");
  await next();
};

const oauthFormLimit = bodyLimit({
  maxSize: OAUTH_FORM_MAX_BYTES,
  onError: (c) => c.json({ error: "invalid_request", error_description: "OAuth request body exceeds 16384 bytes" }, 413),
});

const redirectAuthorizationResult = (
  redirectUri: string,
  issuer: string,
  state: string | undefined,
  params: Record<string, string>,
): string => {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  url.searchParams.set("iss", issuer);
  if (state !== undefined) url.searchParams.set("state", state);
  return url.toString();
};

const redirectAuthorizationError = (
  c: Context<AuthContext>,
  redirectUri: string,
  issuer: string,
  state: string | undefined,
  error: "access_denied" | "invalid_request" | "invalid_scope" | "invalid_target",
  description: string,
) => c.redirect(redirectAuthorizationResult(redirectUri, issuer, state, { error, error_description: description }));

class InvalidRefreshGrantError extends Error {}

const registrationError = (
  c: Context<AuthContext>,
  error: "invalid_redirect_uri" | "invalid_client_metadata",
  description: string,
  status: 400 | 413 | 415 | 500 = 400,
) => c.json({ error, error_description: description }, status);

const readBoundedRegistrationJson = async (request: Request): Promise<{ ok: true; data: unknown } | { ok: false; tooLarge: boolean }> => {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > DYNAMIC_REGISTRATION_MAX_BYTES) return { ok: false, tooLarge: true };

  const reader = request.body?.getReader();
  if (!reader) return { ok: false, tooLarge: false };
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > DYNAMIC_REGISTRATION_MAX_BYTES) {
      await reader.cancel().catch(() => undefined);
      return { ok: false, tooLarge: true };
    }
    chunks.push(chunk.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { ok: true, data: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) };
  } catch {
    return { ok: false, tooLarge: false };
  }
};

const validateTokenBody = openApiValidator("form", TokenBodySchema, (result, c: Context<AuthContext>) => {
  if (!result.success) return tokenError(c, "invalid_request", "Token request validation failed");
});

const RevokeTokenBodySchema = z.object({
  token: z.string().min(1),
  token_type_hint: z.string().optional(),
  client_id: z.string().min(1).optional(),
  client_secret: z.string().optional(),
});

/** OAuth 2.0 / OpenID Connect routes mounted at root-level standard paths. */
const app = new Hono<AuthContext>()
  .get("/.well-known/openid-configuration", async (c) => {
    const issuer = await getIssuer();
    return c.json(oauth.tokens.getOpenIdConfiguration(issuer));
  })
  .get("/.well-known/oauth-authorization-server", async (c) => {
    const issuer = await getIssuer();
    return c.json(oauth.tokens.getOpenIdConfiguration(issuer));
  })
  .get("/.well-known/jwks.json", async (c) => {
    try {
      const jwks = await oauth.tokens.getJwks();
      const etag = `"${new Bun.CryptoHasher("sha256").update(JSON.stringify(jwks)).digest("hex").slice(0, 32)}"`;
      c.header("Cache-Control", "public, max-age=300, must-revalidate");
      c.header("ETag", etag);
      if (c.req.header("if-none-match") === etag) return c.body(null, 304);
      return c.json(jwks);
    } catch (err) {
      log.error("Failed to get JWKS", {
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json(
        {
          message: "Failed to generate JWKS. Please contact an administrator.",
        },
        500,
      );
    }
  })
  .post(
    "/oauth/register",
    describeRoute({
      tags: ["OAuth"],
      summary: "Register a public OAuth client",
      description: "Dynamically registers an untrusted public Authorization Code client using RFC 7591.",
      responses: {
        201: jsonResponse(DynamicClientRegistrationResponseSchema, "Registered public client"),
        400: jsonResponse(DynamicClientRegistrationErrorSchema, "Invalid client metadata"),
        413: jsonResponse(DynamicClientRegistrationErrorSchema, "Client metadata too large"),
        415: jsonResponse(DynamicClientRegistrationErrorSchema, "Unsupported media type"),
      },
    }),
    rateLimit({ keyBy: "ip", limitPerSecond: 10, windowSecs: 60 }),
    async (c) => {
      c.header("Cache-Control", "no-store");
      c.header("Pragma", "no-cache");
      if (!c.req.header("content-type")?.toLowerCase().startsWith("application/json")) {
        return registrationError(c, "invalid_client_metadata", "Registration requests must use application/json", 415);
      }

      const body = await readBoundedRegistrationJson(c.req.raw);
      if (!body.ok) {
        return registrationError(
          c,
          "invalid_client_metadata",
          body.tooLarge ? "Client metadata exceeds 8192 bytes" : "Registration request body must be valid JSON",
          body.tooLarge ? 413 : 400,
        );
      }
      const parsed = DynamicClientRegistrationRequestSchema.safeParse(body.data);
      if (!parsed.success) {
        const redirectFailure = parsed.error.issues.some((issue) => issue.path[0] === "redirect_uris");
        return registrationError(
          c,
          redirectFailure ? "invalid_redirect_uri" : "invalid_client_metadata",
          parsed.error.issues[0]?.message ?? "Invalid client metadata",
        );
      }
      if (!parsed.data.grant_types.includes("authorization_code")) {
        return registrationError(c, "invalid_client_metadata", "Dynamic clients must use the authorization_code grant");
      }

      try {
        const client = await oauth.clients.registerDynamic({
          name: parsed.data.client_name,
          redirectUris: parsed.data.redirect_uris,
          scopes: parsed.data.scope ? (parseScopes(parsed.data.scope) as OAuthScope[]) : [...DYNAMIC_CLIENT_SCOPES],
        });
        await oauth.clients.cleanupUnusedDynamic().catch((error) => {
          log.warn("Failed to clean abandoned dynamic OAuth clients", { error: error instanceof Error ? error.message : String(error) });
        });
        return c.json(
          {
            client_id: client.clientId,
            client_id_issued_at: Math.floor(new Date(client.createdAt).getTime() / 1_000),
            client_name: client.name,
            application_type: parsed.data.application_type,
            redirect_uris: client.redirectUris,
            grant_types: ["authorization_code", "refresh_token"] as const,
            response_types: ["code"] as const,
            token_endpoint_auth_method: "none" as const,
            scope: client.scopes.join(" "),
          },
          201,
        );
      } catch (error) {
        log.error("Failed to register dynamic OAuth client", { error: error instanceof Error ? error.message : String(error) });
        return registrationError(c, "invalid_client_metadata", "Dynamic client registration failed", 500);
      }
    },
  )
  .get(
    "/oauth/authorize",
    describeRoute({
      tags: ["OAuth"],
      summary: "Authorization endpoint",
      description: "Initiates the OAuth 2.0 authorization code flow. Redirects to login if not authenticated.",
      responses: {
        302: { description: "Redirect to client or login" },
        400: jsonResponse(ErrorResponseSchema, "Invalid request"),
      },
    }),
    v("query", AuthorizeQuerySchema),
    async (c) => {
      const query = c.req.valid("query");
      const { client_id, redirect_uri, state, nonce, code_challenge, code_challenge_method } = query;

      const client = await oauth.clients.getByClientId({ clientId: client_id });
      if (!client) {
        return c.json({ message: "Invalid client_id" }, 400);
      }

      if (!oauth.clients.validateRedirectUri(client, redirect_uri)) {
        return c.json({ message: "Invalid redirect_uri" }, 400);
      }

      const issuer = await getIssuer();
      const scopes = resolveRequestedScopes(client.scopes, query.scope);
      if (!scopes) {
        return redirectAuthorizationError(
          c,
          redirect_uri,
          issuer,
          state,
          "invalid_scope",
          "Requested scope is not allowed for this client",
        );
      }
      if (!oauth.clients.validateResource(client, query.resource, issuer)) {
        return redirectAuthorizationError(
          c,
          redirect_uri,
          issuer,
          state,
          "invalid_target",
          "Requested resource is not allowed for this client",
        );
      }

      if (client.isPublic) {
        if (!code_challenge) {
          return redirectAuthorizationError(c, redirect_uri, issuer, state, "invalid_request", "PKCE required for public clients");
        }
        if (code_challenge_method !== "S256") {
          return redirectAuthorizationError(c, redirect_uri, issuer, state, "invalid_request", "Public clients must use PKCE S256");
        }
      }
      if (code_challenge_method === "plain") {
        return redirectAuthorizationError(c, redirect_uri, issuer, state, "invalid_request", "PKCE must use S256");
      }
      if (code_challenge_method && !code_challenge) {
        return redirectAuthorizationError(c, redirect_uri, issuer, state, "invalid_request", "PKCE method requires a code challenge");
      }
      if (code_challenge && !isPkceValue(code_challenge)) {
        return redirectAuthorizationError(c, redirect_uri, issuer, state, "invalid_request", "Invalid PKCE code_challenge");
      }

      const token = auth.session.getToken(c);

      const buildLoginRedirect = () => createLoginRedirectUrl(c.req.url);

      if (!token) {
        return c.redirect(buildLoginRedirect());
      }

      const authenticatedSession = await auth.session.authenticate(token);
      if (!authenticatedSession) {
        return c.redirect(buildLoginRedirect());
      }
      const { user } = authenticatedSession;

      if (!(await oauth.clients.canAuthorizeUser({ client, userId: user.id, profile: user.profile }))) {
        return redirectAuthorizationError(c, redirect_uri, issuer, state, "access_denied", "You do not have access to this application");
      }

      if (client.registrationKind === "dynamic") {
        const consentRequest = await oauth.consent.create({
          userId: user.id,
          clientId: client.clientId,
          redirectUri: redirect_uri,
          scopes,
          resource: query.resource!,
          state,
          nonce,
          codeChallenge: code_challenge!,
          codeChallengeMethod: "S256",
        });
        return c.redirect(`/oauth/consent?request=${encodeURIComponent(consentRequest)}`);
      }

      const code = await oauth.codes.create({
        clientId: client.clientId,
        userId: user.id,
        redirectUri: redirect_uri,
        scopes,
        resource: query.resource,
        nonce,
        codeChallenge: code_challenge,
        codeChallengeMethod: code_challenge_method,
      });

      return c.redirect(redirectAuthorizationResult(redirect_uri, issuer, state, { code }));
    },
  )
  .post(
    "/oauth/token",
    describeRoute({
      tags: ["OAuth"],
      summary: "Token endpoint",
      description: "Exchange authorization code for access token and optionally id_token.",
      responses: {
        200: jsonResponse(TokenResponseSchema, "Token response"),
        400: jsonResponse(TokenErrorResponseSchema, "Invalid request"),
        401: jsonResponse(TokenErrorResponseSchema, "Invalid credentials"),
        403: jsonResponse(TokenErrorResponseSchema, "Grant no longer allowed"),
        413: jsonResponse(TokenErrorResponseSchema, "Request body too large"),
      },
    }),
    noStore,
    rateLimit({ keyBy: "ip", limitPerSecond: 50 }),
    oauthFormLimit,
    validateTokenBody,
    async (c) => {
      const body = c.req.valid("form");
      if (body.resource && !ResourceIndicatorSchema.safeParse(body.resource).success) {
        return tokenError(c, "invalid_target", "Resource must be an absolute URI without a fragment");
      }
      const credentials = resolveClientCredentials(c.req.header("Authorization"), body);
      if (!credentials.ok) {
        return credentials.error === "invalid_client"
          ? invalidClient(c, credentials.description)
          : tokenError(c, credentials.error, credentials.description);
      }
      const { clientId: client_id, clientSecret: client_secret } = credentials;
      const client = await oauth.clients.validateCredentials({
        clientId: client_id,
        clientSecret: client_secret,
      });

      if (!client) {
        return invalidClient(c);
      }

      if (body.grant_type === "client_credentials") {
        if (client.isPublic) {
          return tokenError(c, "unauthorized_client", "Client credentials require a confidential client", 401);
        }

        try {
          const token = await oauth.tokens.createClientCredentialsToken({
            client,
            scope: body.scope,
            resource: body.resource,
          });

          return c.json({
            access_token: token.accessToken,
            token_type: "Bearer" as const,
            expires_in: token.expiresIn,
            scope: token.scope,
          });
        } catch (err) {
          if (err instanceof oauth.tokens.InvalidOAuthScopeError) {
            return tokenError(c, "invalid_scope", err.message);
          }
          if (err instanceof oauth.tokens.InvalidOAuthServiceAccountError) {
            return tokenError(c, "invalid_client", err.message);
          }
          if (err instanceof oauth.tokens.InvalidOAuthResourceError) {
            return tokenError(c, "invalid_target", err.message);
          }
          if (err instanceof oauth.tokens.OAuthAuthorityGrantRejectedError) {
            return tokenError(c, "invalid_grant", "Client credentials grant is no longer allowed");
          }

          log.error("Failed to generate client credentials token", {
            error: err instanceof Error ? err.message : String(err),
            clientId: client_id,
          });
          return tokenError(c, "server_error", "Token generation failed. Please try again or contact an administrator.", 500);
        }
      }

      if (body.grant_type === "refresh_token") {
        const parsedScopes = body.scope ? parseScopes(body.scope) : undefined;
        if (parsedScopes?.some((scope) => !isOAuthScope(scope))) {
          return tokenError(c, "invalid_scope", "Requested scope is not allowed for this refresh token");
        }
        const requestedScopes = parsedScopes ? (Array.from(new Set(parsedScopes)) as OAuthScope[]) : undefined;
        const issued: { value: Awaited<ReturnType<typeof oauth.tokens.createTokens>> | null } = { value: null };
        let rotated: Awaited<ReturnType<typeof oauth.refreshTokens.rotate>>;
        try {
          const issuer = await getIssuer();
          rotated = await oauth.refreshTokens.rotate(body.refresh_token, client, body.resource, requestedScopes, async (grant) => {
            const user = await accounts.users.get({ id: grant.userId });
            const allowedAudiences = new Set(["cloud", client.clientId, ...client.audiences]);
            const audiencesAllowed =
              client.registrationKind === "dynamic"
                ? Boolean(grant.resource && oauth.clients.validateResource(client, grant.resource, issuer))
                : grant.audiences.every((audience) => allowedAudiences.has(audience));
            if (
              !user ||
              isAccountExpired(user.accountExpires) ||
              !(await isAccountCategoryAllowed(user)) ||
              grant.scopes.some((scope) => !client.scopes.includes(scope)) ||
              !audiencesAllowed ||
              !(await oauth.clients.canAuthorizeUser({ client, userId: user.id, profile: user.profile }))
            ) {
              throw new oauth.refreshTokens.SafeRefreshIssuanceRejectionError();
            }
            try {
              issued.value = await oauth.tokens.createTokens({
                userId: grant.userId,
                client,
                scopes: grant.scopes,
                audiences: grant.resource ? grant.audiences : Array.from(new Set(["cloud", client.clientId, ...grant.audiences])),
                resource: grant.resource,
                authorityGrant: grant.authorityGrant,
              });
            } catch (error) {
              if (error instanceof oauth.tokens.OAuthAuthorityGrantRejectedError) {
                throw new oauth.refreshTokens.SafeRefreshIssuanceRejectionError();
              }
              throw error;
            }
          });
        } catch (err) {
          if (err instanceof InvalidRefreshGrantError || err instanceof oauth.refreshTokens.SafeRefreshIssuanceRejectionError) {
            return tokenError(c, "invalid_grant", "Refresh token grant is no longer allowed");
          }
          log.error("Failed to generate refreshed access token", {
            error: err instanceof Error ? err.message : String(err),
            clientId: client_id,
          });
          return tokenError(c, "server_error", "Token generation failed. Please try again or contact an administrator.", 500);
        }
        if (!rotated.ok) {
          return rotated.error === "invalid_scope"
            ? tokenError(c, "invalid_scope", "Requested scope is not allowed for this refresh token")
            : tokenError(c, "invalid_grant", "Refresh token is invalid, expired, or already used");
        }
        const tokens = issued.value;
        if (!tokens) return tokenError(c, "server_error", "Token generation failed. Please try again or contact an administrator.", 500);

        return c.json({
          access_token: tokens.accessToken,
          token_type: "Bearer" as const,
          expires_in: tokens.expiresIn,
          ...(tokens.idToken ? { id_token: tokens.idToken } : {}),
          scope: tokens.scope,
          refresh_token: rotated.refreshToken,
        });
      }

      const { code, redirect_uri, code_verifier } = body;

      const result = await oauth.codes.consume({
        code,
        clientId: client_id,
        client,
        redirectUri: redirect_uri,
        resource: body.resource,
        codeVerifier: code_verifier,
      });

      if (!result) {
        return tokenError(c, "invalid_grant", "Invalid or expired authorization code");
      }

      const issuer = await getIssuer();
      try {
        const allowedAudiences = new Set(["cloud", result.client.clientId, ...result.client.audiences]);
        if (
          result.scopes.some((scope) => !result.client.scopes.includes(scope)) ||
          (result.client.registrationKind !== "dynamic" && result.audiences.some((audience) => !allowedAudiences.has(audience))) ||
          !oauth.clients.validateResource(result.client, result.resource ?? undefined, issuer)
        ) {
          return tokenError(c, "invalid_grant", "Authorization code grant is no longer allowed");
        }
        const user = await accounts.users.get({ id: result.userId });
        if (
          !user ||
          isAccountExpired(user.accountExpires) ||
          !(await isAccountCategoryAllowed(user)) ||
          !(await oauth.clients.canAuthorizeUser({ client: result.client, userId: user.id, profile: user.profile }))
        ) {
          return tokenError(c, "access_denied", "User is not allowed to access this client", 403);
        }

        const tokens = await oauth.tokens.createTokens({
          userId: result.userId,
          client: result.client,
          scopes: result.scopes,
          audiences: result.audiences,
          resource: result.resource,
          authorityGrant: result.authorityGrant,
          issueRefreshToken: true,
        });

        return c.json({
          access_token: tokens.accessToken,
          token_type: "Bearer" as const,
          expires_in: tokens.expiresIn,
          ...(tokens.idToken ? { id_token: tokens.idToken } : {}),
          scope: tokens.scope,
          ...(tokens.refreshToken ? { refresh_token: tokens.refreshToken } : {}),
        });
      } catch (err) {
        if (err instanceof oauth.tokens.OAuthAuthorityGrantRejectedError) {
          return tokenError(c, "invalid_grant", "Authorization code grant is no longer allowed");
        }
        log.error("Failed to generate tokens", {
          error: err instanceof Error ? err.message : String(err),
          clientId: client_id,
          userId: result.userId,
        });
        return tokenError(c, "server_error", "Token generation failed. Please try again or contact an administrator.", 500);
      }
    },
  )
  .post(
    "/oauth/revoke",
    describeRoute({
      tags: ["OAuth"],
      summary: "Token revocation endpoint",
      description: "Revokes a refresh token grant. Invalid tokens still return success.",
      responses: {
        200: { description: "Token revoked or already invalid" },
        400: jsonResponse(TokenErrorResponseSchema, "Invalid request"),
        401: jsonResponse(TokenErrorResponseSchema, "Invalid client credentials"),
        413: jsonResponse(TokenErrorResponseSchema, "Request body too large"),
      },
    }),
    noStore,
    rateLimit({ keyBy: "ip", limitPerSecond: 50 }),
    oauthFormLimit,
    v("form", RevokeTokenBodySchema),
    async (c) => {
      const body = c.req.valid("form");
      const credentials = resolveClientCredentials(c.req.header("Authorization"), body);
      if (!credentials.ok) {
        return credentials.error === "invalid_client"
          ? invalidClient(c, credentials.description)
          : tokenError(c, credentials.error, credentials.description);
      }
      const { clientId: client_id, clientSecret: client_secret } = credentials;

      const client = await oauth.clients.validateCredentials({
        clientId: client_id,
        clientSecret: client_secret,
      });
      if (!client) {
        return invalidClient(c);
      }

      await oauth.refreshTokens.revoke(body.token, client.clientId);
      return new Response(null, { status: 200 });
    },
  )
  .get(
    "/oauth/userinfo",
    describeRoute({
      tags: ["OAuth"],
      summary: "UserInfo endpoint",
      description: "Returns claims about the authenticated user.",
      responses: {
        200: { description: "User claims" },
        401: jsonResponse(ErrorResponseSchema, "Invalid token"),
        403: jsonResponse(ErrorResponseSchema, "OpenID scope required"),
      },
    }),
    noStore,
    rateLimit({ keyBy: "ip", limitPerSecond: 100 }),
    async (c) => {
      const authHeader = c.req.header("Authorization");
      if (!authHeader?.startsWith("Bearer ")) {
        return c.json({ message: "Missing bearer token" }, 401);
      }

      const token = authHeader.substring(7);
      const issuer = await getIssuer();

      try {
        const payload = await oauth.tokens.verifyAccessToken({ token, issuer });
        if (!payload) {
          return c.json({ message: "Invalid token" }, 401);
        }
        if (
          payload.token_use !== "access" ||
          payload.principal_type !== "user" ||
          typeof payload.sub !== "string" ||
          payload.sub.length === 0 ||
          typeof payload.id !== "string" ||
          typeof payload.client_id !== "string"
        ) {
          return c.json({ message: "Invalid token" }, 401);
        }

        const scopes = typeof payload.scope === "string" ? parseScopes(payload.scope).filter(isOAuthScope) : [];
        if (!scopes.includes("openid")) return c.json({ message: "The openid scope is required" }, 403);

        const audiences = Array.isArray(payload.aud) ? payload.aud : typeof payload.aud === "string" ? [payload.aud] : [];
        if (!audiences.includes(payload.client_id)) return c.json({ message: "Invalid token audience" }, 401);

        const client = await oauth.clients.getByClientId({ clientId: payload.client_id });
        if (!client) return c.json({ message: "Invalid token" }, 401);

        const userInfo = await oauth.tokens.createUserInfo({
          userId: payload.id,
          subject: payload.sub,
          scopes,
        });

        if (!userInfo) {
          return c.json({ message: "User not found" }, 401);
        }

        return c.json(userInfo);
      } catch (err) {
        log.error("Failed to process userinfo request", {
          error: err instanceof Error ? err.message : String(err),
        });
        return c.json({ message: "Invalid token" }, 401);
      }
    },
  )
  .get(
    "/oauth/logout",
    describeRoute({
      tags: ["OAuth"],
      summary: "Logout endpoint",
      description: "Logs out the current user and optionally redirects to client logout URI.",
      responses: {
        302: { description: "Redirect after logout" },
      },
    }),
    auth.requireRole("*"),
    async (c) => {
      auth.session.delete(c);

      const postLogoutRedirectUri = c.req.query("post_logout_redirect_uri");
      const clientId = c.req.query("client_id");

      if (postLogoutRedirectUri && clientId) {
        const client = await oauth.clients.getByClientId({ clientId });
        if (client && client.logoutUri === postLogoutRedirectUri) {
          return c.redirect(postLogoutRedirectUri);
        }
      }

      return c.redirect("/");
    },
  );

export default app;
