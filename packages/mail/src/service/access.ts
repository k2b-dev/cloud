import {
  type AccessEntry,
  type AccessSubject,
  buildAccessPrincipalCondition,
  createAccess,
  deleteAccess,
  getEffectivePermissions,
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
  scope: MailboxAccessScope;
};

/**
 * Where a mailbox grant applies: `mailbox` covers every conversation, `assigned` only the
 * conversations assigned to the person. Assigned grants live in `mail.mailbox_assigned_access`
 * and allow read or write; they never manage the mailbox.
 */
export type MailboxAccessScope = "mailbox" | "assigned";

/** A mailbox grant as the access API returns it; `scope` is present only for an assigned-only grant. */
export type MailboxAccessEntry = AccessEntry & { scope?: "assigned" };

const principalFromRow = (row: DbAccess): Principal => {
  if (row.user_id) return { type: "user", userId: row.user_id };
  if (row.group_id) return { type: "group", groupId: row.group_id };
  if (row.service_account_id) return { type: "service_account", serviceAccountId: row.service_account_id };
  if (row.authenticated_only) return { type: "authenticated" };
  return { type: "public" };
};

const mapAccess = (row: DbAccess): MailboxAccessEntry => ({
  id: row.id,
  principal: principalFromRow(row),
  permission: row.permission,
  createdAt: (row.created_at instanceof Date ? row.created_at : new Date(row.created_at)).toISOString(),
  ...(row.scope === "assigned" ? { scope: "assigned" as const } : {}),
});

const assertShareablePrincipal = (principal: Principal): Result<void> => {
  if (principal.type === "user" || principal.type === "group" || principal.type === "service_account") return ok();
  return fail(err.badInput("Mailboxes can be shared only with users, groups, or service accounts"));
};

/** Assigned-only access follows conversations assigned to people, so only people and groups can hold it. */
const assertGrantShape = (principal: Principal, permission: Exclude<PermissionLevel, "none">, scope: MailboxAccessScope): Result<void> => {
  const shareable = assertShareablePrincipal(principal);
  if (!shareable.ok || scope === "mailbox") return shareable;
  if (principal.type !== "user" && principal.type !== "group") {
    return fail(err.badInput("Access to assigned conversations can be given only to people and groups"));
  }
  if (permission === "admin") return fail(err.badInput("Access to assigned conversations allows read or write, not administration"));
  return ok();
};

/** Both grant tables of one mailbox, each row with the scope it applies to. */
const accessRows = (mailboxId: string) => sql`
  SELECT ma.access_id, 'mailbox'::text AS scope
  FROM mail.mailbox_access ma
  WHERE ma.mailbox_id = ${mailboxId}::uuid
  UNION ALL
  SELECT assigned.access_id, 'assigned'::text AS scope
  FROM mail.mailbox_assigned_access assigned
  WHERE assigned.mailbox_id = ${mailboxId}::uuid
`;

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
  // The reload only confirms the role is still current. It never adds one the request lacks:
  // the mobile app's session, also through an invocation, carries no administrator role.
  if (!user?.roles.includes("admin")) return false;
  const currentUser = await loadCurrentUser({ id: user.id });
  return currentUser?.roles.includes("admin") === true && !accounts.model.isAccountExpired(currentUser.accountExpires);
};

const principalColumnMatch = (principal: Principal) => {
  if (principal.type === "user") return sql`a.user_id = ${principal.userId}::uuid`;
  if (principal.type === "group") return sql`a.group_id = ${principal.groupId}::uuid`;
  if (principal.type === "service_account") return sql`a.service_account_id = ${principal.serviceAccountId}::uuid`;
  return null;
};

/** The principal's grant on the mailbox in either scope; a principal holds at most one. */
const getPrincipalGrant = async (mailboxId: string, principal: Principal, db: SqlClient): Promise<DbAccess | null> => {
  const match = principalColumnMatch(principal);
  if (!match) return null;
  const [row] = await db<DbAccess[]>`
    SELECT a.id, a.user_id, a.group_id, a.service_account_id, a.authenticated_only, a.permission, a.created_at, grants.scope
    FROM (${accessRows(mailboxId)}) grants
    JOIN auth.access a ON a.id = grants.access_id
    WHERE ${match}
    LIMIT 1
  `;
  return row ?? null;
};

