import type { AccessSubject } from "@k2b/cloud/server";
import { toPgTextArray } from "@k2b/cloud/services";
import { sql } from "bun";
import { mailboxAccessPrincipalCondition } from "./access";

type SqlClient = typeof sql;

export type StoredCommandAuthorization = {
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
  if (!actorId || scopeRank(command.credential_scopes ?? []) < requiredRank(permission)) return false;
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
  } else {
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
  return permissionRank(await loadMailboxGrant(command, db)) >= requiredRank(permission);
};
