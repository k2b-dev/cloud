import {
  type AccessEntry,
  type AccessSubject,
  buildAccessPrincipalCondition,
  createAccess,
  deleteAccess,
  hasPermission,
  type PermissionLevel,
  type Principal,
  resolveDisplayNames,
  updateAccess,
} from "@k2b/cloud/server";
import { accounts, audit } from "@k2b/cloud/services";
import { err, fail, ok, type Result, tryCatch, unwrap } from "@k2b/stdlib";
import { sql } from "bun";
import { auditActorFromRequest, capByCredentialScopes, isResourceBoundToMailbox, type MailRequestContext, userBackedActor } from "./auth";

type SqlClient = typeof sql;

/**
 * Matches an `auth.access` row (aliased `a`) against the subject making the
 * request.
 *
 * Mail used to spell this out per query as a recursive group CTE plus three
 * `OR`ed columns. That covered direct user, service-account and group grants
 * and silently ignored the other two principal tiers the platform supports, so
 * a mailbox shared with every authenticated user was invisible to everybody.
 * The shared builder covers all five tiers and resolves nested membership from
 * the subject, which is the only trustworthy source.
 */
export const mailboxAccessPrincipalCondition = (subject: AccessSubject | null) =>
  buildAccessPrincipalCondition({
    subject,
    columns: {
      userId: sql`a.user_id`,
      groupId: sql`a.group_id`,
      serviceAccountId: sql`a.service_account_id`,
      authenticatedOnly: sql`a.authenticated_only`,
    },
  });

type DbAccess = {
  id: string;
  user_id: string | null;
  group_id: string | null;
  service_account_id: string | null;
  authenticated_only: boolean;
  permission: PermissionLevel;
  created_at: Date | string;
};

const principalFromRow = (row: DbAccess): Principal => {
  if (row.user_id) return { type: "user", userId: row.user_id };
  if (row.group_id) return { type: "group", groupId: row.group_id };
  if (row.service_account_id) return { type: "service_account", serviceAccountId: row.service_account_id };
  if (row.authenticated_only) return { type: "authenticated" };
  return { type: "public" };
};

const mapAccess = (row: DbAccess): AccessEntry => ({
  id: row.id,
  principal: principalFromRow(row),
  permission: row.permission,
  createdAt: (row.created_at instanceof Date ? row.created_at : new Date(row.created_at)).toISOString(),
});

const assertShareablePrincipal = (principal: Principal): Result<void> => {
  if (principal.type === "user" || principal.type === "group" || principal.type === "service_account") return ok();
  return fail(err.badInput("Mailboxes can be shared only with users, groups, or service accounts"));
};

const lockMailbox = async (mailboxId: string, db: SqlClient): Promise<boolean> => {
  const [row] = await db<{ id: string }[]>`
    SELECT id
    FROM mail.mailboxes
    WHERE id = ${mailboxId}::uuid AND deleted_at IS NULL
    FOR UPDATE
  `;
  return Boolean(row);
};