/**
 * The request's mailbox-wide permission. A grant that covers only assigned conversations counts as
 * `none` here, so every path that does not ask for conversation-level access refuses such people.
 */
export const getMailboxPermission = async (context: MailRequestContext, mailboxId: string, db: SqlClient = sql): Promise<PermissionLevel> =>
  (await resolveMailboxGrants(context, mailboxId, false, db)).mailbox;

const PERMISSION_ORDER = sql`
  CASE a.permission
    WHEN 'admin' THEN 3
    WHEN 'write' THEN 2
    WHEN 'read' THEN 1
    ELSE 0
  END DESC
`;

/** The request's strongest grant in each scope, capped by its credential like every Mail permission. */
const resolveMailboxGrants = async (
  context: MailRequestContext,
  mailboxId: string,
  includeDeleted: boolean,
  db: SqlClient,
): Promise<{ mailbox: PermissionLevel; assigned: PermissionLevel }> => {
  const none = { mailbox: "none", assigned: "none" } as const;
  if (!(await isCurrentActorActive(context, db))) return none;
  if (!isResourceBoundToMailbox(context, mailboxId)) return none;
  const [mailbox] = await db<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
      FROM mail.mailboxes
      WHERE id = ${mailboxId}::uuid
        AND (${includeDeleted} OR deleted_at IS NULL)
    ) AS exists
  `;
  if (mailbox?.exists !== true) return none;

  const [full] = await db<{ permission: PermissionLevel }[]>`
    SELECT a.permission
    FROM mail.mailbox_access ma
    JOIN auth.access a ON a.id = ma.access_id
    WHERE ma.mailbox_id = ${mailboxId}::uuid
      AND ${mailboxAccessPrincipalCondition(context.accessSubject)}
    ORDER BY ${PERMISSION_ORDER}
    LIMIT 1
  `;
  const [assigned] = await db<{ permission: PermissionLevel }[]>`
    SELECT a.permission
    FROM mail.mailbox_assigned_access assigned
    JOIN auth.access a ON a.id = assigned.access_id
    WHERE assigned.mailbox_id = ${mailboxId}::uuid
      AND ${mailboxAccessPrincipalCondition(context.accessSubject)}
    ORDER BY ${PERMISSION_ORDER}
    LIMIT 1
  `;
  return {
    mailbox: capByCredentialScopes(context, full?.permission ?? "none"),
    assigned: capByCredentialScopes(context, assignedPermission(assigned?.permission ?? "none")),
  };
};

/** An assigned-only grant never administers the mailbox, whatever the row says. */
const assignedPermission = (permission: PermissionLevel): PermissionLevel => (permission === "admin" ? "write" : permission);

/**
 * What a request may see in one mailbox: every conversation (`mailbox`), or only the conversations
 * assigned to its person (`assigned`). A mailbox-wide grant wins over an assigned-only one.
 */
export type MailboxAccess =
  | { scope: "mailbox"; permission: Exclude<PermissionLevel, "none"> }
  | { scope: "assigned"; permission: "read" | "write"; userId: string };

/** The person whose assignments an assigned-only grant follows: the request's user, also behind a personal API key. */
const assignedAccessUserId = (context: Pick<MailRequestContext, "accessSubject">): string | null =>
  context.accessSubject.type === "user" ? context.accessSubject.userId : null;

const accessFromGrants = (
  context: Pick<MailRequestContext, "accessSubject">,
  grants: { mailbox: PermissionLevel; assigned: PermissionLevel },
): MailboxAccess | null => {
  if (grants.mailbox !== "none") return { scope: "mailbox", permission: grants.mailbox };
  const userId = assignedAccessUserId(context);
  if (!userId || (grants.assigned !== "read" && grants.assigned !== "write")) return null;
  return { scope: "assigned", permission: grants.assigned, userId };
};

export const getMailboxAccess = async (
  context: MailRequestContext,
  mailboxId: string,
  db: SqlClient = sql,
): Promise<MailboxAccess | null> => accessFromGrants(context, await resolveMailboxGrants(context, mailboxId, false, db));

/**
 * Requires `required` on the mailbox for a path that applies conversation visibility: it accepts an
 * assigned-only grant too. Callers must then restrict every conversation, message, draft and count
 * they read or change with `conversationVisibleTo()` or `requireVisibleConversation()`.
 */
export const requireMailboxAccess = async (
  context: MailRequestContext,
  mailboxId: string,
  required: "read" | "write",
  db: SqlClient = sql,
): Promise<Result<MailboxAccess>> => {
  const access = await getMailboxAccess(context, mailboxId, db);
  return access && hasPermission(access.permission, required) ? ok(access) : fail(err.forbidden("Access denied"));
};

/** Whether conversation `conversationId` (a SQL expression) is visible with `access`. */
export const conversationVisibleTo = (access: MailboxAccess, conversationId: Bun.SQL.Query<unknown>) =>
  access.scope === "mailbox"
    ? sql`true`
    : sql`EXISTS (
        SELECT 1
        FROM mail.conversation_assignees visible_assignee
        WHERE visible_assignee.conversation_id = ${conversationId}
          AND visible_assignee.user_id = ${access.userId}::uuid
      )`;

/** Whether message `messageId` (a SQL expression) belongs to a conversation visible with `access`. */
export const messageVisibleTo = (access: MailboxAccess, messageId: Bun.SQL.Query<unknown>) =>
  access.scope === "mailbox"
    ? sql`true`
    : sql`EXISTS (
        SELECT 1
        FROM mail.conversation_messages visible_link
        JOIN mail.conversation_assignees visible_assignee ON visible_assignee.conversation_id = visible_link.conversation_id
        WHERE visible_link.message_id = ${messageId}
          AND visible_assignee.user_id = ${access.userId}::uuid
      )`;

/**
 * Refuses a conversation the request cannot see as not found, so an assigned-only reader learns
 * nothing about the others. Mailbox-wide access passes without a query.
 */
export const requireVisibleConversation = async (
  access: MailboxAccess,
  conversationId: string,
  db: SqlClient = sql,
): Promise<Result<void>> => {
  if (access.scope === "mailbox") return ok();
  const [row] = await db<{ visible: boolean }[]>`
    SELECT ${conversationVisibleTo(access, sql`${conversationId}::uuid`)} AS visible
  `;
  return row?.visible === true ? ok() : fail(err.notFound("Conversation"));
};

/** Like `requireVisibleConversation()`, for messages; every message must lie in a visible conversation. */
export const requireVisibleMessages = async (
  access: MailboxAccess,
  messageIds: readonly string[],
  db: SqlClient = sql,
): Promise<Result<void>> => {
  if (access.scope === "mailbox" || messageIds.length === 0) return ok();
  const ids = [...new Set(messageIds)];
  const [row] = await db<{ visible: number }[]>`
    SELECT COUNT(*)::int AS visible
    FROM jsonb_array_elements_text(${ids}::jsonb) requested(id)
    WHERE ${messageVisibleTo(access, sql`requested.id::uuid`)}
  `;
  return row?.visible === ids.length ? ok() : fail(err.notFound("Message"));
};

/**
 * The access of each reader on one mailbox, by the grant, binding and scope rules of
 * `getMailboxAccess()`, with one query per scope for all of their grants. The live channel decides
 * with it. It leaves out whether each account is still active: the live socket checks every
 * credential again every 10 seconds.
 */
export const getMailboxAccesses = async (
  mailboxId: string,
  readers: readonly MailRequestContext[],
): Promise<Array<MailboxAccess | null>> => {
  const rows = await sql<{ access_id: string; scope: MailboxAccessScope }[]>`
    SELECT grants.access_id, grants.scope
    FROM (${accessRows(mailboxId)}) grants
    JOIN mail.mailboxes m ON m.id = ${mailboxId}::uuid AND m.deleted_at IS NULL
  `;
  const subjects = readers.map((reader) => reader.accessSubject);
  const [mailboxGranted, assignedGranted] = await Promise.all(
    (["mailbox", "assigned"] as const).map((scope) =>
      getEffectivePermissions({ accessIds: rows.filter((row) => row.scope === scope).map((row) => row.access_id), subjects }),
    ),
  );
  return readers.map((reader, position) =>
    isResourceBoundToMailbox(reader, mailboxId)
      ? accessFromGrants(reader, {
          mailbox: capByCredentialScopes(reader, mailboxGranted?.[position] ?? "none"),
          assigned: capByCredentialScopes(reader, assignedPermission(assignedGranted?.[position] ?? "none")),
        })
      : null,
  );
};

export const requireMailboxLifecycleAdmin = async (
  context: MailRequestContext,
  mailboxId: string,
  db: SqlClient = sql,
): Promise<Result<"admin">> => {
  const permission = (await resolveMailboxGrants(context, mailboxId, true, db)).mailbox;
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

/** Every grant on the mailbox in both scopes with display names, managers first. Callers authorize before they read it. */
export const loadMailboxAccessEntries = async (mailboxId: string): Promise<MailboxAccessEntry[]> => {
  const rows = await sql<DbAccess[]>`
    SELECT a.id, a.user_id, a.group_id, a.service_account_id, a.authenticated_only, a.permission, a.created_at, grants.scope
    FROM (${accessRows(mailboxId)}) grants
    JOIN auth.access a ON a.id = grants.access_id
    ORDER BY (grants.scope = 'assigned'), ${PERMISSION_ORDER}, a.created_at, a.id
  `;
  return resolveDisplayNames(rows.map(mapAccess));
};

const listMailboxAccessWithAuthority = async (
  context: MailRequestContext,
  mailboxId: string,
  authority: AccessAuthority,
): Promise<Result<MailboxAccessEntry[]>> => {
  const allowed = await authorizeAccessManagement(context, mailboxId, authority);
  if (!allowed.ok) return allowed;
  return ok(await loadMailboxAccessEntries(mailboxId));
};

const insertGrantLink = async (db: SqlClient, mailboxId: string, accessId: string, scope: MailboxAccessScope): Promise<void> => {
  if (scope === "assigned") {
    await db`INSERT INTO mail.mailbox_assigned_access (mailbox_id, access_id) VALUES (${mailboxId}::uuid, ${accessId}::uuid)`;
  } else {
    await db`INSERT INTO mail.mailbox_access (mailbox_id, access_id) VALUES (${mailboxId}::uuid, ${accessId}::uuid)`;
  }
};

const deleteGrantLinks = async (db: SqlClient, mailboxId: string, accessId: string): Promise<void> => {
  await db`DELETE FROM mail.mailbox_access WHERE mailbox_id = ${mailboxId}::uuid AND access_id = ${accessId}::uuid`;
  await db`DELETE FROM mail.mailbox_assigned_access WHERE mailbox_id = ${mailboxId}::uuid AND access_id = ${accessId}::uuid`;
};

const grantMailboxAccessWithAuthority = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  principal: Principal;
  permission: Exclude<PermissionLevel, "none">;
  scope?: MailboxAccessScope;
  authority: AccessAuthority;
}): Promise<Result<MailboxAccessEntry>> => {
  const scope = params.scope ?? "mailbox";
  const shape = assertGrantShape(params.principal, params.permission, scope);
  if (!shape.ok) return shape;

  return tryCatch(
    async () => {
      const created = await sql.begin(async (tx) => {
        if (!(await lockMailbox(params.mailboxId, tx))) unwrap(fail(err.notFound("Mailbox")));
        unwrap(await authorizeAccessManagement(params.context, params.mailboxId, params.authority, tx));
        if (await getPrincipalGrant(params.mailboxId, params.principal, tx)) unwrap(fail(err.conflict("Mailbox access")));

        const created = unwrap(await createAccess({ principal: params.principal, permission: params.permission }, tx));
        await insertGrantLink(tx, params.mailboxId, created.id, scope);
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
              scope,
              authority: params.authority,
            },
          },
          tx,
        );

        const [row] = await tx<DbAccess[]>`
          SELECT id, user_id, group_id, service_account_id, authenticated_only, permission, created_at, ${scope}::text AS scope
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
    SELECT a.id, a.user_id, a.group_id, a.service_account_id, a.authenticated_only, a.permission, a.created_at, grants.scope
    FROM (${accessRows(mailboxId)}) grants
    JOIN auth.access a ON a.id = grants.access_id
    ORDER BY a.id
    FOR UPDATE OF a
  `;

/** Only a mailbox-wide `admin` manages the mailbox; an assigned-only grant never does. */
const ensureAdminRemains = (
  entries: DbAccess[],
  accessId: string,
  next: { permission: PermissionLevel; scope: MailboxAccessScope } | null,
): Result<void> => {
  const current = entries.find((entry) => entry.id === accessId);
  if (!current) return fail(err.notFound("Mailbox access"));
  const manages = (entry: { permission: PermissionLevel; scope: MailboxAccessScope }) =>
    entry.permission === "admin" && entry.scope === "mailbox";
  if (!manages(current) || (next && manages(next))) return ok();
  if (entries.some((entry) => entry.id !== accessId && manages(entry))) return ok();
  return fail(err.badInput("A mailbox must keep at least one administrator"));
};

const updateMailboxAccessWithAuthority = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  accessId: string;
  permission: Exclude<PermissionLevel, "none">;
  /** The scope after the change; omitted keeps the grant's current scope. */
  scope?: MailboxAccessScope;
  authority: AccessAuthority;
}): Promise<Result<void>> =>
  tryCatch(
    () =>
      sql.begin(async (tx) => {
        if (!(await lockMailbox(params.mailboxId, tx))) unwrap(fail(err.notFound("Mailbox")));
        unwrap(await authorizeAccessManagement(params.context, params.mailboxId, params.authority, tx));
        const entries = await lockAccessEntries(params.mailboxId, tx);
        const current = entries.find((entry) => entry.id === params.accessId);
        if (!current) unwrap(fail(err.notFound("Mailbox access")));
        const scope = params.scope ?? current!.scope;
        unwrap(assertGrantShape(principalFromRow(current!), params.permission, scope));
        unwrap(ensureAdminRemains(entries, params.accessId, { permission: params.permission, scope }));
        unwrap(await updateAccess({ id: params.accessId, permission: params.permission }, tx));
        if (scope !== current!.scope) {
          await deleteGrantLinks(tx, params.mailboxId, params.accessId);
          await insertGrantLink(tx, params.mailboxId, params.accessId, scope);
        }
        await audit.record(
          {
            action: "mail.mailbox.access.update",
            outcome: "allowed",
            actor: auditActorFromRequest(params.context),
            target: { type: "mailbox", id: params.mailboxId },
            requestId: params.context.requestId,
            metadata: { accessId: params.accessId, permission: params.permission, scope, authority: params.authority },
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
        await deleteGrantLinks(tx, params.mailboxId, params.accessId);
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

export const listMailboxAccess = (context: MailRequestContext, mailboxId: string): Promise<Result<MailboxAccessEntry[]>> =>
  listMailboxAccessWithAuthority(context, mailboxId, "mailbox_admin");

export const listMailboxAccessAsPlatformAdmin = (context: MailRequestContext, mailboxId: string): Promise<Result<MailboxAccessEntry[]>> =>
  listMailboxAccessWithAuthority(context, mailboxId, "platform_admin");

type GrantParams = {
  context: MailRequestContext;
  mailboxId: string;
  principal: Principal;
  permission: Exclude<PermissionLevel, "none">;
  scope?: MailboxAccessScope;
};

type UpdateParams = {
  context: MailRequestContext;
  mailboxId: string;
  accessId: string;
  permission: Exclude<PermissionLevel, "none">;
  scope?: MailboxAccessScope;
};

export const grantMailboxAccess = (params: GrantParams): Promise<Result<MailboxAccessEntry>> =>
  grantMailboxAccessWithAuthority({ ...params, authority: "mailbox_admin" });

export const grantMailboxAccessAsPlatformAdmin = (params: GrantParams): Promise<Result<MailboxAccessEntry>> =>
  grantMailboxAccessWithAuthority({ ...params, authority: "platform_admin" });

export const updateMailboxAccess = (params: UpdateParams): Promise<Result<void>> =>
  updateMailboxAccessWithAuthority({ ...params, authority: "mailbox_admin" });

export const updateMailboxAccessAsPlatformAdmin = (params: UpdateParams): Promise<Result<void>> =>
  updateMailboxAccessWithAuthority({ ...params, authority: "platform_admin" });

export const revokeMailboxAccess = (params: { context: MailRequestContext; mailboxId: string; accessId: string }): Promise<Result<void>> =>
  revokeMailboxAccessWithAuthority({ ...params, authority: "mailbox_admin" });

export const revokeMailboxAccessAsPlatformAdmin = (params: {
  context: MailRequestContext;
  mailboxId: string;
  accessId: string;
}): Promise<Result<void>> => revokeMailboxAccessWithAuthority({ ...params, authority: "platform_admin" });
