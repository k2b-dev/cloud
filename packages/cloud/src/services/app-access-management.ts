import { type SQL, sql } from "bun";
import type { AppMeta } from "../contracts/app";
import type { AppAccessDeclaration, AppAccessSnapshot } from "../contracts/app-access";
import { publishAppAccessChanged, wakeAppAccessChanged } from "../events/app-access";
import { isAppSessionActor, userFromActor } from "../server/actor";
import type { RequestAuthority } from "../server/middleware/auth";
import {
  type AccessEntry,
  buildAccessPrincipalCondition,
  createAccess,
  getEffectivePermission,
  type Principal,
  resolveDisplayNames,
} from "../server/services/access";
import { isAccountExpired } from "./account-model";
import { recursiveGroupIdsSubquery } from "./accounts/group-sql";
import { canUseApp } from "./app-access";
import { audit } from "./audit";
import { getIdentityRuntimeConfig } from "./identity/runtime-config";
import type { ServiceAccount } from "./service-accounts";
import { loadJwtSession } from "./session/user";

type ManagedApp = Pick<AppMeta, "id" | "name" | "access">;

export type { AppAccessSnapshot } from "../contracts/app-access";
export type AppAccessChange =
  | { action: "grant"; principal: Principal; permission: "read" | "admin" }
  | { action: "update"; accessId: string; permission: "read" | "admin" }
  | { action: "revoke"; accessId: string };
export class AppAccessManagementError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 400 | 403 | 404 | 409 = 403,
  ) {
    super(message);
  }
}

const credentialIsEligible = (authority: RequestAuthority): boolean => {
  if (authority.scopes.includes("ai:inference")) return false;
  const user = userFromActor(authority.actor);
  if (user && isAccountExpired(user.accountExpires)) return false;
  if (authority.actor.kind !== "service_account") return true;
  const { serviceAccount, credentialExpiresAt } = authority.actor;
  return (
    serviceAccount.status === "active" &&
    serviceAccount.kind !== "resource_bound" &&
    (!credentialExpiresAt || new Date(credentialExpiresAt).getTime() > Date.now())
  );
};

/** Repair is administration authority, never an implicit usage grant. */
export const canRepairAppAccess = (authority: RequestAuthority): boolean => {
  if (!credentialIsEligible(authority) || isAppSessionActor(authority.actor) || !userFromActor(authority.actor)?.roles.includes("admin"))
    return false;
  const kind = authority.credentialKind === "invocation" ? authority.actor.delegation?.credentialKind : authority.credentialKind;
  return (
    kind === "session" ||
    (kind === "api_key" &&
      authority.actor.kind === "service_account" &&
      authority.actor.serviceAccount.kind === "user_delegated" &&
      authority.scopes.length === 0) ||
    authority.scopes.includes("admin")
  );
};
const canWriteList = (authority: RequestAuthority, appId: string): boolean => {
  if (!credentialIsEligible(authority)) return false;
  const kind = authority.credentialKind === "invocation" ? authority.actor.delegation?.credentialKind : authority.credentialKind;
  return (
    kind === "session" ||
    (kind === "api_key" &&
      authority.actor.kind === "service_account" &&
      authority.actor.serviceAccount.kind === "user_delegated" &&
      authority.scopes.length === 0) ||
    authority.scopes.some((scope) => ["write", "admin", `${appId}:write`, `${appId}:admin`, `${appId}:*`].includes(scope))
  );
};

