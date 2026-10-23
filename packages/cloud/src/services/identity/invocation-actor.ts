import { sql } from "bun";
import type { RequestActor } from "../../server/middleware/auth";
import type { AccessSubject } from "../../server/services/access";
import { isAccountCategoryAllowed } from "../account-category-policy";
import { isAccountExpired } from "../account-model";
import { isServiceAccountOAuthAuthorityCurrent } from "../oauth-tokens";
import type { ServiceAccount } from "../service-accounts";
import { buildProjectedUser, loadCurrentUser, userProjectionJoin, userProjectionSql, withoutAdminRole } from "../session/user";
import type { CloudInvocationClaims } from "./invocation-token";
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
  | "session_kind"
  | "scopes"
  | "credential_id"
  | "oauth_client_id"
  | "credential_expires_at"
  | "exp"
  | "act"
  | "credential_kind"
  | "jti"
  | "request_id"
  | "mandate_id"
  | "mandate_revision"
  | "workload_type"
  | "workload_id"
>;

const provenance = (claims: InvocationPrincipalClaims): NonNullable<RequestActor["delegation"]> => ({
  kind: "invocation",
  callingAppId: claims.act.sub.slice("app:".length),
  credentialKind: claims.credential_kind,
  invocationId: claims.jti,
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
  const groupsAdmin = groupsAdminOverride ?? (await getIdentityRuntimeConfig()).groupsAdmin;
  const delegation = provenance(claims);

  if (claims.principal_type === "user") {
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

  const actor: Extract<RequestActor, { kind: "service_account" }> = {
    kind: "service_account",
    serviceAccount,
    delegatedUser,
    scopes: [...claims.scopes],
    credentialId: claims.credential_id ?? null,
    oauthClientId: claims.oauth_client_id ?? null,
    credentialExpiresAt: new Date(
      Math.min(claims.exp * 1_000, claims.credential_expires_at ? Date.parse(claims.credential_expires_at) : Infinity),
    ).toISOString(),
    delegation,
  };
  if (
    claims.oauth_client_id &&
    !(await isServiceAccountOAuthAuthorityCurrent(
      {
        serviceAccountId: serviceAccount.id,
        clientId: claims.oauth_client_id,
        expiresAt: actor.credentialExpiresAt,
      },
      { query, groupsAdmin },
    ))
  )
    return null;
  const accessSubject: AccessSubject = delegatedUser
    ? { type: "user", userId: delegatedUser.id, delegatedByServiceAccountId: serviceAccount.id }
    : { type: "service_account", serviceAccountId: serviceAccount.id };
  return { actor, accessSubject, credentialKind: "invocation", scopes: [...claims.scopes] };
};
