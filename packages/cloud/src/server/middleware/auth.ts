import type { Context, Env, MiddlewareHandler } from "hono";
import { createMiddleware } from "hono/factory";
import { matchedRoutes } from "hono/route";
import { findTargetHandler } from "hono/utils/handler";
import { measureServerPhase } from "../../_internal/server-timing";
import {
  AI_INFERENCE_SCOPE,
  type MessageResponse,
  type Role,
  type RoleOrSpecial,
  type User,
  type UserProfile,
  type UserProvider,
} from "../../contracts/shared";
import { isAccountExpired } from "../../services/account-model";
import { isReservedWorkloadApiCredential } from "../../services/identity/workload-auth";
import { oauthTokens } from "../../services/oauth-tokens";
import { serviceAccountCredentials } from "../../services/service-account-credentials";
import type { ServiceAccount } from "../../services/service-accounts";
import { type AuthenticatedSession, isAppPagePath, type SessionKind, session } from "../../services/session";
import { createLoginRedirectUrl } from "../../shared/redirect";
import { isAppSessionActor } from "../actor";
import type { AccessSubject } from "../services/access";

// ==========================
// Types
// ==========================

export type InvocationProvenance = {
  kind: "invocation";
  callingAppId: string;
  credentialKind: "session" | "oauth" | "api_key" | "mandate";
  invocationId: string;
  parentInvocationId?: string;
  requestId?: string | null;
  mandateId?: string;
  mandateRevision?: number;
  workloadType?: string;
  workloadId?: string;
};

export type UserRequestActor = {
  kind: "user";
  user: User;
  delegation?: InvocationProvenance;
  /**
   * `"app"` when the person acts through the mobile app's session: directly, through an
   * invocation, or in an Assistant turn started there. Such an actor never carries the
   * `admin` role and must not create authority that outlives the phone.
   */
  sessionKind?: "app";
};

export type ServiceAccountRequestActor =
  | {
      kind: "service_account";
      serviceAccount: ServiceAccount;
      delegatedUser: User;
      scopes: string[];
      credentialId?: string | null;
      credentialExpiresAt?: string | null;
      delegation?: InvocationProvenance;
    }
  | {
      kind: "service_account";
      serviceAccount: ServiceAccount;
      delegatedUser: null;
      scopes: string[];
      credentialId?: string | null;
      credentialExpiresAt?: string | null;
      delegation?: InvocationProvenance;
    };

export type RequestActor = UserRequestActor | ServiceAccountRequestActor;

export type RequestCredentialKind = "session" | "oauth" | "api_key" | "invocation";

/** Core keeps only revocation coordinates, never the original bearer credential. */
export type RequestCredentialProof =
  | { kind: "session"; userId: string; sid: string; authEpoch: number; expiresAt: string }
  | { kind: "oauth"; payload: import("jose").JWTPayload }
  | { kind: "api_key"; credentialId: string };

export type RequestAuthority = {
  credentialProof?: RequestCredentialProof;
  actor: RequestActor;
  accessSubject: AccessSubject;
  credentialKind: RequestCredentialKind;
  scopes: string[];
};

/** Hono context with authenticated user variables. */
export type AuthContext = {
  Variables: {
    actor: RequestActor;
    accessSubject: AccessSubject;
    user: User;
    sessionToken?: string;
    /** Credential class resolved once for downstream delegation. */
    credentialKind?: RequestCredentialKind;
    /** With `credentialKind: "session"`: `"app"` for a paired phone in the mobile app, otherwise `"web"`. */
    sessionKind?: SessionKind;
    /** Constraints carried by OAuth/API credentials; absent sessions are unrestricted by transport scope. */
    credentialScopes?: string[];
    credentialProof?: RequestCredentialProof;
    /** OAuth scopes for bearer-token requests. Absent for sessions and API credentials. */
    oauthScopes?: string[];
  };
};

// ==========================
// Role-based Middleware
// ==========================

type RejectResult = string | Response | { message: string; status: number };

type RoleOptions = {
  onReject?: (c: Context, reason: "unauthenticated" | "forbidden") => RejectResult | Promise<RejectResult>;
  /** Require any of these audiences for OAuth bearer tokens. Sessions and API keys are unaffected. */
  oauthAudience?: string | string[] | (() => string | string[] | Promise<string | string[]>);
};

type AccountOptions = RoleOptions & {
  provider?: UserProvider;
  profile?: UserProfile;
};