const listEntries = async (appId: string, db: SQL = sql): Promise<AccessEntry[]> => {
  const rows = await db<
    {
      id: string;
      user_id: string | null;
      group_id: string | null;
      service_account_id: string | null;
      authenticated_only: boolean;
      permission: "read" | "admin";
      created_at: Date;
    }[]
  >`
    SELECT a.* FROM auth.app_access j JOIN auth.access a ON a.id = j.access_id
    WHERE j.app_id = ${appId} ORDER BY a.created_at, a.id
  `;
  return rows.map((row) => ({
    id: row.id,
    permission: row.permission,
    createdAt: row.created_at.toISOString(),
    principal: row.user_id
      ? { type: "user", userId: row.user_id }
      : row.group_id
        ? { type: "group", groupId: row.group_id }
        : row.service_account_id
          ? { type: "service_account", serviceAccountId: row.service_account_id }
          : row.authenticated_only
            ? { type: "authenticated" }
            : { type: "public" },
  }));
};
/** Shared eligibility predicate for the last-manager guard and its presentation. */
const managerEligibility = (db: SQL) => db`
  EXISTS (SELECT 1 FROM auth.users u WHERE (u.account_expires IS NULL OR u.account_expires > now()) AND
    (u.id = a.user_id OR (a.group_id IS NOT NULL AND a.group_id IN (${recursiveGroupIdsSubquery(db`u.id`)}))))
  OR EXISTS (SELECT 1 FROM auth.service_accounts sa WHERE sa.id = a.service_account_id
    AND sa.status = 'active' AND sa.kind IN ('standalone', 'agent'))
`;

const entryPresentation = async (appId: string): Promise<Map<string, { groupMemberCount?: number; effectiveManager: boolean }>> => {
  const rows = await sql<{ id: string; group_member_count: number | null; effective_manager: boolean }[]>`
    SELECT a.id,
      CASE WHEN a.group_id IS NOT NULL THEN (
        SELECT count(*)::integer FROM auth.users u
        WHERE a.group_id IN (${recursiveGroupIdsSubquery(sql`u.id`)})
      ) END AS group_member_count,
      a.permission = 'admin' AND (${managerEligibility(sql)}) AS effective_manager
    FROM auth.app_access j JOIN auth.access a ON a.id = j.access_id
    WHERE j.app_id = ${appId}
  `;
  return new Map(
    rows.map((row) => [
      row.id,
      {
        ...(row.group_member_count === null ? {} : { groupMemberCount: row.group_member_count }),
        effectiveManager: row.effective_manager,
      },
    ]),
  );
};

const requireConfigurable = (app: ManagedApp) => {
  if (app.access?.kind !== "grants")
    throw new AppAccessManagementError("APP_ACCESS_FIXED", "This application uses a fixed access rule.", 409);
  return app.access;
};

export const requireAppAccessManager = async (
  authority: RequestAuthority,
  app: ManagedApp,
  options: { repair?: boolean; canManage?: AppAccessDeclaration["canManage"]; db?: SQL } = {},
): Promise<void> => {
  requireConfigurable(app);
  if (options.repair) {
    if (!canRepairAppAccess(authority))
      throw new AppAccessManagementError("FORBIDDEN", "Cloud administration authority is required to repair app access.");
    return;
  }
  if (!canWriteList(authority, app.id)) throw new AppAccessManagementError("FORBIDDEN", "This credential cannot manage app access.");
  const entries = await listEntries(app.id, options.db);
  const permission = await getEffectivePermission(
    {
      accessIds: entries
        .filter((entry) => entry.principal.type !== "public" && entry.principal.type !== "authenticated")
        .map((entry) => entry.id),
      subject: authority.accessSubject,
    },
    options.db,
  );
  if (permission !== "admin" || (options.canManage && !(await options.canManage(authority, { db: options.db ?? sql })))) {
    throw new AppAccessManagementError("FORBIDDEN", "A person who manages this application's access can change the list.");
  }
};

/** Whether the app should show its access settings to this caller. Unexpected failures remain visible to the caller. */
export const canManageAppAccess = async (
  authority: RequestAuthority,
  app: ManagedApp,
  canManage?: AppAccessDeclaration["canManage"],
): Promise<boolean> => {
  if (app.access?.kind !== "grants") return false;
  try {
    await requireAppAccessManager(authority, app, { canManage });
    return true;
  } catch (error) {
    if (error instanceof AppAccessManagementError && error.status === 403) return false;
    throw error;
  }
};

