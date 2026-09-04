import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import type { MessageResponse, Role, RoleOrSpecial, User, UserProfile, UserProvider } from "../../contracts/shared";
import { isAccountExpired } from "../../services/account-model";
import { isReservedWorkloadApiCredential } from "../../services/identity/workload-auth";
import { oauthTokens } from "../../services/oauth-tokens";
import { serviceAccountCredentials } from "../../services/service-account-credentials";
import type { ServiceAccount } from "../../services/service-accounts";
import { session } from "../../services/session";
import { createLoginRedirectUrl } from "../../shared/redirect";
import type { AccessSubject } from "../services/access";

// ==========================
// Types
// ==========================

export type InvocationProvenance = {
  kind: "invocation";
  callingAppId: string;
  credentialKind: "session" | "oauth" | "api_key" | "mandate";
  invocationId: string;
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

export type RequestAuthority = {
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
    /** Constraints carried by OAuth/API credentials; absent sessions are unrestricted by transport scope. */
    credentialScopes?: string[];
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
  const token = session.getToken(c);
  const authenticatedSession = token ? await session.authenticateRequest(c, token) : null;
  const user = authenticatedSession?.user ?? null;

  if (user && token) {
    c.set("actor", { kind: "user", user });
    c.set("accessSubject", { type: "user", userId: user.id });
    c.set("user", user);
    c.set("sessionToken", token);
    c.set("credentialKind", "session");
  }

  if (user) return { token, user, actor: { kind: "user", user } };

  const bearer = session.getBearerToken(c);
  if (bearer && serviceAccountCredentials.isApiToken(bearer)) {
    const authResult = await serviceAccountCredentials.authenticateApiToken(bearer);
    if (!authResult) return { token: null, user: null, actor: null };
    // App workload keys enter only through Core's dedicated broker/authority
    // handlers, which authenticate their exact app binding directly.
    if (isReservedWorkloadApiCredential(authResult)) return { token: null, user: null, actor: null };
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

const loadAuthenticatedActor = (
  c: Context<AuthContext>,
  options: Pick<RoleOptions, "oauthAudience"> = {},
): Promise<AuthenticatedActorResult> => {
  if (options.oauthAudience) return loadAuthenticatedActorUncached(c, options);
  const existing = actorResolutionByRequest.get(c);
  if (existing) return existing;
  const pending = loadAuthenticatedActorUncached(c, options);
  actorResolutionByRequest.set(c, pending);
  return pending;
};

/**
 * Universal auth middleware. Handles authentication AND authorization.
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

  return createMiddleware<AuthContext>(async (c, next) => {
    // "*" = no check at all, pass through (but try to load user)
    if (roles.includes("*")) {
      await loadAuthenticatedActor(c, options);
      return next();
    }

    const { user, actor } = await loadAuthenticatedActor(c, options);

    // "anonymous" = must NOT be logged in
    if (roles.includes("anonymous")) {
      if (actor) {
        return handleReject(c, options, "forbidden");
      }
      return next();
    }

    // All other roles require authentication
    if (!actor) {
      return handleReject(c, options, "unauthenticated");
    }

    // "authenticated" = any logged-in user
    if (roles.includes("authenticated")) {
      return next();
    }

    if (!user) {
      return handleReject(c, options, "forbidden");
    }

    // Check if user has at least one required role
    const hasRequiredRole = roles.some((role) => user.roles.includes(role as Role));
    if (!hasRequiredRole) {
      return handleReject(c, options, "forbidden");
    }

    return next();
  });
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
  createMiddleware<AuthContext>(async (c, next) => {
    const { user } = await loadAuthenticatedActor(c);
    if (user) return next();
    // A caller that reaches here is authenticated but has no user, so the
    // generic "Insufficient permissions" would send them looking for a missing
    // role. `onReject` still wins, which is what keeps SSR redirects working.
    if (options.onReject) return handleReject(c, options, "forbidden");
    return c.json({ message: "Self-service endpoints require a user-backed actor", code: "FORBIDDEN" }, 403);
  });

/** Require one OAuth scope when the caller uses OAuth. Sessions and API credentials are unaffected. */
const requireOAuthScope = (...requiredScopes: string[]) =>
  createMiddleware<AuthContext>(async (c, next) => {
    const scopes = c.get("oauthScopes");
    if (!scopes || requiredScopes.some((scope) => scopes.includes(scope))) return next();
    return c.json({ code: "FORBIDDEN", message: `OAuth scope ${requiredScopes.join(" or ")} is required` }, 403);
  });

const getAuthority = (c: Context<AuthContext>): RequestAuthority => {
  const actor = c.get("actor");
  const accessSubject = c.get("accessSubject");
  const credentialKind = c.get("credentialKind");
  if (!actor || !accessSubject || !credentialKind) throw new Error("Request authority has not been resolved");
  return {
    actor,
    accessSubject,
    credentialKind,
    scopes: [...(c.get("credentialScopes") ?? [])],
  };
};

/** Preset: Redirect to a fixed URL on rejection */
const redirect = (url: string): RoleOptions => ({
  onReject: () => url,
});

/** Preset: Redirect to login page with returnTo parameter */
const redirectToLogin: RoleOptions = {
  onReject: (c) => createLoginRedirectUrl(c.req.url),
};

const requireAccount = (options: AccountOptions) =>
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

    return next();
  });

// ==========================
// Export
// ==========================

export const auth = {
  session,
  requireRole,
  requireUser,
  requireOAuthScope,
  getAuthority,
  requireAccount,
  redirect,
  redirectToLogin,
};