const handleReject = async (c: Context, options: RoleOptions, reason: "unauthenticated" | "forbidden"): Promise<Response> => {
  if (options.onReject) {
    const result = await options.onReject(c, reason);
    if (typeof result === "string") return c.redirect(result);
    if (result instanceof Response) return result;
    return c.json({ message: result.message } as MessageResponse, result.status as 400 | 401 | 403 | 404 | 500);
  }
  // Default: JSON response
  if (reason === "unauthenticated") {
    return c.json({ message: "Authentication required" } as MessageResponse, 401);
  }
  return c.json({ message: "Insufficient permissions" } as MessageResponse, 403);
};

type AuthenticatedActorResult = {
  token: string | null;
  user: User | null;
  actor: RequestActor | null;
};

const actorResolutionByRequest = new WeakMap<Context, Promise<AuthenticatedActorResult>>();

const loadAuthenticatedActorUncached = async (
  c: Context<AuthContext>,
  options: Pick<RoleOptions, "oauthAudience"> = {},
): Promise<AuthenticatedActorResult> => {
  let token = session.getToken(c);
  let authenticatedSession: AuthenticatedSession | null = token ? await session.authenticateRequest(c, token) : null;
  const fallback = authenticatedSession ? null : session.appSessionFallback(c, token);
  if (fallback) {
    token = fallback;
    authenticatedSession = await session.authenticateRequest(c, fallback);
  }
  // Below /pwa/ only an app session counts: no web session, bearer or API key reaches app pages.
  if (isAppPagePath(c.req.path) && authenticatedSession?.data.kind !== "app") return { token: null, user: null, actor: null };

  if (authenticatedSession && token) {
    const { user } = authenticatedSession;
    const actor: UserRequestActor = { kind: "user", user, ...(authenticatedSession.data.kind === "app" ? { sessionKind: "app" } : {}) };
    c.set("actor", actor);
    c.set("accessSubject", { type: "user", userId: user.id });
    c.set("user", user);
    c.set("sessionToken", token);
    c.set("credentialKind", "session");
    c.set("sessionKind", authenticatedSession.data.kind);
    c.set("credentialProof", {
      kind: "session",
      userId: user.id,
      sid: authenticatedSession.data.sid,
      authEpoch: authenticatedSession.data.authEpoch,
      expiresAt: authenticatedSession.data.expiresAt,
    });
    return { token, user, actor };
  }

  const bearer = session.getBearerToken(c);
  if (bearer && serviceAccountCredentials.isApiToken(bearer)) {
    const authResult = await serviceAccountCredentials.authenticateApiToken(bearer);
    if (!authResult) return { token: null, user: null, actor: null };
    // App workload keys enter only through Core's dedicated broker/authority
    // handlers, which authenticate their exact app binding directly.
    if (isReservedWorkloadApiCredential(authResult)) return { token: null, user: null, actor: null };
    // Restrict by rejection: a forgotten route check makes a models-only key work nowhere, never grants full access.
    if (authResult.credential.scopes.includes(AI_INFERENCE_SCOPE)) return { token: null, user: null, actor: null };
    if (authResult.delegatedUser && isAccountExpired(authResult.delegatedUser.accountExpires)) {
      return { token: null, user: null, actor: null };
    }

    const actor: RequestActor = {
      kind: "service_account",
      serviceAccount: authResult.serviceAccount,
      delegatedUser: authResult.delegatedUser,
      scopes: authResult.credential.scopes,
      credentialId: authResult.credential.id,
      credentialExpiresAt: authResult.credential.expiresAt,
    };
    c.set("actor", actor);
    c.set("credentialKind", "api_key");
    c.set("credentialProof", { kind: "api_key", credentialId: authResult.credential.id });
    c.set("credentialScopes", authResult.credential.scopes);
    if (authResult.delegatedUser) {
      c.set("accessSubject", { type: "user", userId: authResult.delegatedUser.id });
      c.set("user", authResult.delegatedUser);
    } else {
      c.set("accessSubject", { type: "service_account", serviceAccountId: authResult.serviceAccount.id });
    }
    return { token: null, user: authResult.delegatedUser, actor };
  }

  if (bearer) {
    const expectedAudience = typeof options.oauthAudience === "function" ? await options.oauthAudience() : options.oauthAudience;
    const authResult = await oauthTokens.verifyAccessToken(bearer, expectedAudience);
    if (!authResult) return { token: null, user: null, actor: null };

    c.set("credentialProof", {
      kind: "oauth",
      payload: Object.fromEntries(
        ["sub", "id", "uid", "client_id", "auth_epoch", "service_account_id", "scope", "exp"].flatMap((key) =>
          authResult.payload[key] === undefined ? [] : [[key, authResult.payload[key]]],
        ),
      ),
    });
    if (authResult.kind === "user") {
      if (isAccountExpired(authResult.user.accountExpires)) return { token: null, user: null, actor: null };
      const actor: RequestActor = { kind: "user", user: authResult.user };
      c.set("actor", actor);
      c.set("accessSubject", { type: "user", userId: authResult.user.id });
      c.set("user", authResult.user);
      c.set("oauthScopes", authResult.scopes);
      c.set("credentialKind", "oauth");
      c.set("credentialScopes", authResult.scopes);
      return { token: null, user: authResult.user, actor };
    }

    if (authResult.delegatedUser && isAccountExpired(authResult.delegatedUser.accountExpires)) {
      return { token: null, user: null, actor: null };
    }
    const actor: RequestActor = {
      kind: "service_account",
      serviceAccount: authResult.serviceAccount,
      delegatedUser: authResult.delegatedUser,
      scopes: authResult.scopes,
      credentialId: null,
      credentialExpiresAt: typeof authResult.payload.exp === "number" ? new Date(authResult.payload.exp * 1_000).toISOString() : null,
    };
    c.set("actor", actor);
    c.set("oauthScopes", authResult.scopes);
    c.set("credentialKind", "oauth");
    c.set("credentialScopes", authResult.scopes);
    if (authResult.delegatedUser) {
      c.set("accessSubject", { type: "user", userId: authResult.delegatedUser.id });
      c.set("user", authResult.delegatedUser);
    } else {
      c.set("accessSubject", { type: "service_account", serviceAccountId: authResult.serviceAccount.id });
    }
    return { token: null, user: authResult.delegatedUser, actor };
  }

  return { token: null, user: null, actor: null };
};