export const isCurrentActorActive = async (context: MailRequestContext, db: SqlClient = sql): Promise<boolean> => {
  if (context.actor.kind === "user") {
    const [row] = await db<{ active: boolean }[]>`
      SELECT EXISTS (
        SELECT 1
        FROM auth.users
        WHERE id = ${context.actor.user.id}::uuid
          AND (account_expires IS NULL OR account_expires > now())
      ) AS active
    `;
    return row?.active === true;
  }
  const [row] = await db<{ active: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
      FROM auth.service_accounts service_account
      WHERE service_account.id = ${context.actor.serviceAccount.id}::uuid
        AND service_account.status = 'active'
        AND (
          service_account.delegated_user_id IS NULL
          OR EXISTS (
            SELECT 1
            FROM auth.users delegated_user
            WHERE delegated_user.id = service_account.delegated_user_id
              AND (delegated_user.account_expires IS NULL OR delegated_user.account_expires > now())
          )
        )
    ) AS active
  `;
  return row?.active === true;
};

type CurrentUserLoader = typeof accounts.users.get;

export const isCurrentPlatformAdmin = async (
  context: MailRequestContext,
  loadCurrentUser: CurrentUserLoader = accounts.users.get,
): Promise<boolean> => {
  const user = userBackedActor(context);
  if (!user) return false;
  const currentUser = await loadCurrentUser({ id: user.id });
  return currentUser?.roles.includes("admin") === true && !accounts.model.isAccountExpired(currentUser.accountExpires);
};

const getPrincipalGrant = async (mailboxId: string, principal: Principal, db: SqlClient): Promise<DbAccess | null> => {
  if (principal.type === "user") {
    const [row] = await db<DbAccess[]>`
      SELECT a.id, a.user_id, a.group_id, a.service_account_id, a.authenticated_only, a.permission, a.created_at
      FROM mail.mailbox_access ma
      JOIN auth.access a ON a.id = ma.access_id
      WHERE ma.mailbox_id = ${mailboxId}::uuid AND a.user_id = ${principal.userId}::uuid
      LIMIT 1
    `;
    return row ?? null;
  }
  if (principal.type === "group") {
    const [row] = await db<DbAccess[]>`
      SELECT a.id, a.user_id, a.group_id, a.service_account_id, a.authenticated_only, a.permission, a.created_at
      FROM mail.mailbox_access ma
      JOIN auth.access a ON a.id = ma.access_id
      WHERE ma.mailbox_id = ${mailboxId}::uuid AND a.group_id = ${principal.groupId}::uuid
      LIMIT 1
    `;
    return row ?? null;
  }
  if (principal.type === "service_account") {
    const [row] = await db<DbAccess[]>`
      SELECT a.id, a.user_id, a.group_id, a.service_account_id, a.authenticated_only, a.permission, a.created_at
      FROM mail.mailbox_access ma
      JOIN auth.access a ON a.id = ma.access_id
      WHERE ma.mailbox_id = ${mailboxId}::uuid AND a.service_account_id = ${principal.serviceAccountId}::uuid
      LIMIT 1
    `;
    return row ?? null;
  }
  return null;
};

export const getMailboxPermission = async (
  context: MailRequestContext,
  mailboxId: string,
  db: SqlClient = sql,
): Promise<PermissionLevel> => {
  return getMailboxPermissionForLifecycle(context, mailboxId, false, db);
};

const getMailboxPermissionForLifecycle = async (
  context: MailRequestContext,
  mailboxId: string,
  includeDeleted: boolean,
  db: SqlClient,
): Promise<PermissionLevel> => {
  if (!(await isCurrentActorActive(context, db))) return "none";
  if (!isResourceBoundToMailbox(context, mailboxId)) return "none";
  const [mailbox] = await db<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
      FROM mail.mailboxes
      WHERE id = ${mailboxId}::uuid
        AND (${includeDeleted} OR deleted_at IS NULL)
    ) AS exists
  `;
  if (mailbox?.exists !== true) return "none";

  const [row] = await db<{ permission: PermissionLevel }[]>`
      SELECT a.permission
      FROM mail.mailbox_access ma
      JOIN auth.access a ON a.id = ma.access_id
      WHERE ma.mailbox_id = ${mailboxId}::uuid
        AND ${mailboxAccessPrincipalCondition(context.accessSubject)}
      ORDER BY CASE a.permission
        WHEN 'admin' THEN 3
        WHEN 'write' THEN 2
        WHEN 'read' THEN 1
        ELSE 0
      END DESC
      LIMIT 1
  `;
  const permission = row?.permission ?? "none";

  return capByCredentialScopes(context, permission);
};

export const requireMailboxLifecycleAdmin = async (
  context: MailRequestContext,
  mailboxId: string,
  db: SqlClient = sql,
): Promise<Result<"admin">> => {
  const permission = await getMailboxPermissionForLifecycle(context, mailboxId, true, db);
  if (permission === "admin") return ok("admin");
  if (capByCredentialScopes(context, "admin") === "admin" && (await isCurrentPlatformAdmin(context))) return ok("admin");
  return fail(err.forbidden("Access denied"));
};

export const requireMailboxPermission = async (
  context: MailRequestContext,
  mailboxId: string,
  required: Exclude<PermissionLevel, "none">,
  db: SqlClient = sql,
): Promise<Result<PermissionLevel>> => {
  const permission = await getMailboxPermission(context, mailboxId, db);
  return hasPermission(permission, required) ? ok(permission) : fail(err.forbidden("Access denied"));
};

type AccessAuthority = "mailbox_admin" | "platform_admin";

