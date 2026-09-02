import type { Context, MiddlewareHandler } from "hono";
import { createMiddleware } from "hono/factory";
import { type ResolvedInvocationAuthority, resolveInvocationAuthority } from "../../services/identity/invocation-actor";
import { type CloudInvocationClaims, isInvocationJwtCandidate, verifyInvocationToken } from "../../services/identity/invocation-token";
import type { AuthContext } from "./auth";

export type InvocationExpectation = {
  targetAppId: string;
  operation: string;
  schemaHash: string | null;
};

type InvocationMiddlewareDependencies = {
  verify?: typeof verifyInvocationToken;
  resolve?: typeof resolveInvocationAuthority;
};

const bearerToken = (c: Context): string | null => {
  const header = c.req.header("Authorization");
  const match = header?.match(/^Bearer\s+(\S+)$/i);
  return match?.[1] ?? null;
};

const reject = (c: Context<AuthContext>): Response =>
  c.json({ code: "UNAUTHORIZED", message: "A valid Cloud invocation is required" }, 401);

const installAuthority = (c: Context<AuthContext>, claims: CloudInvocationClaims, authority: ResolvedInvocationAuthority): void => {
  c.set("actor", authority.actor);
  c.set("accessSubject", authority.accessSubject);
  c.set("credentialKind", "invocation");
  c.set("credentialScopes", authority.scopes);
  if (authority.actor.kind === "user") c.set("user", authority.actor.user);
  else if (authority.actor.delegatedUser) c.set("user", authority.actor.delegatedUser);
  if (claims.credential_kind === "oauth") c.set("oauthScopes", authority.scopes);
};

export const requireInvocation = (
  expected: (c: Context<AuthContext>) => InvocationExpectation | null,
  dependencies: InvocationMiddlewareDependencies = {},
): MiddlewareHandler<AuthContext> =>
  createMiddleware<AuthContext>(async (c, next) => {
    const token = bearerToken(c);
    const expectation = expected(c);
    if (!token || !expectation || !isInvocationJwtCandidate(token)) return reject(c);

    const claims = await (dependencies.verify ?? verifyInvocationToken)(token, expectation, { deferSchemaBinding: true });
    if (!claims) return reject(c);
    const authority = await (dependencies.resolve ?? resolveInvocationAuthority)(claims);
    if (!authority) return reject(c);
    if (claims.schema_hash !== expectation.schemaHash) {
      return c.json({ code: "SCHEMA_MISMATCH", message: "The invocation schema no longer matches the target" }, 409);
    }
    installAuthority(c, claims, authority);
    return next();
  });

/** Temporary rolling-upgrade adapter. Remove with the legacy credential-forwarding path. */
export const requireInvocationOrLegacy = (
  expected: (c: Context<AuthContext>) => InvocationExpectation | null,
  legacy: MiddlewareHandler<AuthContext>,
  dependencies: InvocationMiddlewareDependencies = {},
): MiddlewareHandler<AuthContext> => {
  const invocation = requireInvocation(expected, dependencies);
  return createMiddleware<AuthContext>((c, next) => {
    const token = bearerToken(c);
    return token && isInvocationJwtCandidate(token) ? invocation(c, next) : legacy(c, next);
  });
};