export const loadAuthenticatedActor = (
  c: Context<AuthContext>,
  options: Pick<RoleOptions, "oauthAudience"> = {},
): Promise<AuthenticatedActorResult> => {
  if (options.oauthAudience) return measureServerPhase(c, "auth", () => loadAuthenticatedActorUncached(c, options));
  const existing = actorResolutionByRequest.get(c);
  if (existing) return existing;
  const pending = measureServerPhase(c, "auth", () => loadAuthenticatedActorUncached(c, options));
  actorResolutionByRequest.set(c, pending);
  return pending;
};

/**
 * Re-checks the credential that admitted this request, past the per-request
 * cache, for a response that outlives its request such as a stream. True while
 * that credential still authenticates the same actor; pass the same
 * `oauthAudience` the route admitted with. Invocation credentials are bound to
 * one call and always fail.
 */
export const isRequestCredentialCurrent = async (
  c: Context<AuthContext>,
  options: Pick<RoleOptions, "oauthAudience"> = {},
): Promise<boolean> => {
  const actor = c.get("actor");
  if (!actor) return false;
  const credentialKind = c.get("credentialKind");
  if (credentialKind === "session") {
    const token = c.get("sessionToken");
    if (!token || actor.kind !== "user") return false;
    return (await session.authenticateUserId(token)) === actor.user.id;
  }

  const bearer = session.getBearerToken(c);
  if (!bearer) return false;
  if (credentialKind === "api_key") {
    if (actor.kind !== "service_account") return false;
    const current = await serviceAccountCredentials.authenticateApiToken(bearer);
    if (current?.delegatedUser && isAccountExpired(current.delegatedUser.accountExpires)) return false;
    return current?.credential.id === actor.credentialId;
  }
  if (credentialKind === "oauth") {
    const expectedAudience = typeof options.oauthAudience === "function" ? await options.oauthAudience() : options.oauthAudience;
    const current = await oauthTokens.verifyAccessToken(bearer, expectedAudience);
    if (!current) return false;
    if (current.kind === "user") return actor.kind === "user" && current.user.id === actor.user.id;
    return actor.kind === "service_account" && current.serviceAccount.id === actor.serviceAccount.id;
  }
  return false;
};

const readOnlyMiddlewares = new WeakSet<object>();

/**
 * Declare middleware that only authenticates, authorizes, validates or reads.
 * A read-only route cannot exempt another unmarked ALL handler: Hono uses
 * ALL for both `.use()` middleware and terminal `.all()` routes.
 * This declaration never exempts an endpoint from the default write requirement.
 */
const readOnlyMiddleware = <E extends Env = AuthContext>(handler: MiddlewareHandler<E>): MiddlewareHandler<E> => {
  readOnlyMiddlewares.add(handler);
  return handler;
};