const authorizeAccessManagement = async (
  context: MailRequestContext,
  mailboxId: string,
  authority: AccessAuthority,
  db: SqlClient = sql,
): Promise<Result<void>> => {
  if (authority === "mailbox_admin") {
    const allowed = await requireMailboxPermission(context, mailboxId, "admin", db);
    return allowed.ok ? ok() : fail(allowed.error);
  }
  return (await isCurrentPlatformAdmin(context)) ? ok() : fail(err.forbidden("Cloud administration access is required"));
};

const listMailboxAccessWithAuthority = async (
  context: MailRequestContext,
  mailboxId: string,
  authority: AccessAuthority,
): Promise<Result<AccessEntry[]>> => {
  const allowed = await authorizeAccessManagement(context, mailboxId, authority);
  if (!allowed.ok) return allowed;

  const rows = await sql<DbAccess[]>`
    SELECT a.id, a.user_id, a.group_id, a.service_account_id, a.authenticated_only, a.permission, a.created_at
    FROM mail.mailbox_access ma
    JOIN auth.access a ON a.id = ma.access_id
    WHERE ma.mailbox_id = ${mailboxId}::uuid
    ORDER BY CASE a.permission
      WHEN 'admin' THEN 3
      WHEN 'write' THEN 2
      WHEN 'read' THEN 1
      ELSE 0
    END DESC, a.created_at, a.id
  `;
  return ok(await resolveDisplayNames(rows.map(mapAccess)));
};

const grantMailboxAccessWithAuthority = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  principal: Principal;
  permission: Exclude<PermissionLevel, "none">;
  authority: AccessAuthority;
}): Promise<Result<AccessEntry>> => {
  const principalResult = assertShareablePrincipal(params.principal);
  if (!principalResult.ok) return principalResult;

  return tryCatch(
    async () => {
      const created = await sql.begin(async (tx) => {
        if (!(await lockMailbox(params.mailboxId, tx))) unwrap(fail(err.notFound("Mailbox")));
        unwrap(await authorizeAccessManagement(params.context, params.mailboxId, params.authority, tx));
        if (await getPrincipalGrant(params.mailboxId, params.principal, tx)) unwrap(fail(err.conflict("Mailbox access")));

        const created = unwrap(await createAccess({ principal: params.principal, permission: params.permission }, tx));
        await tx`
          INSERT INTO mail.mailbox_access (mailbox_id, access_id)
          VALUES (${params.mailboxId}::uuid, ${created.id}::uuid)
        `;
        await audit.record(
          {
            action: "mail.mailbox.access.grant",
            outcome: "allowed",
            actor: auditActorFromRequest(params.context),
            target: { type: "mailbox", id: params.mailboxId },
            requestId: params.context.requestId,
            metadata: {
              accessId: created.id,
              principal: params.principal,
              permission: params.permission,
              authority: params.authority,
            },
          },
          tx,
        );

        const [row] = await tx<DbAccess[]>`
          SELECT id, user_id, group_id, service_account_id, authenticated_only, permission, created_at
          FROM auth.access
          WHERE id = ${created.id}::uuid
        `;
        if (!row) throw new Error("Created access entry could not be loaded");
        return mapAccess(row);
      });
      const [resolved] = await resolveDisplayNames([created]);
      if (!resolved) throw new Error("Created access entry could not be resolved");
      return resolved;
    },
    () => err.internal("Failed to grant mailbox access"),
  );
};

const lockAccessEntries = async (mailboxId: string, db: SqlClient): Promise<DbAccess[]> =>
  db<DbAccess[]>`
    SELECT a.id, a.user_id, a.group_id, a.service_account_id, a.authenticated_only, a.permission, a.created_at
    FROM mail.mailbox_access ma
    JOIN auth.access a ON a.id = ma.access_id
    WHERE ma.mailbox_id = ${mailboxId}::uuid
    ORDER BY a.id
    FOR UPDATE OF a
  `;

const ensureAdminRemains = (entries: DbAccess[], accessId: string, nextPermission: PermissionLevel | null): Result<void> => {
  const current = entries.find((entry) => entry.id === accessId);
  if (!current) return fail(err.notFound("Mailbox access"));
  if (current.permission !== "admin" || nextPermission === "admin") return ok();
  if (entries.some((entry) => entry.id !== accessId && entry.permission === "admin")) return ok();
  return fail(err.badInput("A mailbox must keep at least one administrator"));
};