export const readAppAccess = async (params: {
  app: ManagedApp;
  authority: RequestAuthority;
  repair?: boolean;
  canManage?: AppAccessDeclaration["canManage"];
}): Promise<AppAccessSnapshot> => {
  await requireAppAccessManager(params.authority, params.app, params);
  const [state] = await sql<
    { configured_at: Date | null }[]
  >`SELECT configured_at FROM auth.app_access_state WHERE app_id = ${params.app.id}`;
  const entries = await listEntries(params.app.id);
  const rule = requireConfigurable(params.app);
  const inheritedSignedIn = !state?.configured_at && rule.until?.kind === "signedIn";
  if (inheritedSignedIn && !entries.some((entry) => entry.principal.type === "authenticated"))
    entries.unshift({
      id: "inherited-authenticated",
      principal: { type: "authenticated" },
      permission: "read",
      createdAt: "1970-01-01T00:00:00.000Z",
    });
  const matches = buildAccessPrincipalCondition({
    subject: params.authority.accessSubject,
    columns: {
      userId: sql`a.user_id`,
      groupId: sql`a.group_id`,
      serviceAccountId: sql`a.service_account_id`,
      authenticatedOnly: sql`a.authenticated_only`,
    },
  });
  const own = await sql<{ id: string }[]>`SELECT a.id FROM auth.app_access j JOIN auth.access a ON a.id = j.access_id
    WHERE j.app_id = ${params.app.id} AND ${matches}`;
  const groupsAdmin = params.canManage && !params.repair ? (await getIdentityRuntimeConfig()).groupsAdmin : [];
  const presentation = await entryPresentation(params.app.id);
  return {
    ownEntryIds: [...own.map((entry) => entry.id), ...(inheritedSignedIn ? ["inherited-authenticated"] : [])],
    appId: params.app.id,
    name: params.app.name,
    entries: (await resolveDisplayNames(entries)).map((entry) => ({ ...entry, ...presentation.get(entry.id) })),
    configured: !!state?.configured_at,
    hasEffectiveManager: await hasEffectiveManager(
      params.app,
      sql,
      groupsAdmin,
      params.repair ? undefined : params.canManage,
      params.authority,
    ),
    inheritedSignedIn,
    canUse: await canUseApp(params.authority, params.app),
  };
};

/**
 * Restrictions are identity/domain predicates evaluated with canonical, currently usable
 * session or API-key authority. Never manufacture roles, session kinds or broader scopes.
 * OAuth/invocation-only eligibility cannot be established from durable credential metadata;
 * no supported candidate within one maximum identity page means fail closed.
 */
