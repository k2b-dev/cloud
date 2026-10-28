import type { Context, MiddlewareHandler } from "hono";
import { createMiddleware } from "hono/factory";
import { getApp } from "../../_internal/registry";
import type { AppMeta } from "../../contracts/app";
import { canUseApp } from "../../services/app-access";
import { recordAppAccessDenied } from "../../services/app-access-metrics";
import { type ResolvedInvocationAuthority, resolveInvocationAuthority } from "../../services/identity/invocation-actor";
import { type CloudInvocationClaims, isInvocationJwtCandidate, verifyInvocationToken } from "../../services/identity/invocation-token";
import { appAccessDeniedBody } from "./app-access";
import { type AuthContext, requireOAuthMutationScope } from "./auth";

export type InvocationExpectation = {
  targetAppId: string;
  operation: string;
  schemaHash: string | null;
};

type InvocationMiddlewareDependencies = {
  getApp?: (appId: string) => Promise<Pick<AppMeta, "id" | "access"> | null>;
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
    const app = await (dependencies.getApp ?? getApp)(expectation.targetAppId).catch(() => null);
    if (!app || !(await canUseApp(authority, app))) {
      if (app) recordAppAccessDenied(app.id);
      return c.json(appAccessDeniedBody(app ?? { id: expectation.targetAppId }), 403);
    }
    if (claims.schema_hash !== expectation.schemaHash) {
      return c.json({ code: "SCHEMA_MISMATCH", message: "The invocation schema no longer matches the target" }, 409);
    }
    installAuthority(c, claims, authority);
    return requireOAuthMutationScope(c, next);
  });
