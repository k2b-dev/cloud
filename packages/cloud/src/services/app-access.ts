import type { SQL } from "bun";
import type { Context } from "hono";
import {
  RESOURCE_ACCESS_ENTRY_TIMEOUT_MS,
  RESOURCE_ACCESS_PROBE_TIMEOUT_MS,
  RESOURCE_ACCESS_TIMEOUT_MS,
  resourceAccessSignal,
  resourceAppAccess,
} from "../_internal/app-access-resources";
import { startBounded } from "../api/fanout";
import type { AppMeta } from "../contracts/app";
import { AppAccessRuleSchema, type FixedAppAccessRule } from "../contracts/app-access";
import { sql } from "../runtime/clients";
import { userFromActor } from "../server/actor";
import { type AuthContext, auth, type RequestAuthority } from "../server/middleware/auth";
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
  return auth.getAuthority(c);
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
  if (rule.kind === "resources") return false; // Asynchronous adapter decision only.
  if (rule.kind !== "grants") return fixedAllows(authority, rule);
  if (!state?.configured) return !!rule.until && fixedAllows(authority, rule.until);
  return state.permission === "read" || state.permission === "admin";
};

let lastFailureLog = -Infinity;
const reportFailure = () => {
  if (Date.now() - lastFailureLog < 60_000) return;
  lastFailureLog = Date.now();
  logger("app-access").error("Application access could not be resolved; affected applications are unavailable");
};

const resourceFailures = new Map<string, { at: number; count: number }>();
const reportResourceFailure = (appId: string) => {
  const previous = resourceFailures.get(appId);
  const count = (previous?.count ?? 0) + 1;
  if (previous && Date.now() - previous.at < 60_000) {
    previous.count = count;
    return;
  }
  resourceFailures.set(appId, { at: Date.now(), count: 0 });
  logger("app-access").error("Application resource access could not be resolved; application is unavailable", {
    appId,
    failureCount: count,
  });
};

/**
 * One authoritative SQL read for all configurable lists; resource rules query the owning adapters.
 * No cross-request grant cache: revocation applies on the next request.
 * Pass the reserved transaction as `db` when checking access inside a guarded operation.
 * A supplied `signal` replaces the overall default budget; the caller must bound it.
 * Discovery still gives every app its own short probe limit.
 */
export const usableAppIds = async (
  authority: RequestAuthority | null,
  apps: readonly AccessApp[],
  options: { db?: SQL; signal?: AbortSignal } = {},
): Promise<Set<string>> => {
  const db = options.db ?? sql;
  const allowed = new Set(apps.filter((app) => app.access?.kind !== "grants" && evaluateAppAccess(authority, app)).map((app) => app.id));
  if (!authority) return allowed;
  const resources = apps.filter((app) => app.access?.kind === "resources" && credentialAllows(authority, app.id));
  if (resources.length) {
    const signal = resourceAccessSignal(authority, RESOURCE_ACCESS_TIMEOUT_MS, options.signal);
    // Operational budget: at most eight HTTP requests in flight per decision
    // (source -> Core -> owner), so four existence probes. Never enumerate resources.
    const pending = startBounded(
      resources,
      4,
      async (app) => {
        const probeSignal = AbortSignal.any([signal, AbortSignal.timeout(RESOURCE_ACCESS_PROBE_TIMEOUT_MS)]);
        return resourceAppAccess(authority, app, { ...options, signal: probeSignal });
      },
      signal,
    );
    const decisions = await Promise.all(pending);
    for (const [index, decision] of decisions.entries()) {
      const app = resources[index];
      if (!app) continue;
      if (decision.status === "fulfilled") {
        if (decision.value) allowed.add(app.id);
      } else if (!options.signal?.aborted) {
        // No authority, credential, resource IDs or upstream errors in this log.
        reportResourceFailure(app.id);
      }
    }
  }
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

export class AppAccessUnavailableError extends Error {
  readonly code = "app_access_unavailable";
  constructor(readonly app: AccessApp) {
    super("Application access is temporarily unavailable. Please try again.");
  }
}

export const canUseApp = async (
  authority: RequestAuthority | null,
  app: AccessApp,
  options: { db?: SQL; signal?: AbortSignal } = {},
): Promise<boolean> => {
  if (app.access?.kind !== "resources") return (await usableAppIds(authority, [app], options)).has(app.id);
  if (!authority || !credentialAllows(authority, app.id)) return false;
  const signal = resourceAccessSignal(authority, RESOURCE_ACCESS_ENTRY_TIMEOUT_MS, options.signal);
  try {
    return await resourceAppAccess(authority, app, { ...options, signal });
  } catch {
    if (options.signal?.aborted) throw options.signal.reason;
    reportResourceFailure(app.id);
    throw new AppAccessUnavailableError(app);
  }
};
