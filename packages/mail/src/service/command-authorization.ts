import type { AccessSubject } from "@k2b/cloud/server";
import { toPgTextArray } from "@k2b/cloud/services";
import { sql } from "bun";
import { conversationVisibleTo, type MailboxAccess, mailboxAccessPrincipalCondition, messageVisibleTo } from "./access";

type SqlClient = typeof sql;

export type StoredCommandAuthorization = {
  kind: string;
  target: Record<string, unknown> | string;
  mailbox_id: string;
  actor_kind: "user" | "service_account" | "workflow" | "system";
  actor_id: string | null;
  initiator_actor_kind: "user" | "service_account" | null;
  initiator_actor_id: string | null;
  access_subject_kind: "user" | "service_account" | "system";
  access_subject_id: string | null;
  credential_scopes: string[] | null;
  credential_id: string | null;
  credential_expires_at: Date | string | null;
};

/** Only these command kinds have a conversation target; all others remain mailbox-wide. */
export const conversationCommandKinds: ReadonlySet<string> = new Set([
  "set_flags",
  "change_message_state",
  "move",
  "copy",
  "delete",
  "send",
]);

export const commandTargetVisibleTo = (
  access: MailboxAccess,
  kind: Bun.SQL.Query<unknown>,
  target: Bun.SQL.Query<unknown>,
  mailboxId: string,
) =>
  access.scope === "mailbox"
    ? sql`true`
    : sql`(
  (${kind} IN ('set_flags', 'change_message_state', 'move', 'copy', 'delete') AND EXISTS (
    SELECT 1 FROM mail.remote_message_refs command_ref
    JOIN mail.folders command_folder ON command_folder.id = command_ref.folder_id
    JOIN mail.remote_resources command_resource ON command_resource.id = command_folder.remote_resource_id
    WHERE command_ref.id::text = (${target})->>'remoteMessageRefId'
      AND command_resource.mailbox_id = ${mailboxId}::uuid
      AND ${messageVisibleTo(access, sql`command_ref.message_id`)}
  )) OR (${kind} = 'send' AND EXISTS (
    SELECT 1 FROM mail.drafts command_draft
    WHERE command_draft.id::text = (${target})->>'draftId'
      AND command_draft.mailbox_id = ${mailboxId}::uuid
      AND command_draft.origin = 'user'
      AND ${conversationVisibleTo(access, sql`command_draft.conversation_id`)}
  ))
)`;

/** An assigned person sees only their own commands, while the current target remains visible. */
export const commandVisibleTo = (access: MailboxAccess, mailboxId: string) =>
  access.scope === "mailbox"
    ? sql`true`
    : sql`(
  c.access_subject_kind = 'user' AND c.access_subject_id = ${access.userId}::uuid
  AND c.actor_kind IN ('user', 'service_account')
  AND ${commandTargetVisibleTo(access, sql`c.kind`, sql`c.target`, mailboxId)}
)`;

const permissionRank = (permission: string | null | undefined): number => {
  if (permission === "admin") return 3;
  if (permission === "write") return 2;
  if (permission === "read") return 1;
  return 0;
};

const requiredRank = (permission: "write" | "admin"): number => (permission === "admin" ? 3 : 2);

const scopeRank = (scopes: readonly string[]): number => {
  if (scopes.includes("admin") || scopes.includes("mail:admin") || scopes.includes("mail:*")) return 3;
  if (scopes.includes("write") || scopes.includes("mail:write")) return 2;
  if (scopes.includes("read") || scopes.includes("mail:read")) return 1;
  return 0;
};

const serviceAccountActorAllowed = async (
  command: StoredCommandAuthorization,
  permission: "write" | "admin",
  db: SqlClient,
): Promise<boolean> => {
  const actorKind = command.initiator_actor_kind ?? command.actor_kind;
  const actorId = command.initiator_actor_id ?? command.actor_id;
  if (actorKind !== "service_account") return true;
  if (!actorId) return false;
  // Service work without a stored credential fails closed before any database lookup.
  if (!command.credential_id) {
    const expiresAt = command.credential_expires_at ? new Date(command.credential_expires_at).getTime() : Number.NaN;
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return false;
  }
  const [serviceAccount] = await db<
    {
      status: string;
      kind: string;
      app_id: string | null;
      resource_type: string | null;
      resource_id: string | null;
    }[]
  >`
    SELECT status, kind, app_id, resource_type, resource_id
    FROM auth.service_accounts
    WHERE id = ${actorId}::uuid
  `;
  if (!serviceAccount || serviceAccount.status !== "active") return false;
  // A personal API key acts as its user and is minted without scopes, the same exemption the
  // request applied when it accepted the command; the user's mailbox grant decides below.
  if (serviceAccount.kind !== "user_delegated" && scopeRank(command.credential_scopes ?? []) < requiredRank(permission)) return false;
  if (command.credential_id) {
    const [credential] = await db<{ active: boolean }[]>`
      SELECT EXISTS (
        SELECT 1
        FROM auth.service_account_credentials credential
        WHERE credential.id = ${command.credential_id}::uuid
          AND credential.service_account_id = ${actorId}::uuid
          AND credential.status = 'active'
          AND credential.revoked_at IS NULL
          AND (credential.expires_at IS NULL OR credential.expires_at > now())
          AND credential.scopes @> ${toPgTextArray(command.credential_scopes ?? [])}::text[]
          AND credential.scopes <@ ${toPgTextArray(command.credential_scopes ?? [])}::text[]
      ) AS active
    `;
    if (credential?.active !== true) return false;
  }
  if (serviceAccount.kind !== "resource_bound") return true;
  return (
    serviceAccount.app_id === "mail" && serviceAccount.resource_type === "mailbox" && serviceAccount.resource_id === command.mailbox_id
  );
};

