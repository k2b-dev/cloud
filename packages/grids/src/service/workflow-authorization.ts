import type { User } from "@valentinkolb/cloud/contracts";
import type { AccessSubject, PermissionLevel } from "@valentinkolb/cloud/server";
import {
  accounts,
  type ServiceAccount,
  type ServiceAccountCredentialOverview,
  serviceAccountCredentials,
  serviceAccounts,
} from "@valentinkolb/cloud/services";
import { sql } from "bun";
import type { GridsWorkflowCredential, GridsWorkflowCredentialBinding, GridsWorkflowPrincipal } from "../workflows/contracts";
import {
  hasAtLeast,
  loadBaseGrantsForSubject,
  minPermission,
  permissionFromCredentialScopes,
  resolveEffectivePermission,
} from "./permission-resolver";

type SqlClient = typeof sql;
type WorkflowAuthorizationUser = Pick<User, "id" | "accountExpires">;
type WorkflowAuthorizationServiceAccount = Pick<
  ServiceAccount,
  "id" | "kind" | "status" | "delegatedUserId" | "appId" | "resourceType" | "resourceId"
>;
type WorkflowAuthorizationCredential = Pick<ServiceAccountCredentialOverview, "id" | "status" | "scopes" | "expiresAt"> & {
  serviceAccount: Pick<ServiceAccountCredentialOverview["serviceAccount"], "id" | "status">;
};

export const workflowCredentialBinding = (
  serviceAccount: Pick<ServiceAccount, "kind" | "appId" | "resourceType" | "resourceId">,
): GridsWorkflowCredentialBinding | null => {
  if (serviceAccount.kind !== "resource_bound") return null;
  if (!serviceAccount.appId || !serviceAccount.resourceType || !serviceAccount.resourceId) return null;
  return {
    appId: serviceAccount.appId,
    resourceType: serviceAccount.resourceType,
    resourceId: serviceAccount.resourceId,
  };
};

const sameBinding = (left: GridsWorkflowCredentialBinding | null, right: GridsWorkflowCredentialBinding | null): boolean =>
  left === null
    ? right === null
    : right !== null && left.appId === right.appId && left.resourceType === right.resourceType && left.resourceId === right.resourceId;

const expired = (value: string | null | undefined, now: Date): boolean => Boolean(value && Date.parse(value) <= now.getTime());

export type WorkflowAuthorizationRevalidation =
  | {
      ok: true;
      subject: AccessSubject;
      permissionCap: PermissionLevel;
      credential: GridsWorkflowCredential | null;
    }
  | { ok: false; reason: string };

export type WorkflowAuthorizationDeps = {
  findCredential(id: string, serviceAccountId: string): Promise<WorkflowAuthorizationCredential | null>;
  getServiceAccount(id: string): Promise<WorkflowAuthorizationServiceAccount | null>;
  getUser(id: string): Promise<WorkflowAuthorizationUser | null>;
  now(): Date;
};

const findCredential = (id: string, _serviceAccountId: string): Promise<ServiceAccountCredentialOverview | null> =>
  serviceAccountCredentials.getOverview({ id });

const defaultDeps: WorkflowAuthorizationDeps = {
  findCredential,
  getServiceAccount: (id) => serviceAccounts.get({ id }),
  getUser: (id) => accounts.users.get({ id }),
  now: () => new Date(),
};

