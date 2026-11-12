import { sql } from "@k2b/cloud";
import type { OAuthAuthorityStatement } from "@k2b/cloud/contracts";
import { isAccountCategoryAllowed, toPgTextArray } from "@k2b/cloud/services";
import type { OAuthUserGrantReference } from "./token-authority";

export type OAuthTokenRequest =
  | { kind: "user_access" | "user_id"; grant: OAuthUserGrantReference; expiresIn: number }
  | { kind: "service_access"; authority: GrantRow; expiresIn: number };

type AuthorityState = {
  terminalLoginId?: string;
  terminalConfirmed?: boolean;
  familyId?: string;
  authEpoch: number;
  clientId: string;
  clientScopes: string[];
  clientAudiences: string[];
  clientServiceAccountId: string | null;
  registrationKind: string;
  allowedProfiles: string[];
  accessMode: string;
  specificAccess: boolean;
  grantedScopes: string[];
  grantedAudiences: string[];
  resource: string | null;
  nonce: string | null;
  notAfter: Date | null;
  user: null | {
    id: string;
    profile: string;
    accountExpires: Date | null;
  };
  serviceAccount: null | {
    id: string;
    kind: string;
    status: string;
    delegatedUserId: string | null;
    appId: string | null;
    resourceType: string | null;
    resourceId: string | null;
  };
};

type AuthorityRow = {
  client_id: string;
  client_scopes: string[];
  client_audiences: string[];
  client_service_account_id: string | null;
  registration_kind: string;
  allowed_profiles: string[];
  access_mode: string;
  specific_access: boolean;
  user_id: string | null;
  profile: string | null;
  provider: "local" | "ipa" | null;
  account_expires: Date | null;
  service_account_id: string | null;
  service_account_kind: string | null;
  service_account_status: string | null;
  delegated_user_id: string | null;
  app_id: string | null;
  resource_type: string | null;
  resource_id: string | null;
};

type GrantRow = {
  app_approval?: boolean;
  grant_expires_at?: Date;
  confirmed_at?: Date | null;
  login_lifetime_seconds?: number | null;
  family_expires_at: Date | null;
  client_id: string;
  user_id: string | null;
  scopes: string[];
  audiences: string[];
  resource: string | null;
  nonce: string | null;
};

