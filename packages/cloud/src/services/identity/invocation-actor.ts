import { sql } from "bun";
import type { RequestActor } from "../../server/middleware/auth";
import type { AccessSubject } from "../../server/services/access";
import { isAccountCategoryAllowed } from "../account-category-policy";
import { isAccountExpired } from "../account-model";
import type { ServiceAccount } from "../service-accounts";
import { buildProjectedUser, loadCurrentUser, userProjectionJoin, userProjectionSql, withoutAdminRole } from "../session/user";
import type { CloudInvocationClaims } from "./invocation-token";
import { isNestedSourceCurrent, nestedInvocationLeases } from "./nested-invocation";
import { getIdentityRuntimeConfig } from "./runtime-config";

type ServiceAccountRow = Record<string, unknown> & {
  service_account_id: string;
  service_account_name: string;
  service_account_kind: ServiceAccount["kind"];
  service_account_status: ServiceAccount["status"];
  delegated_user_id: string | null;
  app_id: string | null;
  resource_type: string | null;
  resource_id: string | null;
  service_account_created_by: string | null;
  service_account_created_at: Date | string;
};

export type ResolvedInvocationAuthority = {
  actor: RequestActor;
  accessSubject: AccessSubject;
  credentialKind: "invocation";
  scopes: string[];
};

export type InvocationPrincipalClaims = Pick<
  CloudInvocationClaims,
  | "sub"
  | "principal_type"
  | "access_subject_type"
  | "access_subject_id"
  | "session_kind"
  | "scopes"
  | "credential_id"
  | "exp"
  | "act"
  | "credential_kind"
  | "jti"
  | "request_id"
  | "mandate_id"
  | "mandate_revision"
  | "workload_type"
  | "workload_id"
  | "parent_invocation_id"
>;

const provenance = (claims: InvocationPrincipalClaims): NonNullable<RequestActor["delegation"]> => ({
  kind: "invocation",
  callingAppId: claims.act.sub.slice("app:".length),
  credentialKind: claims.credential_kind,
  invocationId: claims.jti,
  ...(claims.parent_invocation_id ? { parentInvocationId: claims.parent_invocation_id } : {}),
  requestId: claims.request_id ?? null,
  ...(claims.mandate_id
    ? {
        mandateId: claims.mandate_id,
        mandateRevision: claims.mandate_revision,
        workloadType: claims.workload_type,
        workloadId: claims.workload_id,
      }
    : {}),
});

const mapServiceAccount = (row: ServiceAccountRow): ServiceAccount => ({
  id: row.service_account_id,
  name: row.service_account_name,
  kind: row.service_account_kind,
  status: row.service_account_status,
  delegatedUserId: row.delegated_user_id,
  appId: row.app_id,
  resourceType: row.resource_type,
  resourceId: row.resource_id,
  createdBy: row.service_account_created_by,
  createdAt: new Date(row.service_account_created_at).toISOString(),
});

export const resolveInvocationAuthority = async (
  claims: InvocationPrincipalClaims,
  query: typeof sql = sql,
  groupsAdminOverride?: string[],
): Promise<ResolvedInvocationAuthority | null> => {
  if (claims.parent_invocation_id) {
    const lease = await nestedInvocationLeases.read(claims.parent_invocation_id).catch(() => null);
    if (!lease || `app:${lease.appId}` !== claims.act.sub) return null;
    if (lease.proof && !(await isNestedSourceCurrent(lease.proof, claims).catch(() => false))) return null;
    if (claims.mandate_id) {
      // Policy was checked under Core's issuance transaction; admission also
      // checks the parent's current mandate state and subject.
      const [mandate] = await query<{ id: string }[]>`
        SELECT id FROM auth.mandates
        WHERE id = ${claims.mandate_id}::uuid AND revision = ${claims.mandate_revision}
          AND state = 'active' AND confirmed_at IS NOT NULL
          AND (expires_at IS NULL OR expires_at > now())
          AND subject_kind = ${claims.principal_type}
          AND COALESCE(subject_user_id, subject_service_account_id) = ${claims.sub}::uuid
      `;
      if (!mandate) return null;
    }
  }
  const groupsAdmin = groupsAdminOverride ?? (await getIdentityRuntimeConfig()).groupsAdmin;
  const delegation = provenance(claims);

  if (claims.principal_type === "user") {
    if (claims.access_subject_type !== "user" || claims.access_subject_id !== claims.sub) return null;
    const current = await loadCurrentUser({ userId: claims.sub, groupsAdmin }, query);
    if (!current || isAccountExpired(current.accountExpires)) return null;
    if (!(await isAccountCategoryAllowed(current, query))) return null;
    // The mobile app's session never acts as an installation administrator, also not through another app.
    const app = claims.session_kind === "app";
    const user = app ? withoutAdminRole(current) : current;
    return {
      actor: { kind: "user", user, delegation, ...(app ? { sessionKind: "app" as const } : {}) },
      accessSubject: { type: "user", userId: user.id },
      credentialKind: "invocation",
      scopes: [...claims.scopes],
    };
  }

  const rows = await query<ServiceAccountRow[]>`
    SELECT
      sa.id AS service_account_id,
      sa.name AS service_account_name,
      sa.kind AS service_account_kind,
      sa.status AS service_account_status,
      sa.delegated_user_id,
      sa.app_id,
      sa.resource_type,
      sa.resource_id,
      sa.created_by AS service_account_created_by,
      sa.created_at AS service_account_created_at,
      ${userProjectionSql(groupsAdmin)}
    FROM auth.service_accounts sa
    LEFT JOIN auth.users u ON u.id = sa.delegated_user_id
    ${userProjectionJoin()}
    WHERE sa.id = ${claims.sub}::uuid
      AND sa.status = 'active'
  `;
  const row = rows[0];
  if (!row) return null;

  const serviceAccount = mapServiceAccount(row);
  const delegatedUser = serviceAccount.delegatedUserId ? buildProjectedUser(row) : null;
  if (serviceAccount.kind === "user_delegated" && (!delegatedUser || isAccountExpired(delegatedUser.accountExpires))) return null;
  if (delegatedUser && !(await isAccountCategoryAllowed(delegatedUser, query))) return null;

  if (
    claims.access_subject_type !== (delegatedUser ? "user" : "service_account") ||
    claims.access_subject_id !== (delegatedUser?.id ?? serviceAccount.id)
  )
    return null;

  const actor: RequestActor = {
    kind: "service_account",
    serviceAccount,
    delegatedUser,
    scopes: [...claims.scopes],
    credentialId: claims.credential_id ?? null,
    credentialExpiresAt: new Date(claims.exp * 1_000).toISOString(),
    delegation,
  };
  const accessSubject: AccessSubject = delegatedUser
    ? { type: "user", userId: delegatedUser.id, delegatedByServiceAccountId: serviceAccount.id }
    : { type: "service_account", serviceAccountId: serviceAccount.id };
  return { actor, accessSubject, credentialKind: "invocation", scopes: [...claims.scopes] };
};