const databaseDeps = async (db: SqlClient): Promise<WorkflowAuthorizationDeps> => {
  const [clock] = await db<{ now: Date }[]>`SELECT now() AS now`;
  if (!clock) throw new Error("Database clock is unavailable for workflow authorization");
  return {
    now: () => clock.now,
    getUser: async (id) => {
      const [row] = await db<{ id: string; account_expires: Date | null }[]>`
        SELECT id::text, account_expires
        FROM auth.users
        WHERE id = ${id}::uuid
      `;
      return row ? { id: row.id, accountExpires: row.account_expires?.toISOString() ?? null } : null;
    },
    getServiceAccount: async (id) => {
      const [row] = await db<
        Array<{
          id: string;
          kind: WorkflowAuthorizationServiceAccount["kind"];
          status: WorkflowAuthorizationServiceAccount["status"];
          delegated_user_id: string | null;
          app_id: string | null;
          resource_type: string | null;
          resource_id: string | null;
        }>
      >`
        SELECT id::text, kind, status, delegated_user_id::text, app_id, resource_type, resource_id
        FROM auth.service_accounts
        WHERE id = ${id}::uuid
      `;
      return row
        ? {
            id: row.id,
            kind: row.kind,
            status: row.status,
            delegatedUserId: row.delegated_user_id,
            appId: row.app_id,
            resourceType: row.resource_type,
            resourceId: row.resource_id,
          }
        : null;
    },
    findCredential: async (id, serviceAccountId) => {
      const [row] = await db<
        Array<{
          id: string;
          status: WorkflowAuthorizationCredential["status"];
          scopes: string[];
          expires_at: Date | null;
          service_account_id: string;
          service_account_status: WorkflowAuthorizationCredential["serviceAccount"]["status"];
        }>
      >`
        SELECT credential.id::text,
               credential.status,
               credential.scopes,
               credential.expires_at,
               account.id::text AS service_account_id,
               account.status AS service_account_status
        FROM auth.service_account_credentials credential
        JOIN auth.service_accounts account ON account.id = credential.service_account_id
        WHERE credential.id = ${id}::uuid
          AND credential.service_account_id = ${serviceAccountId}::uuid
      `;
      return row
        ? {
            id: row.id,
            status: row.status,
            scopes: row.scopes,
            expiresAt: row.expires_at?.toISOString() ?? null,
            serviceAccount: { id: row.service_account_id, status: row.service_account_status },
          }
        : null;
    },
  };
};

const subjectFor = (principal: GridsWorkflowPrincipal, actorServiceAccountId: string | null): AccessSubject | null => {
  if (principal.userId && !principal.serviceAccountId) {
    return {
      type: "user",
      userId: principal.userId,
      ...(actorServiceAccountId ? { delegatedByServiceAccountId: actorServiceAccountId } : {}),
    };
  }
  if (!principal.userId && principal.serviceAccountId) {
    return { type: "service_account", serviceAccountId: principal.serviceAccountId };
  }
  return null;
};