const hasRestrictedManager = async (
  appId: string,
  db: SQL,
  canManage: NonNullable<AppAccessDeclaration["canManage"]>,
  groupsAdmin: string[],
): Promise<boolean> => {
  // The maximum page size of the public PaginationQuerySchema bounds callback work,
  // including multiple sessions/keys belonging to one principal, under the app row lock.
  const budget = 100;
  const sessions = await db<{ sid: string; user_id: string; auth_epoch: number }[]>`
    SELECT sf.sid, sf.user_id, sf.auth_epoch FROM auth.session_families sf
    JOIN auth.users u ON u.id = sf.user_id
    JOIN auth.signing_keys sk ON sk.kid = sf.signing_kid AND sk.state <> 'revoked'
    WHERE sf.revoked_at IS NULL AND sf.expires_at > now() AND sf.auth_epoch = u.auth_epoch
      AND (u.account_expires IS NULL OR u.account_expires > now())
      AND EXISTS (
        SELECT 1 FROM auth.app_access j JOIN auth.access a ON a.id = j.access_id
        WHERE j.app_id = ${appId} AND a.permission = 'admin'
          AND (a.user_id = u.id OR (a.group_id IS NOT NULL AND a.group_id IN (${recursiveGroupIdsSubquery(sql`u.id`)})))
      )
    ORDER BY sf.sid LIMIT ${budget}
  `;
  if (sessions.length) {
    for (const candidate of sessions) {
      // The same loader as HTTP authentication checks category, consent, key/family
      // revocation and auth epoch, and strips admin for mobile app sessions.
      const loaded = await loadJwtSession(
        { userId: candidate.user_id, sid: candidate.sid, authEpoch: candidate.auth_epoch, groupsAdmin },
        db,
      );
      if (!loaded) continue;
      const authority: RequestAuthority = {
        actor: { kind: "user", user: loaded.user, ...(loaded.pwaDeviceId ? { sessionKind: "app" } : {}) },
        accessSubject: { type: "user", userId: loaded.user.id },
        credentialKind: "session",
        scopes: [],
      };
      if (canWriteList(authority, appId) && (await canManage(authority, { db }))) return true;
    }
  }
  const remaining = budget - sessions.length;
  if (!remaining) return false;
  const credentials = await db<
    {
      id: string;
      scopes: string[];
      expires_at: Date | null;
      service_account_id: string;
      name: string;
      kind: ServiceAccount["kind"];
      status: ServiceAccount["status"];
      delegated_user_id: string | null;
      app_id: string | null;
      resource_type: string | null;
      resource_id: string | null;
      created_by: string | null;
      created_at: Date;
    }[]
  >`
    SELECT c.id, c.scopes, c.expires_at, sa.id AS service_account_id,
      sa.name, sa.kind, sa.status, sa.delegated_user_id, sa.app_id, sa.resource_type, sa.resource_id, sa.created_by, sa.created_at
    FROM auth.service_account_credentials c JOIN auth.service_accounts sa ON sa.id = c.service_account_id
    WHERE c.kind = 'api_token' AND c.status = 'active' AND (c.expires_at IS NULL OR c.expires_at > now())
      AND sa.status = 'active' AND sa.kind IN ('standalone', 'agent')
      AND EXISTS (
        SELECT 1 FROM auth.app_access j JOIN auth.access a ON a.id = j.access_id
        WHERE j.app_id = ${appId} AND a.permission = 'admin' AND a.service_account_id = sa.id
      )
    ORDER BY c.id LIMIT ${remaining}
  `;
  for (const candidate of credentials) {
    // Only non-secret metadata is selected. Keep both scope fields and the credential
    // identity/expiry exactly as the API-key middleware exposes them.
    const authority: RequestAuthority = {
      actor: {
        kind: "service_account",
        serviceAccount: {
          id: candidate.service_account_id,
          name: candidate.name,
          kind: candidate.kind,
          status: candidate.status,
          delegatedUserId: candidate.delegated_user_id,
          appId: candidate.app_id,
          resourceType: candidate.resource_type,
          resourceId: candidate.resource_id,
          createdBy: candidate.created_by,
          createdAt: candidate.created_at.toISOString(),
        },
        delegatedUser: null,
        scopes: candidate.scopes,
        credentialId: candidate.id,
        credentialExpiresAt: candidate.expires_at?.toISOString() ?? null,
      },
      accessSubject: { type: "service_account", serviceAccountId: candidate.service_account_id },
      credentialKind: "api_key",
      scopes: candidate.scopes,
    };
    if (canWriteList(authority, appId) && (await canManage(authority, { db }))) return true;
  }
  return false;
};