/**
 * Universal auth middleware. Handles authentication AND authorization.
 * OAuth requests require `write` or `admin` scope for methods other than GET,
 * HEAD and OPTIONS, unless the route explicitly declares `auth.readOnly`.
 * Browser sessions and personal API keys keep their existing authority.
 *
 * @param args - Roles to check (OR logic) + optional RoleOptions at the end. Special roles:
 *   - "*": No check, always passes (like optionalAuth)
 *   - "authenticated": Any logged-in user
 *   - "anonymous": Only non-logged-in users (for login page)
 *
 * @example
 * // API: Only admins (returns JSON 401/403)
 * .use(requireRole("admin"))
 *
 * // API: Admins OR group managers
 * .use(requireRole("admin", "group-manager"))
 *
 * // SSR: Admin area with redirect
 * .use(requireRole("admin", redirect("/")))
 *
 * // SSR: Protected page with login redirect
 * .use(requireRole("authenticated", redirectToLogin))
 *
 * // SSR: Login page (only for non-logged-in users)
 * .use(requireRole("anonymous", redirect("/")))
 */
const requireRole = (...args: (RoleOrSpecial | RoleOptions)[]) => {
  // Parse args: roles + optional options at the end
  const lastArg = args[args.length - 1];
  const hasOptions = typeof lastArg === "object" && lastArg !== null && ("onReject" in lastArg || "oauthAudience" in lastArg);
  const options: RoleOptions = hasOptions ? (args.pop() as RoleOptions) : {};
  const roles = args as RoleOrSpecial[];

  return readOnlyMiddleware(
    createMiddleware<AuthContext>(async (c, next) => {
      const continueRequest = () => requireOAuthMutationScope(c, next);

      // "*" skips role checks but still resolves any credential and its scopes.
      if (roles.includes("*")) {
        await loadAuthenticatedActor(c, options);
        return continueRequest();
      }

      const { user, actor } = await loadAuthenticatedActor(c, options);

      // "anonymous" = must NOT be logged in
      if (roles.includes("anonymous")) {
        if (actor) {
          return handleReject(c, options, "forbidden");
        }
        return continueRequest();
      }

      // All other roles require authentication
      if (!actor) {
        return handleReject(c, options, "unauthenticated");
      }

      // "authenticated" = any logged-in user
      if (roles.includes("authenticated")) {
        return continueRequest();
      }

      if (!user) {
        return handleReject(c, options, "forbidden");
      }

      // Check if user has at least one required role
      const hasRequiredRole = roles.some((role) => user.roles.includes(role as Role));
      if (!hasRequiredRole) {
        return handleReject(c, options, "forbidden");
      }

      return continueRequest();
    }),
  );
};

/**
 * Require a request that has a user behind it.
 *
 * `requireRole("authenticated")` deliberately admits any authenticated
 * principal, including a resource-bound service account that has no user at
 * all — that is what lets an API key reach an ordinary app route. It is the one
 * role branch that does not imply a user, so a route gated with it that then
 * reaches for roles, ownership or a display name is reaching for something that
 * may not be there.
 *
 * Use this alongside it wherever the handler needs the user itself, so the
 * caller gets a 403 stating the reason instead of whatever the missing user
 * turns into further down.
 */
const requireUser = (options: RoleOptions = {}) =>
  readOnlyMiddleware(
    createMiddleware<AuthContext>(async (c, next) => {
      const { user } = await loadAuthenticatedActor(c);
      if (user) return requireOAuthMutationScope(c, next);
      // A caller that reaches here is authenticated but has no user, so the
      // generic "Insufficient permissions" would send them looking for a missing
      // role. `onReject` still wins, which is what keeps SSR redirects working.
      if (options.onReject) return handleReject(c, options, "forbidden");
      return c.json({ message: "Self-service endpoints require a user-backed actor", code: "FORBIDDEN" }, 403);
    }),
  );

/** Require one OAuth scope when the caller uses OAuth. Sessions and API credentials are unaffected. */
const requireOAuthScope = (...requiredScopes: string[]) =>
  readOnlyMiddleware(
    createMiddleware<AuthContext>(async (c, next) => {
      const scopes = c.get("oauthScopes");
      if (!scopes || requiredScopes.some((scope) => scopes.includes(scope))) return next();
      return c.json({ code: "FORBIDDEN", message: `OAuth scope ${requiredScopes.join(" or ")} is required` }, 403);
    }),
  );

/**
 * Explicitly declare a read-only POST route. Register on the route itself,
 * as its first handler, never with `.use()`: authentication can see the declaration before it runs.
 * This does not replace resource authorization or make a handler read-only.
 */
const readOnly = requireOAuthScope("read", "admin");