const resolveAuthorityState = async (params: { request: OAuthTokenRequest; db?: typeof sql }): Promise<AuthorityState | null> => {
  const db = params.db ?? sql;
  let grant: GrantRow | null = null;
  let authEpoch = 0;
  let terminalConfirmed = false;
  let terminalLoginId: string | undefined;
  if (params.request.kind === "service_access") {
    grant = params.request.authority;
  } else {
    // Lock user -> grant -> family, the order of account deletion and sign-out everywhere. FOR SHARE keeps the
    // epoch still and allows the key-share lock that a concurrent device decision's user foreign key takes.
    const userGrant = params.request.grant;
    const [owner] =
      userGrant.kind === "authorization_code"
        ? await db<{ user_id: string }[]>`
            SELECT user_id FROM oauth.codes WHERE code = ${userGrant.code}`
        : userGrant.kind === "device_code"
          ? await db<{ user_id: string }[]>`
            SELECT user_id FROM oauth.device_authorizations
            WHERE id = ${userGrant.deviceAuthorizationId}::uuid`
          : await db<{ user_id: string }[]>`
            SELECT family.user_id FROM oauth.refresh_tokens token
            JOIN oauth.refresh_token_families family ON family.id = token.family_id
            WHERE token.id = ${userGrant.tokenId}::uuid`;
    if (!owner?.user_id) return null;
    const [user] = await db<{ auth_epoch: string | number | bigint }[]>`
      SELECT auth_epoch FROM auth.users WHERE id = ${owner.user_id}::uuid FOR SHARE
    `;
    if (!user) return null;
    authEpoch = Number(user.auth_epoch);
    if (!Number.isSafeInteger(authEpoch) || authEpoch < 0) return null;
    if (params.request.grant.kind === "authorization_code") {
      const [row] = await db<GrantRow[]>`
        UPDATE oauth.codes
        SET authority_issued_at = now()
        WHERE code = ${params.request.grant.code}
          AND used = true
          AND authority_issued_at IS NULL
          AND expires_at >= now()
          AND user_id = ${owner.user_id}::uuid
          AND auth_epoch = ${authEpoch}::bigint
        RETURNING client_id, user_id, scopes, audiences, resource, nonce, confirmed_at, NULL::timestamptz AS family_expires_at
      `;
      grant = row ?? null;
    } else if (params.request.grant.kind === "device_code") {
      // Only a consumed authorization of a client that still allows the device grant can mint tokens.
      const [row] = await db<GrantRow[]>`
        UPDATE oauth.device_authorizations device
        SET authority_issued_at = now()
        FROM oauth.clients client
        WHERE device.id = ${params.request.grant.deviceAuthorizationId}::uuid
          AND device.status = 'consumed'
          AND device.authority_issued_at IS NULL
          AND device.expires_at > now()
          AND client.client_id = device.client_id
          AND client.is_public
          AND client.allow_device_grant
          AND device.user_id = ${owner.user_id}::uuid
          AND device.auth_epoch = ${authEpoch}::bigint
        RETURNING device.client_id, device.user_id, device.scopes, device.audiences, device.confirmed_at, device.login_lifetime_seconds, device.app_approval, device.expires_at AS grant_expires_at, NULL::text AS resource, NULL::text AS nonce, NULL::timestamptz AS family_expires_at
      `;
      grant = row ?? null;
      if (grant) {
        // Keep the approval until this boundary, even after the sign-in UI expires.
        const [login] = await db<
          { id: string; issuer: string; user_id: string | null; approved_by: string | null; auth_epoch: string | null; bound: boolean }[]
        >`
          SELECT id,issuer,user_id,approved_by,auth_epoch,
            (state='approved' AND client_id=${grant.client_id} AND user_id=${grant.user_id}::uuid
              AND scopes @> ${toPgTextArray(grant.scopes)}::text[] AND scopes <@ ${toPgTextArray(grant.scopes)}::text[]
              AND lifetime_seconds=${grant.login_lifetime_seconds ?? null}::integer
              AND oauth_grant_expires_at=date_trunc('milliseconds',${grant.grant_expires_at ?? null}::timestamptz)
              AND oauth_grant_expires_at > now()) AS bound
          FROM auth.app_logins
          WHERE device_authorization_id=${params.request.grant.deviceAuthorizationId}::uuid AND kind='terminal' AND oauth_issuer_app_id='oauth' `;
        if (login) {
          if (!login.bound || login.user_id !== grant.user_id || Number(login.auth_epoch) !== authEpoch) return null;
          terminalConfirmed = true;
          terminalLoginId = login.id;
        } else if (grant.app_approval) return null;
      }
    } else {
      const [row] = await db<GrantRow[]>`
        UPDATE oauth.refresh_tokens token
        SET authority_issued_at = now()
        FROM oauth.refresh_token_families family
        WHERE token.id = ${params.request.grant.tokenId}::uuid
          AND token.status = 'issuing'
          AND token.authority_issued_at IS NULL
          AND token.expires_at > now()
          AND family.id = token.family_id
          AND family.status = 'active'
          AND family.expires_at > now()
          AND family.user_id = ${owner.user_id}::uuid
          AND family.auth_epoch = ${authEpoch}::bigint
        RETURNING family.client_id, family.user_id, token.authority_scopes AS scopes,
          token.authority_audiences AS audiences, token.authority_resource AS resource, NULL::text AS nonce, family.expires_at AS family_expires_at
      `;
      grant = row ?? null;
    }
    if (!grant) return null;
    if (userGrant.kind !== "refresh_token") {
      // A lasting grant requires its reserved family and recorded browser or terminal confirmation.
      const familyId = userGrant.familyId;
      if (grant.scopes.includes("offline_access") !== (familyId !== undefined)) return null;
      if (familyId !== undefined) {
        if (!grant.confirmed_at && !terminalConfirmed) return null;
        const [family] = await db<{ id: string; expires_at: Date; created_at: Date }[]>`
          SELECT id, expires_at, created_at FROM oauth.refresh_token_families
          WHERE id = ${familyId}::uuid AND status = 'reserved'
            AND client_id = ${grant.client_id} AND user_id = ${owner.user_id}::uuid
            AND auth_epoch = ${authEpoch}::bigint AND expires_at > now()
            AND (${grant.login_lifetime_seconds ?? null}::integer IS NULL
              OR expires_at <= now() + ${grant.login_lifetime_seconds ?? null}::integer * interval '1 second')
          FOR UPDATE
        `;
        if (!family) return null;
        grant.family_expires_at = family.expires_at;
      }
    }
  }
  const clientId = grant?.client_id ?? null;
  if (!clientId) return null;
  const grantUserId = grant?.user_id ?? null;
  const [row] = await db<AuthorityRow[]>`
    WITH RECURSIVE user_all_groups AS (
      SELECT ug.group_id, g.provider
      FROM auth.user_groups_v2 ug
      JOIN auth.groups g ON g.id = ug.group_id
      WHERE ug.user_id = ${grantUserId}::uuid
      UNION
      SELECT gg.parent_group_id, parent.provider
      FROM auth.group_groups_v2 gg
      JOIN auth.groups parent ON parent.id = gg.parent_group_id
      JOIN user_all_groups child ON child.group_id = gg.child_group_id
      WHERE parent.provider = child.provider
    )
    SELECT c.client_id, c.scopes AS client_scopes, c.audiences AS client_audiences, c.service_account_id AS client_service_account_id,
      c.registration_kind, c.allowed_profiles, c.access_mode,
      (
        EXISTS (SELECT 1 FROM oauth.client_access_users cau WHERE cau.client_id = c.id AND cau.user_id = u.id)
        OR EXISTS (SELECT 1 FROM oauth.client_access_groups cag JOIN user_all_groups ug ON ug.group_id = cag.group_id WHERE cag.client_id = c.id)
      ) AS specific_access,
      u.id AS user_id, u.profile, u.provider, u.account_expires,
      sa.id AS service_account_id, sa.kind AS service_account_kind, sa.status AS service_account_status,
      sa.delegated_user_id, sa.app_id, sa.resource_type, sa.resource_id
    FROM oauth.clients c
    LEFT JOIN auth.users u ON u.id = ${grantUserId}::uuid
    LEFT JOIN auth.service_accounts sa ON sa.id = c.service_account_id
    WHERE c.client_id = ${clientId}
    LIMIT 1
  `;
  if (!row) return null;
  if (
    row.user_id !== null &&
    (!row.provider ||
      (row.profile !== "guest" && row.profile !== "user") ||
      !(await isAccountCategoryAllowed({ provider: row.provider, profile: row.profile }, db)))
  )
    return null;
  if (row.user_id !== null && row.profile === null) return null;
  if (row.service_account_id !== null && (row.service_account_kind === null || row.service_account_status === null)) return null;
  const resolvedUserId = row.user_id;
  const profile = row.profile;
  const serviceAccountId = row.service_account_id;
  const serviceAccountKind = row.service_account_kind;
  const serviceAccountStatus = row.service_account_status;
  return {
    terminalLoginId,
    terminalConfirmed,
    familyId:
      params.request.kind !== "service_access" && params.request.grant.kind !== "refresh_token" ? params.request.grant.familyId : undefined,
    authEpoch,
    clientId: row.client_id,
    clientScopes: row.client_scopes,
    clientAudiences: row.client_audiences,
    clientServiceAccountId: row.client_service_account_id,
    registrationKind: row.registration_kind,
    allowedProfiles: row.allowed_profiles,
    accessMode: row.access_mode,
    specificAccess: row.specific_access,
    grantedScopes: grant?.scopes ?? row.client_scopes,
    grantedAudiences: grant?.audiences ?? [],
    resource: grant?.resource ?? null,
    nonce: grant?.nonce ?? null,
    notAfter: grant?.family_expires_at ?? null,
    user:
      resolvedUserId !== null && profile !== null
        ? {
            id: resolvedUserId,
            profile,
            accountExpires: row.account_expires,
          }
        : null,
    serviceAccount:
      serviceAccountId !== null && serviceAccountKind !== null && serviceAccountStatus !== null
        ? {
            id: serviceAccountId,
            kind: serviceAccountKind,
            status: serviceAccountStatus,
            delegatedUserId: row.delegated_user_id,
            appId: row.app_id,
            resourceType: row.resource_type,
            resourceId: row.resource_id,
          }
        : null,
  };
};