/** An empty group cannot keep the list manageable. User-delegated and resource-bound keys cannot be its last manager. */
const hasEffectiveManager = async (
  app: ManagedApp,
  db: SQL,
  groupsAdmin: string[],
  canManage?: AppAccessDeclaration["canManage"],
  current?: RequestAuthority,
): Promise<boolean> => {
  if (canManage) {
    // The real request can also prove eligibility (including OAuth/invocations),
    // but only if its management grant still exists after the proposed mutation.
    let currentHasGrant = false;
    if (current) {
      try {
        await requireAppAccessManager(current, app, { db });
        currentHasGrant = true;
      } catch (error) {
        if (!(error instanceof AppAccessManagementError && error.code === "FORBIDDEN")) throw error;
      }
      if (currentHasGrant && (await canManage(current, { db }))) return true;
    }
    return hasRestrictedManager(app.id, db, canManage, groupsAdmin);
  }
  const [row] = await db<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM auth.app_access j JOIN auth.access a ON a.id = j.access_id
      WHERE j.app_id = ${app.id} AND a.permission = 'admin' AND (${managerEligibility(db)})
    ) AS exists
  `;
  return row?.exists ?? false;
};

const samePrincipal = (left: Principal, right: Principal): boolean => {
  switch (left.type) {
    case "user":
      return right.type === "user" && left.userId === right.userId;
    case "group":
      return right.type === "group" && left.groupId === right.groupId;
    case "service_account":
      return right.type === "service_account" && left.serviceAccountId === right.serviceAccountId;
    default:
      return left.type === right.type;
  }
};

export const changeAppAccess = async (params: {
  app: ManagedApp;
  authority: RequestAuthority;
  change: AppAccessChange;
  repair?: boolean;
  canManage?: AppAccessDeclaration["canManage"];
  requestId?: string;
}): Promise<{ entry?: AccessEntry; canUse: boolean }> => {
  const rule = requireConfigurable(params.app);
  const { app, authority, change } = params;
  // Runtime settings use the global pool. Resolve them before reserving a connection;
  // all grant checks, callbacks and candidate domain reads below must share db under the app lock.
  const groupsAdmin =
    params.canManage && !params.repair && canWriteList(authority, app.id) ? (await getIdentityRuntimeConfig()).groupsAdmin : [];
  const result = await sql.begin(async (db) => {
    await db`INSERT INTO auth.app_access_state (app_id) VALUES (${app.id}) ON CONFLICT DO NOTHING`;
    const [state] = await db<
      { configured_at: Date | null }[]
    >`SELECT configured_at FROM auth.app_access_state WHERE app_id = ${app.id} FOR UPDATE`;
    await requireAppAccessManager(authority, app, { ...params, db });
    const user = userFromActor(authority.actor);
    const record = (action: string, before: AccessEntry | null, after: AccessEntry | null) =>
      audit.record(
        {
          action,
          outcome: "allowed",
          actor: user ? { userId: user.id, uid: user.uid, provider: user.provider, roles: user.roles } : null,
          target: { type: "app", id: app.id, label: app.name },
          requestId: params.requestId,
          metadata: {
            before,
            after,
            via: params.repair ? "platform-admin" : "app",
            actorKind: authority.actor.kind,
            serviceAccountId: authority.actor.kind === "service_account" ? authority.actor.serviceAccount.id : null,
          },
        },
        db,
      );
    let entries = await listEntries(app.id, db);
    // Preserve signed-in use when saving the first manager, as shown in the initial list.
    if (!state?.configured_at && rule.until?.kind === "signedIn" && !entries.some((entry) => entry.principal.type === "authenticated")) {
      const created = await createAccess({ principal: { type: "authenticated" }, permission: "read" }, db);
      if (!created.ok) throw new AppAccessManagementError(created.error.code, created.error.message, 409);
      await db`INSERT INTO auth.app_access (app_id, access_id) VALUES (${app.id}, ${created.data.id}::uuid)`;
      entries = await listEntries(app.id, db);
      const seed = entries.find((entry) => entry.id === created.data.id)!;
      await record("app.access.granted", null, seed);
    }
    let changedId: string | undefined;
    if (change.action === "grant") {
      if (change.principal.type === "public" || (change.principal.type === "authenticated" && change.permission !== "read"))
        throw new AppAccessManagementError(
          "BAD_INPUT",
          "Grant Use to signed-in identities; public app access and audience managers are not supported.",
          400,
        );
      if (entries.some((entry) => samePrincipal(entry.principal, change.principal)))
        throw new AppAccessManagementError("CONFLICT", "This principal already has access.", 409);
      const created = await createAccess(change, db);
      if (!created.ok) throw new AppAccessManagementError(created.error.code, created.error.message, 400);
      changedId = created.data.id;
      await db`INSERT INTO auth.app_access (app_id, access_id) VALUES (${app.id}, ${changedId}::uuid)`;
    } else {
      const accessId =
        change.accessId === "inherited-authenticated"
          ? entries.find((entry) => entry.principal.type === "authenticated")?.id
          : change.accessId;
      const before = entries.find((entry) => entry.id === accessId);
      if (!before) throw new AppAccessManagementError("NOT_FOUND", "Access entry not found.", 404);
      if (change.action === "update") {
        if (before.principal.type === "public") throw new AppAccessManagementError("BAD_INPUT", "Public app access is not supported.", 400);
        if (before.principal.type === "authenticated" && change.permission !== "read")
          throw new AppAccessManagementError("BAD_INPUT", "Signed-in identities may only receive Use.", 400);
        await db`UPDATE auth.access SET permission = ${change.permission}::auth.permission_level WHERE id = ${before.id}::uuid`;
        changedId = before.id;
      } else await db`DELETE FROM auth.access WHERE id = ${before.id}::uuid`;
      await record(
        change.action === "update" ? "app.access.updated" : "app.access.revoked",
        before,
        change.action === "update" ? { ...before, permission: change.permission } : null,
      );
    }
    if (!(await hasEffectiveManager(app, db, groupsAdmin, params.repair ? undefined : params.canManage, authority)))
      throw new AppAccessManagementError("LAST_MANAGER", "At least one person must manage access. Add another manager first.", 409);
    await db`UPDATE auth.app_access_state SET configured_at = COALESCE(configured_at, now()) WHERE app_id = ${app.id}`;
    const after = changedId ? (await listEntries(app.id, db)).find((entry) => entry.id === changedId) : undefined;
    if (change.action === "grant") await record("app.access.granted", null, after ?? null);
    await publishAppAccessChanged(db, app.id);
    return after;
  });
  wakeAppAccessChanged();
  return { entry: result ? (await resolveDisplayNames([result]))[0] : undefined, canUse: await canUseApp(authority, app) };
};

/** Only manager names, for the intentionally limited direct-link denial page. */
export const appAccessManagers = async (appId: string): Promise<AccessEntry[]> => {
  const presentation = await entryPresentation(appId);
  const entries = (await listEntries(appId)).filter((entry) => presentation.get(entry.id)?.effectiveManager);
  return resolveDisplayNames(entries);
};

/** Batched grant counts for the administration repair overview. */
export const appAccessGrantCounts = async (authority: RequestAuthority, apps: readonly ManagedApp[]): Promise<Map<string, number>> => {
  if (!canRepairAppAccess(authority)) throw new AppAccessManagementError("FORBIDDEN", "Cloud administration authority is required.");
  const ids = apps.filter((app) => app.access?.kind === "grants").map((app) => app.id);
  if (!ids.length) return new Map();
  const rows = await sql<{ app_id: string; count: number; authenticated: boolean; configured: boolean }[]>`
    SELECT COALESCE(aa.app_id, s.app_id) AS app_id, count(aa.access_id)::integer AS count,
      COALESCE(bool_or(a.authenticated_only), false) AS authenticated,
      s.configured_at IS NOT NULL AS configured
    FROM auth.app_access aa
    FULL JOIN auth.app_access_state s ON s.app_id = aa.app_id
    LEFT JOIN auth.access a ON a.id = aa.access_id
    WHERE COALESCE(aa.app_id, s.app_id) IN ${sql(ids)} GROUP BY aa.app_id, s.app_id, s.configured_at
  `;
  return new Map(
    apps
      .filter((app) => app.access?.kind === "grants")
      .map((app) => {
        const row = rows.find((row) => row.app_id === app.id);
        // The editor includes this inherited audience before the first save.
        const inherited = app.access?.kind === "grants" && app.access.until?.kind === "signedIn" && !row?.configured && !row?.authenticated;
        return [app.id, (row?.count ?? 0) + (inherited ? 1 : 0)];
      }),
  );
};
