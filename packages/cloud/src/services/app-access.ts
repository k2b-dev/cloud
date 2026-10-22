import { type SQL, sql } from "bun";
import type { Context } from "hono";
import type { AppMeta } from "../contracts/app";
import { AppAccessRuleSchema, type FixedAppAccessRule } from "../contracts/app-access";
import { userFromActor } from "../server/actor";
import type { AuthContext, RequestAuthority } from "../server/middleware/auth";
import { buildAccessPrincipalCondition } from "../server/services/access";
import { logger } from "./logging";
import { toPgTextArray } from "./postgres";

type AccessApp = Pick<AppMeta, "id" | "access">;
type GrantState = { app_id: string; configured: boolean; permission: "read" | "admin" | null };

/** Read the already resolved identity; never reload unrestricted roles from its subject ID. */
export const appAccessAuthority = <E extends AuthContext>(c: Context<E>): RequestAuthority | null => {
  const actor = c.get("actor");
  const accessSubject = c.get("accessSubject");
  const credentialKind = c.get("credentialKind");
  if (!actor || !accessSubject || !credentialKind) return null;
  return { actor, accessSubject, credentialKind, scopes: c.get("credentialScopes") ?? [] };
};

const credentialAllows = (authority: RequestAuthority, appId: string): boolean => {
  const actor = authority.actor;
  if (actor.kind === "service_account") {
    if (actor.serviceAccount.status !== "active") return false;
    if (actor.serviceAccount.kind === "resource_bound" && actor.serviceAccount.appId !== appId) return false;
    if (actor.credentialExpiresAt && !(new Date(actor.credentialExpiresAt).getTime() > Date.now())) return false;
  }
  const credentialKind = authority.credentialKind === "invocation" ? actor.delegation?.credentialKind : authority.credentialKind;
  if (authority.scopes.includes("ai:inference")) return false;
  // Full personal API keys intentionally carry no scopes. Resource/standalone
  // keys retain their caps; app-prefixed scopes are already used by applications.
  if (credentialKind === "session" || credentialKind === "mandate") return true;
  if (
    credentialKind === "api_key" &&
    actor.kind === "service_account" &&
    actor.serviceAccount.kind === "user_delegated" &&
    authority.scopes.length === 0
  )
    return true;
  return authority.scopes.some((scope) =>
    ["read", "write", "admin", `${appId}:read`, `${appId}:write`, `${appId}:admin`, `${appId}:*`].includes(scope),
  );
};

const fixedAllows = (authority: RequestAuthority, rule: FixedAppAccessRule): boolean => {
  const user = userFromActor(authority.actor);
  switch (rule.kind) {
    case "signedIn":
      return true;
    case "noGuests":
      return user?.profile !== "guest";
    case "roles":
      return !!user && rule.roles.some((role) => (role === "guest" ? user.profile === "guest" : user.roles.includes(role)));
    default:
      return false;
  }
};

/** Pure decision shared by single-app and batched reads. Missing grant state means unconfigured, not an implicit grant. */
export const evaluateAppAccess = (authority: RequestAuthority | null, app: AccessApp, state?: GrantState): boolean => {
  if (app.access === undefined) return true; // Step 1 compatibility; no inferred entry rule.
  if (!authority || !credentialAllows(authority, app.id)) return false;
  const parsed = AppAccessRuleSchema.safeParse(app.access);
  if (!parsed.success) return false;
  const rule = parsed.data;
  if (rule.kind !== "grants") return fixedAllows(authority, rule);
  if (!state?.configured) return !!rule.until && fixedAllows(authority, rule.until);
  return state.permission === "read" || state.permission === "admin";
};

let lastFailureLog = -Infinity;
const reportFailure = () => {
  if (Date.now() - lastFailureLog < 60_000) return;
  lastFailureLog = Date.now();
  logger("app-access").error("Application access could not be resolved; configurable applications are unavailable");
};

/**
 * One authoritative SQL read for all configurable apps. No grant cache: revocation applies on the next request.
 * Pass the reserved transaction as `db` when checking access inside a guarded operation.
 */
export const usableAppIds = async (
  authority: RequestAuthority | null,
  apps: readonly AccessApp[],
  options: { db?: SQL } = {},
): Promise<Set<string>> => {
  const db = options.db ?? sql;
  const allowed = new Set(apps.filter((app) => app.access?.kind !== "grants" && evaluateAppAccess(authority, app)).map((app) => app.id));
  if (!authority) return allowed;
  const configurable = apps.filter((app) => app.access?.kind === "grants" && credentialAllows(authority, app.id));
  if (configurable.length === 0) return allowed;
  try {
    const principal = buildAccessPrincipalCondition({
      subject: authority.accessSubject,
      columns: {
        userId: db`a.user_id`,
        groupId: db`a.group_id`,
        serviceAccountId: db`a.service_account_id`,
        authenticatedOnly: db`a.authenticated_only`,
      },
    });
    const states = await db<GrantState[]>`
      SELECT requested.app_id, s.configured_at IS NOT NULL AS configured,
        (SELECT a.permission FROM auth.app_access j JOIN auth.access a ON a.id = j.access_id
         WHERE j.app_id = requested.app_id AND a.permission IN ('read', 'admin')
           AND (a.user_id IS NOT NULL OR a.group_id IS NOT NULL OR a.service_account_id IS NOT NULL OR a.authenticated_only)
           AND ${principal}
         ORDER BY CASE a.permission WHEN 'admin' THEN 2 ELSE 1 END DESC LIMIT 1) AS permission
      FROM unnest(${toPgTextArray(configurable.map((app) => app.id))}::text[]) AS requested(app_id)
      LEFT JOIN auth.app_access_state s ON s.app_id = requested.app_id
    `;
    const byApp = new Map(states.map((state) => [state.app_id, state]));
    for (const app of configurable) if (evaluateAppAccess(authority, app, byApp.get(app.id))) allowed.add(app.id);
  } catch {
    reportFailure();
  }
  return allowed;
};

export const canUseApp = async (authority: RequestAuthority | null, app: AccessApp, options: { db?: SQL } = {}): Promise<boolean> =>
  (await usableAppIds(authority, [app], options)).has(app.id);