const resolveAudiences = (state: AuthorityState, issuer: string): string[] | null => {
  const resource = state.resource;
  const granted = Array.from(new Set(state.grantedAudiences));
  if (granted.length === 0) return null;
  if (state.registrationKind === "dynamic") {
    if (!resource || granted.length !== 1 || granted[0] !== resource) return null;
    try {
      return new URL(resource).origin === new URL(issuer).origin ? granted : null;
    } catch {
      return null;
    }
  }
  if (resource) return granted.length === 1 && granted[0] === resource && state.clientAudiences.includes(resource) ? granted : null;
  const currentlyAllowed = new Set(["cloud", state.clientId, ...state.clientAudiences]);
  return granted.every((audience) => currentlyAllowed.has(audience)) ? granted : null;
};

const validateAuthority = (requests: OAuthTokenRequest[], state: AuthorityState, issuer: string, now: number): boolean => {
  const first = requests[0];
  if (!first) return false;
  if (first.kind === "service_access") {
    if (requests.length !== 1 || !state.serviceAccount || state.user) return false;
    const account = state.serviceAccount;
    const resourceBound =
      account.kind === "resource_bound" && account.appId !== null && account.resourceType !== null && account.resourceId !== null;
    const standalone =
      (account.kind === "standalone" || account.kind === "agent") &&
      account.appId === null &&
      account.resourceType === null &&
      account.resourceId === null;
    return (
      state.clientServiceAccountId === account.id &&
      account.status === "active" &&
      account.delegatedUserId === null &&
      // The driver will use serviceAccountMayHoldCredentials from feat/code here too.
      account.resourceType !== "cloud.app" &&
      (resourceBound || standalone) &&
      state.grantedScopes.every((scope) => state.clientScopes.includes(scope)) &&
      resolveAudiences(state, issuer) !== null
    );
  }
  const userRequests = requests.filter((request) => request.kind !== "service_access");
  const accessRequests = userRequests.filter((request) => request.kind === "user_access");
  const idTokenRequests = userRequests.filter((request) => request.kind === "user_id");
  const access = accessRequests[0];
  const idToken = idTokenRequests[0];
  if (
    !access ||
    accessRequests.length !== 1 ||
    idTokenRequests.length > 1 ||
    (idTokenRequests.length === 1 && !state.grantedScopes.includes("openid")) ||
    !state.user ||
    state.serviceAccount ||
    userRequests.length !== requests.length
  ) {
    return false;
  }
  if (idToken && JSON.stringify(idToken.grant) !== JSON.stringify(access.grant)) return false;
  const user = state.user;
  return (
    (!user.accountExpires || user.accountExpires.getTime() > now * 1_000) &&
    state.allowedProfiles.includes(user.profile) &&
    (state.accessMode === "profiles" || (state.accessMode === "specific" && state.specificAccess)) &&
    state.grantedScopes.every((scope) => state.clientScopes.includes(scope)) &&
    resolveAudiences(state, issuer) !== null
  );
};