const accessSubjectIsActive = async (command: StoredCommandAuthorization, db: SqlClient): Promise<boolean> => {
  if (!command.access_subject_id) return false;
  if (command.access_subject_kind === "user") {
    const [user] = await db<{ active: boolean }[]>`
      SELECT (account_expires IS NULL OR account_expires > now()) AS active
      FROM auth.users
      WHERE id = ${command.access_subject_id}::uuid
    `;
    return user?.active === true;
  }
  const [serviceAccount] = await db<{ status: string }[]>`
    SELECT status FROM auth.service_accounts WHERE id = ${command.access_subject_id}::uuid
  `;
  return serviceAccount?.status === "active";
};

const loadMailboxGrant = async (command: StoredCommandAuthorization, db: SqlClient): Promise<string | null> => {
  // A stored command without a subject id matches nothing but a public grant,
  // which is what a null subject already means to the shared predicate.
  const subject: AccessSubject | null = !command.access_subject_id
    ? null
    : command.access_subject_kind === "user"
      ? { type: "user", userId: command.access_subject_id }
      : { type: "service_account", serviceAccountId: command.access_subject_id };
  const [grant] = await db<{ permission: string }[]>`
    SELECT a.permission
    FROM mail.mailbox_access ma
    JOIN auth.access a ON a.id = ma.access_id
    WHERE ma.mailbox_id = ${command.mailbox_id}::uuid
      AND ${mailboxAccessPrincipalCondition(subject)}
    ORDER BY CASE a.permission
      WHEN 'admin' THEN 3
      WHEN 'write' THEN 2
      WHEN 'read' THEN 1
      ELSE 0
    END DESC
    LIMIT 1
  `;
  return grant?.permission ?? null;
};

export const commandStillAuthorized = async (
  command: StoredCommandAuthorization,
  permission: "write" | "admin",
  db: SqlClient = sql,
): Promise<boolean> => {
  if (command.access_subject_kind === "system") {
    if (command.actor_kind === "system") return true;
    if (command.actor_kind !== "workflow" || !command.actor_id) return false;
    const [workflow] = await db<{ authorized: boolean }[]>`
      SELECT EXISTS (
        SELECT 1
        FROM workflows.version version
        JOIN workflows.workflow workflow
          ON workflow.id = version.workflow_id
         AND workflow.active_version_id = version.id
        JOIN mail.workflow_profile profile
          ON profile.id = workflow.id
         AND profile.enabled
        WHERE profile.mailbox_id = ${command.mailbox_id}::uuid
          AND version.id = ${command.actor_id}::uuid
      ) AS authorized
    `;
    return workflow?.authorized === true;
  }
  if (!(await serviceAccountActorAllowed(command, permission, db))) return false;
  if (!(await accessSubjectIsActive(command, db))) return false;
  if (permissionRank(await loadMailboxGrant(command, db)) >= requiredRank(permission)) return true;
  if (
    permission !== "write" ||
    command.access_subject_kind !== "user" ||
    !command.access_subject_id ||
    !command.kind ||
    !conversationCommandKinds.has(command.kind) ||
    !command.target ||
    (command.actor_kind !== "user" && command.actor_kind !== "service_account")
  )
    return false;
  const subject: AccessSubject = { type: "user", userId: command.access_subject_id };
  const [grant] = await db<{ authorized: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM mail.mailbox_assigned_access assigned
      JOIN auth.access a ON a.id = assigned.access_id
      JOIN mail.mailboxes mailbox ON mailbox.id = assigned.mailbox_id AND mailbox.deleted_at IS NULL
      WHERE assigned.mailbox_id = ${command.mailbox_id}::uuid
        AND a.permission IN ('write', 'admin')
        AND ${mailboxAccessPrincipalCondition(subject)}
    ) AND ${commandTargetVisibleTo({ scope: "assigned", permission: "write", userId: command.access_subject_id }, sql`${command.kind}`, sql`${typeof command.target === "string" ? JSON.parse(command.target) : command.target}::jsonb`, command.mailbox_id)} AS authorized
  `;
  return grant?.authorized === true;
};