/** Internal protocol dispatchers check scope against the resolved operation. */
export const oauthScopeByOperation = createMiddleware<AuthContext>(async (_c, next) => next());

export const requireOAuthMutationScope = createMiddleware<AuthContext>(async (c, next) => {
  if (["GET", "HEAD", "OPTIONS"].includes(c.req.method)) return next();
  // Only an explicit method registration can relax the default. A declaration
  // accidentally mounted with `.use()` or on a wildcard cannot exempt a subtree.
  const matched = matchedRoutes(c);
  const lastMethod = matched.findLastIndex((route) => route.method !== "ALL");
  const unguardedAllHandler = matched
    .slice(c.req.routeIndex + 1, lastMethod)
    .some((route) => route.method === "ALL" && !readOnlyMiddlewares.has(findTargetHandler(route.handler)));
  const routes = matched.filter((route) => route.method !== "ALL");
  const first = routes[0];
  const handler = first && findTargetHandler(first.handler);
  const declared =
    !unguardedAllHandler &&
    first?.method === c.req.method &&
    !first.path.includes("*") &&
    (handler === readOnly || handler === oauthScopeByOperation) &&
    routes.every((route) => route.method === first.method && route.path === first.path);
  if (declared) return handler === readOnly ? requireOAuthScope("read", "admin")(c, next) : next();
  return requireOAuthScope("write", "admin")(c, next);
});

const getAuthority = <E extends AuthContext>(c: Context<E>): RequestAuthority => {
  const actor = c.get("actor");
  const accessSubject = c.get("accessSubject");
  const credentialKind = c.get("credentialKind");
  if (!actor || !accessSubject || !credentialKind) throw new Error("Request authority has not been resolved");
  return {
    actor,
    accessSubject,
    credentialKind,
    scopes: [...(c.get("credentialScopes") ?? [])],
    ...(c.get("credentialProof") ? { credentialProof: c.get("credentialProof") } : {}),
  };
};

/**
 * True when the request acts through the mobile app's session, directly or through an
 * invocation made for one. Such requests cannot create authority that outlives the phone.
 */
const isAppSession = <E extends AuthContext>(c: Context<E>): boolean => isAppSessionActor(c.get("actor"));

/** Returns only the browser session identity authenticated for this request. */
const browserSignIn = async <E extends AuthContext>(c: Context<E>): Promise<{ userId: string; sid: string; authEpoch: number } | null> => {
  if (c.get("credentialKind") !== "session" || c.get("actor")?.kind !== "user" || isAppSession(c)) return null;
  const token = c.get("sessionToken");
  if (!token) return null;
  const authenticated = await session.authenticateRequest(c, token);
  return authenticated?.data.kind === "web"
    ? { userId: authenticated.data.userId, sid: authenticated.data.sid, authEpoch: authenticated.data.authEpoch }
    : null;
};

/** The standard answer for actions the mobile app may not take. */
export const APP_SESSION_FORBIDDEN = { code: "FORBIDDEN", message: "Use Cloud on the web for this." } as const;

/**
 * Rejects the mobile app's session with `403` {@link APP_SESSION_FORBIDDEN}. Use it on every route
 * that creates authority outliving the phone: sign-in methods, API keys, background mandates.
 */
const rejectAppSession = createMiddleware<AuthContext>(async (c, next) => (isAppSession(c) ? c.json(APP_SESSION_FORBIDDEN, 403) : next()));

/** Preset: Redirect to a fixed URL on rejection */
const redirect = (url: string): RoleOptions => ({
  onReject: () => url,
});

/** Preset: Redirect to login page with returnTo parameter */
const redirectToLogin: RoleOptions = {
  onReject: (c) => createLoginRedirectUrl(c.req.url),
};

const requireAccount = (options: AccountOptions) =>
  readOnlyMiddleware(
    createMiddleware<AuthContext>(async (c, next) => {
      const { user } = await loadAuthenticatedActor(c);

      if (!user) {
        return handleReject(c, options, "unauthenticated");
      }

      if (options.provider && user.provider !== options.provider) {
        return handleReject(c, options, "forbidden");
      }

      if (options.profile && user.profile !== options.profile) {
        return handleReject(c, options, "forbidden");
      }

      return requireOAuthMutationScope(c, next);
    }),
  );

// ==========================
// Export
// ==========================

export const auth = {
  session,
  requireRole,
  requireUser,
  isAppSession,
  browserSignIn,
  rejectAppSession,
  requireOAuthScope,
  readOnly,
  readOnlyMiddleware,
  getAuthority,
  requireAccount,
  redirect,
  redirectToLogin,
};