const updateMailboxAccessWithAuthority = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  accessId: string;
  permission: Exclude<PermissionLevel, "none">;
  authority: AccessAuthority;
}): Promise<Result<void>> =>
  tryCatch(
    () =>
      sql.begin(async (tx) => {
        if (!(await lockMailbox(params.mailboxId, tx))) unwrap(fail(err.notFound("Mailbox")));
        unwrap(await authorizeAccessManagement(params.context, params.mailboxId, params.authority, tx));
        const entries = await lockAccessEntries(params.mailboxId, tx);
        unwrap(ensureAdminRemains(entries, params.accessId, params.permission));
        unwrap(await updateAccess({ id: params.accessId, permission: params.permission }, tx));
        await audit.record(
          {
            action: "mail.mailbox.access.update",
            outcome: "allowed",
            actor: auditActorFromRequest(params.context),
            target: { type: "mailbox", id: params.mailboxId },
            requestId: params.context.requestId,
            metadata: { accessId: params.accessId, permission: params.permission, authority: params.authority },
          },
          tx,
        );
      }),
    () => err.internal("Failed to update mailbox access"),
  );

const revokeMailboxAccessWithAuthority = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  accessId: string;
  authority: AccessAuthority;
}): Promise<Result<void>> =>
  tryCatch(
    () =>
      sql.begin(async (tx) => {
        if (!(await lockMailbox(params.mailboxId, tx))) unwrap(fail(err.notFound("Mailbox")));
        unwrap(await authorizeAccessManagement(params.context, params.mailboxId, params.authority, tx));
        const entries = await lockAccessEntries(params.mailboxId, tx);
        unwrap(ensureAdminRemains(entries, params.accessId, null));
        await tx`
          DELETE FROM mail.mailbox_access
          WHERE mailbox_id = ${params.mailboxId}::uuid AND access_id = ${params.accessId}::uuid
        `;
        unwrap(await deleteAccess({ id: params.accessId }, tx));
        await audit.record(
          {
            action: "mail.mailbox.access.revoke",
            outcome: "allowed",
            actor: auditActorFromRequest(params.context),
            target: { type: "mailbox", id: params.mailboxId },
            requestId: params.context.requestId,
            metadata: { accessId: params.accessId, authority: params.authority },
          },
          tx,
        );
      }),
    () => err.internal("Failed to revoke mailbox access"),
  );

export const listMailboxAccess = (context: MailRequestContext, mailboxId: string): Promise<Result<AccessEntry[]>> =>
  listMailboxAccessWithAuthority(context, mailboxId, "mailbox_admin");

export const listMailboxAccessAsPlatformAdmin = (context: MailRequestContext, mailboxId: string): Promise<Result<AccessEntry[]>> =>
  listMailboxAccessWithAuthority(context, mailboxId, "platform_admin");

export const grantMailboxAccess = (params: {
  context: MailRequestContext;
  mailboxId: string;
  principal: Principal;
  permission: Exclude<PermissionLevel, "none">;
}): Promise<Result<AccessEntry>> => grantMailboxAccessWithAuthority({ ...params, authority: "mailbox_admin" });

export const grantMailboxAccessAsPlatformAdmin = (params: {
  context: MailRequestContext;
  mailboxId: string;
  principal: Principal;
  permission: Exclude<PermissionLevel, "none">;
}): Promise<Result<AccessEntry>> => grantMailboxAccessWithAuthority({ ...params, authority: "platform_admin" });

export const updateMailboxAccess = (params: {
  context: MailRequestContext;
  mailboxId: string;
  accessId: string;
  permission: Exclude<PermissionLevel, "none">;
}): Promise<Result<void>> => updateMailboxAccessWithAuthority({ ...params, authority: "mailbox_admin" });

export const updateMailboxAccessAsPlatformAdmin = (params: {
  context: MailRequestContext;
  mailboxId: string;
  accessId: string;
  permission: Exclude<PermissionLevel, "none">;
}): Promise<Result<void>> => updateMailboxAccessWithAuthority({ ...params, authority: "platform_admin" });

export const revokeMailboxAccess = (params: { context: MailRequestContext; mailboxId: string; accessId: string }): Promise<Result<void>> =>
  revokeMailboxAccessWithAuthority({ ...params, authority: "mailbox_admin" });

export const revokeMailboxAccessAsPlatformAdmin = (params: {
  context: MailRequestContext;
  mailboxId: string;
  accessId: string;
}): Promise<Result<void>> => revokeMailboxAccessWithAuthority({ ...params, authority: "platform_admin" });