export class InvalidIssuerAuthorityError extends Error {}

/** Commit the reservation before sending to Core; never hold issuer locks across HTTP. */
export const stageOAuthAuthority = async (requests: OAuthTokenRequest[], issuer: string, loginExpiresAt: Date | null) =>
  sql.begin(async (db) => {
    const first = requests[0];
    if (!first) throw new InvalidIssuerAuthorityError();
    const state = await resolveAuthorityState({ request: first, db });
    if (!state || !validateAuthority(requests, state, issuer, Math.floor(Date.now() / 1000))) throw new InvalidIssuerAuthorityError();
    let subject: OAuthAuthorityStatement["subject"];
    if (state.user) subject = { kind: "user", userId: state.user.id, authEpoch: state.authEpoch };
    else if (state.serviceAccount) subject = { kind: "service_account", serviceAccountId: state.serviceAccount.id };
    else throw new InvalidIssuerAuthorityError();
    const statement: OAuthAuthorityStatement = {
      clientId: state.clientId,
      subject,
      scopes: Array.from(new Set(state.grantedScopes)),
      audiences: Array.from(new Set(state.grantedAudiences)),
      resource: state.resource,
      nonce: state.nonce,
      loginExpiresAt: (state.notAfter ?? loginExpiresAt)?.toISOString() ?? null,
      terminalLoginId: state.terminalLoginId ?? null,
      tokens: requests.map(({ kind, expiresIn }) => ({ kind, expiresIn })),
    };
    return { statement, familyId: state.familyId, terminalConfirmed: state.terminalConfirmed };
  });

/** A definitive response proves that Core did not return any signatures. No transport failure reaches here. */
export const releaseOAuthAuthority = async (grant: OAuthUserGrantReference): Promise<void> => {
  if (grant.kind === "authorization_code") {
    await sql`UPDATE oauth.codes SET used=false,authority_issued_at=NULL
      WHERE code=${grant.code} AND used=true`;
  } else if (grant.kind === "device_code") {
    await sql`UPDATE oauth.device_authorizations SET status='approved',authority_issued_at=NULL
      WHERE id=${grant.deviceAuthorizationId}::uuid AND status='consumed'`;
  } else {
    await sql`UPDATE oauth.refresh_tokens SET status='active',authority_reserved_at=NULL,authority_issued_at=NULL,
      authority_scopes=NULL,authority_audiences=NULL,authority_resource=NULL
      WHERE id=${grant.tokenId}::uuid AND status='issuing'`;
  }
};

/** Activate a new family only after Core's transaction committed and returned its signatures. */
export const finalizeOAuthAuthority = async (staged: Awaited<ReturnType<typeof stageOAuthAuthority>>): Promise<void> => {
  if (!staged.familyId) return;
  const rows = await sql`UPDATE oauth.refresh_token_families
    SET status='active',notified_at=CASE WHEN ${staged.terminalConfirmed ?? false} THEN now() ELSE NULL END
    WHERE id=${staged.familyId}::uuid AND status='reserved' AND expires_at > now() RETURNING id`;
  if (rows.length !== 1) throw new Error("OAuth family reservation could not be activated");
};