export const revalidateWorkflowPrincipal = async (
  principal: GridsWorkflowPrincipal,
  baseId: string,
  deps: WorkflowAuthorizationDeps = defaultDeps,
): Promise<WorkflowAuthorizationRevalidation> => {
  const actorServiceAccountId = principal.actorServiceAccountId ?? null;
  const acceptedCredential = principal.credential ?? null;
  const subject = subjectFor(principal, actorServiceAccountId);
  if (!subject) return { ok: false, reason: "Workflow principal is invalid." };

  const now = deps.now();
  if (subject.type === "user") {
    const user = await deps.getUser(subject.userId);
    if (!user || expired(user.accountExpires, now)) return { ok: false, reason: "Workflow user is inactive." };
  }

  if (!actorServiceAccountId && !acceptedCredential) {
    if (subject.type !== "user") return { ok: false, reason: "Service-account workflows require credential provenance." };
    return { ok: true, subject, permissionCap: "admin", credential: null };
  }
  if (!actorServiceAccountId || !acceptedCredential) {
    return { ok: false, reason: "Workflow credential provenance is incomplete." };
  }

  const serviceAccount = await deps.getServiceAccount(actorServiceAccountId);
  if (!serviceAccount || serviceAccount.status !== "active") {
    return { ok: false, reason: "Workflow service account is inactive." };
  }
  if (
    (serviceAccount.kind === "user_delegated" && (subject.type !== "user" || serviceAccount.delegatedUserId !== subject.userId)) ||
    (serviceAccount.kind === "resource_bound" && (subject.type !== "service_account" || serviceAccount.id !== subject.serviceAccountId))
  ) {
    return { ok: false, reason: "Workflow service-account subject changed." };
  }

  const currentBinding = workflowCredentialBinding(serviceAccount);
  if (!sameBinding(acceptedCredential.resourceBinding, currentBinding)) {
    return { ok: false, reason: "Workflow credential resource binding changed." };
  }
  if (
    currentBinding &&
    (currentBinding.appId !== "grids" || currentBinding.resourceType !== "base" || currentBinding.resourceId !== baseId)
  ) {
    return { ok: false, reason: "Workflow credential is not bound to this Grids base." };
  }

  if (expired(acceptedCredential.expiresAt, now)) return { ok: false, reason: "Workflow credential expired." };

  if (acceptedCredential.kind === "oauth") {
    if (acceptedCredential.id !== null || !acceptedCredential.expiresAt) {
      return { ok: false, reason: "Workflow OAuth credential provenance is invalid." };
    }
    return {
      ok: true,
      subject,
      permissionCap: minPermission(acceptedCredential.permissionCap, permissionFromCredentialScopes(acceptedCredential.scopes)),
      credential: acceptedCredential,
    };
  }

  if (!acceptedCredential.id) return { ok: false, reason: "Workflow API credential id is missing." };
  const current = await deps.findCredential(acceptedCredential.id, actorServiceAccountId);
  if (
    !current ||
    current.status !== "active" ||
    current.serviceAccount.id !== actorServiceAccountId ||
    current.serviceAccount.status !== "active"
  ) {
    return { ok: false, reason: "Workflow API credential is revoked or inactive." };
  }
  if (expired(current.expiresAt, now)) return { ok: false, reason: "Workflow API credential expired." };
  const currentCredential: GridsWorkflowCredential = {
    kind: "api_token",
    id: current.id,
    scopes: current.scopes,
    permissionCap: minPermission(acceptedCredential.permissionCap, permissionFromCredentialScopes(current.scopes)),
    expiresAt: current.expiresAt,
    resourceBinding: currentBinding,
  };
  return { ok: true, subject, permissionCap: currentCredential.permissionCap, credential: currentCredential };
};

export const revalidateWorkflowPrincipalInTransaction = async (
  principal: GridsWorkflowPrincipal,
  baseId: string,
  db: SqlClient,
): Promise<WorkflowAuthorizationRevalidation> => revalidateWorkflowPrincipal(principal, baseId, await databaseDeps(db));

export const authorizeWorkflowBase = async (
  principal: GridsWorkflowPrincipal,
  baseId: string,
  required: PermissionLevel,
  db?: SqlClient,
): Promise<boolean> => {
  const revalidated = db
    ? await revalidateWorkflowPrincipalInTransaction(principal, baseId, db)
    : await revalidateWorkflowPrincipal(principal, baseId);
  if (!revalidated.ok || !hasAtLeast(revalidated.permissionCap, required)) return false;
  const grants = await loadBaseGrantsForSubject({ subject: revalidated.subject, baseId }, db);
  return hasAtLeast(resolveEffectivePermission(grants, { baseId }), required);
};

const tableBelongsToBase = async (baseId: string, tableId: string, db: SqlClient = sql): Promise<boolean> => {
  const [row] = await db<Array<{ found: boolean }>>`
    SELECT TRUE AS found
    FROM grids.tables t
    JOIN grids.bases b ON b.id = t.base_id AND b.deleted_at IS NULL
    WHERE t.id = ${tableId}::uuid
      AND t.base_id = ${baseId}::uuid
      AND t.deleted_at IS NULL
  `;
  return row?.found === true;
};

export const canAccessWorkflowBaseTable = async (
  principal: GridsWorkflowPrincipal,
  target: { baseId: string; tableId: string },
  required: PermissionLevel,
  db?: SqlClient,
): Promise<boolean> => {
  if (!(await tableBelongsToBase(target.baseId, target.tableId, db))) return false;
  return authorizeWorkflowBase(principal, target.baseId, required, db);
};

export const workflowTableBelongsToBase = tableBelongsToBase;
