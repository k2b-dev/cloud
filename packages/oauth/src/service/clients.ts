import { audit, serviceAccounts, toPgTextArray, toPgUuidArray } from "@k2b/cloud/services";
import { sql } from "bun";
import type {
  CreateOAuthClient,
  MutationResult,
  OAuthAccessGroup,
  OAuthAccessMode,
  OAuthAccessUser,
  OAuthAllowedProfile,
  OAuthClient,
  OAuthClientRegistrationKind,
  OAuthClientWithSecret,
  OAuthScope,
  UpdateOAuthClient,
} from "@/contracts";

// ==========================
// OAuth Clients Service
// ==========================

type DbClient = {
  id: string;
  name: string;
  description: string | null;
  client_id: string;
  client_secret_hash: string | null;
  redirect_uris: string[];
  logout_uri: string | null;
  scopes: string[];
  audiences: string[];
  service_account_id: string | null;
  allowed_profiles: string[];
  access_mode: string;
  registration_kind: string;
  is_public: boolean;
  created_at: Date;
  created_by: string | null;
};

type DbAccessUser = {
  client_id: string;
  id: string;
  uid: string;
  display_name: string;
  mail: string | null;
  provider: "ipa" | "local";
};

type DbAccessGroup = {
  client_id: string;
  id: string;
  provider: "ipa" | "local";
  name: string;
  description: string | null;
};

type AccessPrincipals = {
  users: OAuthAccessUser[];
  groups: OAuthAccessGroup[];
};

type OAuthClientAdminActor = {
  id: string;
  uid: string;
  provider: string;
  roles: readonly string[];
};

/**
 * Maps an OAuth client row to the API-facing client object.
 */
const mapToClient = (row: DbClient, access: AccessPrincipals = { users: [], groups: [] }): OAuthClient => ({
  id: row.id,
  name: row.name,
  description: row.description,
  clientId: row.client_id,
  redirectUris: row.redirect_uris,
  logoutUri: row.logout_uri,
  scopes: row.scopes as OAuthScope[],
  audiences: row.audiences,
  serviceAccountId: row.service_account_id,
  allowedProfiles: row.allowed_profiles as OAuthAllowedProfile[],
  accessMode: row.access_mode === "specific" ? "specific" : "profiles",
  accessUsers: access.users,
  accessGroups: access.groups,
  registrationKind: row.registration_kind as OAuthClientRegistrationKind,
  isPublic: row.is_public,
  createdAt: row.created_at.toISOString(),
  createdBy: row.created_by,
});

const mapAccessUser = (row: DbAccessUser): OAuthAccessUser => ({
  id: row.id,
  uid: row.uid,
  displayName: row.display_name,
  mail: row.mail,
  provider: row.provider,
});

const mapAccessGroup = (row: DbAccessGroup): OAuthAccessGroup => ({
  id: row.id,
  provider: row.provider,
  name: row.name,
  description: row.description,
});

const emptyAccessMap = (clientIds: string[]): Map<string, AccessPrincipals> =>
  new Map(clientIds.map((id) => [id, { users: [], groups: [] }]));

const uniqueIds = (ids: string[]): string[] => Array.from(new Set(ids));

const loadAccessPrincipals = async (clientIds: string[], db: typeof sql = sql): Promise<Map<string, AccessPrincipals>> => {
  const access = emptyAccessMap(clientIds);
  if (clientIds.length === 0) return access;

  const [users, groups] = await Promise.all([
    db<DbAccessUser[]>`
      SELECT cau.client_id, u.id, u.uid, u.display_name, u.mail, u.provider
      FROM oauth.client_access_users cau
      JOIN auth.users u ON u.id = cau.user_id
      WHERE cau.client_id = ANY(${toPgUuidArray(clientIds)}::uuid[])
      ORDER BY u.uid
    `,
    db<DbAccessGroup[]>`
      SELECT cag.client_id, g.id, g.provider, g.name, g.description
      FROM oauth.client_access_groups cag
      JOIN auth.groups g ON g.id = cag.group_id
      WHERE cag.client_id = ANY(${toPgUuidArray(clientIds)}::uuid[])
      ORDER BY g.name
    `,
  ]);

  for (const user of users) access.get(user.client_id)?.users.push(mapAccessUser(user));
  for (const group of groups) access.get(group.client_id)?.groups.push(mapAccessGroup(group));
  return access;
};

const validateAccessSelection = (params: { accessMode: OAuthAccessMode; userIds: string[]; groupIds: string[] }): MutationResult<void> => {
  if (params.accessMode === "specific" && params.userIds.length === 0 && params.groupIds.length === 0) {
    return { ok: false, error: "Select at least one user or group for specific OAuth access", status: 400 };
  }
  return { ok: true, data: undefined };
};

const validateAccessPrincipals = async (params: {
  accessMode: OAuthAccessMode;
  userIds: string[];
  groupIds: string[];
}): Promise<MutationResult<void>> => {
  if (params.accessMode !== "specific") return { ok: true, data: undefined };

  if (params.userIds.length > 0) {
    const [row] = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count
      FROM auth.users
      WHERE id = ANY(${toPgUuidArray(params.userIds)}::uuid[])
    `;
    if (Number(row?.count ?? 0) !== params.userIds.length) {
      return { ok: false, error: "One or more selected users do not exist", status: 400 };
    }
  }

  if (params.groupIds.length > 0) {
    const [row] = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count
      FROM auth.groups
      WHERE id = ANY(${toPgUuidArray(params.groupIds)}::uuid[])
    `;
    if (Number(row?.count ?? 0) !== params.groupIds.length) {
      return { ok: false, error: "One or more selected groups do not exist", status: 400 };
    }
  }

  return { ok: true, data: undefined };
};

const replaceAccessPrincipals = async (params: {
  clientId: string;
  accessMode: OAuthAccessMode;
  userIds: string[];
  groupIds: string[];
  db?: typeof sql;
}): Promise<void> => {
  const db = params.db ?? sql;
  await db`DELETE FROM oauth.client_access_users WHERE client_id = ${params.clientId}::uuid`;
  await db`DELETE FROM oauth.client_access_groups WHERE client_id = ${params.clientId}::uuid`;

  if (params.accessMode !== "specific") return;

  if (params.userIds.length > 0) {
    await db`
      INSERT INTO oauth.client_access_users (client_id, user_id)
      SELECT ${params.clientId}::uuid, unnest(${toPgUuidArray(params.userIds)}::uuid[])
      ON CONFLICT DO NOTHING
    `;
  }

  if (params.groupIds.length > 0) {
    await db`
      INSERT INTO oauth.client_access_groups (client_id, group_id)
      SELECT ${params.clientId}::uuid, unnest(${toPgUuidArray(params.groupIds)}::uuid[])
      ON CONFLICT DO NOTHING
    `;
  }
};

/** List one bounded, filtered OAuth client page directly from PostgreSQL. */
export const list = async (params: { limit: number; offset: number; query?: string }): Promise<{ items: OAuthClient[]; total: number }> => {
  const query = params.query?.trim() || null;
  const [{ total = 0 } = {}] = await sql<{ total: number }[]>`
    SELECT count(*)::int AS total
    FROM oauth.clients
    WHERE ${query}::text IS NULL
      OR position(lower(${query}) in lower(name)) > 0
      OR position(lower(${query}) in lower(client_id)) > 0
      OR position(lower(${query}) in lower(COALESCE(description, ''))) > 0
  `;
  const rows = await sql<DbClient[]>`
    SELECT id, name, description, client_id, redirect_uris, logout_uri, scopes, audiences, service_account_id, allowed_profiles, access_mode, registration_kind, is_public, created_at, created_by
    FROM oauth.clients
    WHERE ${query}::text IS NULL
      OR position(lower(${query}) in lower(name)) > 0
      OR position(lower(${query}) in lower(client_id)) > 0
      OR position(lower(${query}) in lower(COALESCE(description, ''))) > 0
    ORDER BY created_at DESC, id DESC
    LIMIT ${params.limit}
    OFFSET ${params.offset}
  `;
  const access = await loadAccessPrincipals(rows.map((row) => row.id));
  return { items: rows.map((row) => mapToClient(row, access.get(row.id))), total };
};

export const summary = async (): Promise<{ total: number; public: number; dynamic: number }> => {
  const [row] = await sql<{ total: number; public: number; dynamic: number }[]>`
    SELECT
      count(*)::int AS total,
      count(*) FILTER (WHERE is_public)::int AS public,
      count(*) FILTER (WHERE registration_kind = 'dynamic')::int AS dynamic
    FROM oauth.clients
  `;
  return row ?? { total: 0, public: 0, dynamic: 0 };
};

/**
 * Get client by internal ID
 */
export const get = async (params: { id: string; db?: typeof sql }): Promise<OAuthClient | null> => {
  const db = params.db ?? sql;
  const [row] = await db<DbClient[]>`
    SELECT id, name, description, client_id, redirect_uris, logout_uri, scopes, audiences, service_account_id, allowed_profiles, access_mode, registration_kind, is_public, created_at, created_by
    FROM oauth.clients
    WHERE id = ${params.id}
  `;
  if (!row) return null;
  const access = await loadAccessPrincipals([row.id], db);
  return mapToClient(row, access.get(row.id));
};

const getForUpdate = async (params: { id: string; db: typeof sql }): Promise<OAuthClient | null> => {
  const [row] = await params.db<DbClient[]>`
    SELECT id, name, description, client_id, redirect_uris, logout_uri, scopes, audiences, service_account_id, allowed_profiles, access_mode, registration_kind, is_public, created_at, created_by
    FROM oauth.clients
    WHERE id = ${params.id}
    FOR UPDATE
  `;
  if (!row) return null;
  const access = await loadAccessPrincipals([row.id], params.db);
  return mapToClient(row, access.get(row.id));
};

/**
 * Get client by client_id (OAuth identifier)
 */
export const getByClientId = async (params: { clientId: string }): Promise<OAuthClient | null> => {
  const [row] = await sql<DbClient[]>`
    SELECT id, name, description, client_id, redirect_uris, logout_uri, scopes, audiences, service_account_id, allowed_profiles, access_mode, registration_kind, is_public, created_at, created_by
    FROM oauth.clients
    WHERE client_id = ${params.clientId}
  `;
  if (!row) return null;
  const access = await loadAccessPrincipals([row.id]);
  return mapToClient(row, access.get(row.id));
};

/**
 * Create a new OAuth client
 */
export const create = async (params: {
  data: CreateOAuthClient;
  actor: OAuthClientAdminActor;
}): Promise<MutationResult<OAuthClientWithSecret>> => {
  const { data, actor } = params;

  // Generate client secret for confidential clients
  const clientSecret = data.isPublic ? null : crypto.randomUUID() + crypto.randomUUID();
  const clientSecretHash = clientSecret ? await Bun.password.hash(clientSecret) : null;

  const redirectUrisLiteral = toPgTextArray(data.redirectUris);
  const scopesLiteral = toPgTextArray(data.scopes);
  const audiencesLiteral = toPgTextArray(data.audiences);
  const allowedProfilesLiteral = toPgTextArray(data.allowedProfiles);
  const accessMode = data.accessMode;
  const userIds = uniqueIds(data.allowedUserIds);
  const groupIds = uniqueIds(data.allowedGroupIds);
  const accessResult = validateAccessSelection({
    accessMode,
    userIds,
    groupIds,
  });
  if (!accessResult.ok) return accessResult;
  const principalResult = await validateAccessPrincipals({
    accessMode,
    userIds,
    groupIds,
  });
  if (!principalResult.ok) return principalResult;
  const serviceAccountResult = await validateServiceAccountBinding({
    serviceAccountId: data.serviceAccountId ?? null,
    isPublic: data.isPublic,
  });
  if (!serviceAccountResult.ok) return serviceAccountResult;

  return sql.begin(async (tx) => {
    const [row] = await tx<DbClient[]>`
      INSERT INTO oauth.clients (name, description, redirect_uris, logout_uri, scopes, audiences, service_account_id, allowed_profiles, access_mode, is_public, client_secret_hash, created_by)
      VALUES (
        ${data.name},
        ${data.description ?? null},
        ${redirectUrisLiteral}::text[],
        ${data.logoutUri ?? null},
        ${scopesLiteral}::text[],
        ${audiencesLiteral}::text[],
        ${data.serviceAccountId ?? null}::uuid,
        ${allowedProfilesLiteral}::text[],
        ${accessMode},
        ${data.isPublic},
        ${clientSecretHash},
        ${actor.id}
      )
      RETURNING id, name, description, client_id, redirect_uris, logout_uri, scopes, audiences, service_account_id, allowed_profiles, access_mode, registration_kind, is_public, created_at, created_by
    `;

    if (!row) return { ok: false, error: "Failed to create client", status: 500 } as const;

    await replaceAccessPrincipals({ clientId: row.id, accessMode, userIds, groupIds, db: tx });
    const created = await get({ id: row.id, db: tx });
    if (!created) return { ok: false, error: "Failed to load created client", status: 500 } as const;

    await audit.record(
      {
        action: "oauth.client.create",
        outcome: "allowed",
        actor: { userId: actor.id, uid: actor.uid, provider: actor.provider, roles: actor.roles },
        target: { type: "oauth_client", id: created.id, label: created.name },
        metadata: { clientId: created.clientId, isPublic: created.isPublic },
      },
      tx,
    );

    return {
      ok: true,
      data: { ...created, clientSecret: clientSecret ?? "" },
    } as const;
  });
};

/** Register an untrusted public client through RFC 7591. */
export const registerDynamic = async (params: { name: string; redirectUris: string[]; scopes: OAuthScope[] }): Promise<OAuthClient> =>
  sql.begin(async (tx) => {
    const [row] = await tx<DbClient[]>`
      INSERT INTO oauth.clients (
        name,
        description,
        redirect_uris,
        scopes,
        audiences,
        allowed_profiles,
        access_mode,
        registration_kind,
        is_public,
        client_secret_hash,
        created_by
      )
      VALUES (
        ${params.name},
        'Dynamically registered public OAuth client.',
        ${toPgTextArray(params.redirectUris)}::text[],
        ${toPgTextArray(params.scopes)}::text[],
        ARRAY[]::text[],
        ARRAY['user', 'guest'],
        'profiles',
        'dynamic',
        true,
        NULL,
        NULL
      )
      RETURNING id, name, description, client_id, redirect_uris, logout_uri, scopes, audiences, service_account_id, allowed_profiles, access_mode, registration_kind, is_public, created_at, created_by
    `;
    if (!row) throw new Error("Failed to register dynamic OAuth client");

    const client = mapToClient(row);
    await audit.record(
      {
        action: "oauth.dynamic_client.register",
        outcome: "allowed",
        target: { type: "oauth_client", id: client.id, label: client.name },
        metadata: {
          clientId: client.clientId,
          redirectHosts: client.redirectUris.map((uri) => new URL(uri).host),
          scopes: client.scopes,
        },
      },
      tx,
    );
    return client;
  });

/** Remove abandoned DCR rows that have never reached authorization. */
export const cleanupUnusedDynamic = async (): Promise<number> => {
  const result = await sql`
    DELETE FROM oauth.clients c
    WHERE c.registration_kind = 'dynamic'
      AND c.authorized_at IS NULL
      AND c.created_at < now() - INTERVAL '1 hour'
      AND NOT EXISTS (
        SELECT 1
        FROM oauth.codes code
        WHERE code.client_id = c.client_id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM oauth.refresh_token_families family
        WHERE family.client_id = c.client_id
      )
  `;
  return result.count;
};

/** Persist that a dynamic registration reached explicit resource-owner approval. */
export const markDynamicAuthorized = async (params: { id: string; db?: typeof sql }): Promise<void> => {
  const { id, db = sql } = params;
  const result = await db`
    UPDATE oauth.clients
    SET authorized_at = COALESCE(authorized_at, now())
    WHERE id = ${id}::uuid
      AND registration_kind = 'dynamic'
  `;
  if (result.count !== 1) throw new Error("Dynamic OAuth client is no longer available");
};

/**
 * Update an OAuth client
 */
export const update = async (params: {
  id: string;
  data: UpdateOAuthClient;
  actor: OAuthClientAdminActor;
}): Promise<MutationResult<void>> => {
  const { id, data, actor } = params;
  return sql.begin(async (tx) => {
    const existing = await getForUpdate({ id, db: tx });
    if (!existing) return { ok: false, error: "Client not found", status: 404 } as const;
    if (existing.registrationKind !== "managed") {
      return { ok: false, error: "Only managed OAuth clients can be edited", status: 400 } as const;
    }

    const redirectUrisLiteral = toPgTextArray(data.redirectUris ?? existing.redirectUris);
    const scopesLiteral = toPgTextArray(data.scopes ?? existing.scopes);
    const audiencesLiteral = toPgTextArray(data.audiences ?? existing.audiences);
    const allowedProfilesLiteral = toPgTextArray(data.allowedProfiles ?? existing.allowedProfiles);
    const serviceAccountId = data.serviceAccountId === undefined ? existing.serviceAccountId : data.serviceAccountId;
    const accessMode = data.accessMode ?? existing.accessMode;
    const userIds = uniqueIds(data.allowedUserIds ?? existing.accessUsers.map((user) => user.id));
    const groupIds = uniqueIds(data.allowedGroupIds ?? existing.accessGroups.map((group) => group.id));
    const accessResult = validateAccessSelection({ accessMode, userIds, groupIds });
    if (!accessResult.ok) return accessResult;
    const principalResult = await validateAccessPrincipals({ accessMode, userIds, groupIds });
    if (!principalResult.ok) return principalResult;
    const serviceAccountResult = await validateServiceAccountBinding({ serviceAccountId, isPublic: existing.isPublic });
    if (!serviceAccountResult.ok) return serviceAccountResult;

    await tx`
      UPDATE oauth.clients
      SET
        name = ${data.name ?? existing.name},
        description = ${data.description === undefined ? existing.description : data.description},
        redirect_uris = ${redirectUrisLiteral}::text[],
        logout_uri = ${data.logoutUri === undefined ? existing.logoutUri : data.logoutUri},
        scopes = ${scopesLiteral}::text[],
        audiences = ${audiencesLiteral}::text[],
        service_account_id = ${serviceAccountId}::uuid,
        allowed_profiles = ${allowedProfilesLiteral}::text[],
        access_mode = ${accessMode}
      WHERE id = ${id}
    `;

    await replaceAccessPrincipals({ clientId: id, accessMode, userIds, groupIds, db: tx });
    await audit.record(
      {
        action: "oauth.client.update",
        outcome: "allowed",
        actor: { userId: actor.id, uid: actor.uid, provider: actor.provider, roles: actor.roles },
        target: { type: "oauth_client", id: existing.id, label: data.name ?? existing.name },
        metadata: { clientId: existing.clientId },
      },
      tx,
    );
    return { ok: true, data: undefined } as const;
  });
};

/**
 * Delete an OAuth client
 */
export const delete_ = async (params: { id: string; actor: OAuthClientAdminActor }): Promise<MutationResult<void>> => {
  const existing = await get({ id: params.id });
  if (!existing) return { ok: false, error: "Client not found", status: 404 };
  if (existing.registrationKind === "first_party") {
    return { ok: false, error: "First-party OAuth clients cannot be deleted", status: 400 };
  }

  return sql.begin(async (tx) => {
    const result = await tx`
      DELETE FROM oauth.clients
      WHERE id = ${params.id}
    `;
    if (result.count === 0) return { ok: false, error: "Client not found", status: 404 } as const;

    await audit.record(
      {
        action: "oauth.client.revoke",
        outcome: "allowed",
        actor: {
          userId: params.actor.id,
          uid: params.actor.uid,
          provider: params.actor.provider,
          roles: params.actor.roles,
        },
        target: { type: "oauth_client", id: existing.id, label: existing.name },
        metadata: { clientId: existing.clientId, registrationKind: existing.registrationKind },
      },
      tx,
    );
    return { ok: true, data: undefined } as const;
  });
};

/**
 * Regenerate client secret (confidential clients only)
 */
export const regenerateSecret = async (params: {
  id: string;
  actor: OAuthClientAdminActor;
}): Promise<MutationResult<{ clientSecret: string }>> => {
  const existing = await get({ id: params.id });
  if (!existing) {
    return { ok: false, error: "Client not found", status: 404 };
  }

  if (existing.isPublic) {
    return { ok: false, error: "Cannot regenerate secret for public clients", status: 400 };
  }

  const clientSecret = crypto.randomUUID() + crypto.randomUUID();
  const clientSecretHash = await Bun.password.hash(clientSecret);

  return sql.begin(async (tx) => {
    const result = await tx`
      UPDATE oauth.clients
      SET client_secret_hash = ${clientSecretHash}
      WHERE id = ${params.id}
        AND registration_kind = 'managed'
    `;
    if (result.count !== 1) return { ok: false, error: "Client cannot rotate its secret", status: 400 } as const;

    await audit.record(
      {
        action: "oauth.client.secret_regenerate",
        outcome: "allowed",
        actor: {
          userId: params.actor.id,
          uid: params.actor.uid,
          provider: params.actor.provider,
          roles: params.actor.roles,
        },
        target: { type: "oauth_client", id: existing.id, label: existing.name },
        metadata: { clientId: existing.clientId },
      },
      tx,
    );

    return { ok: true, data: { clientSecret } } as const;
  });
};

/**
 * Validate client credentials and return client if valid
 */
export const validateCredentials = async (params: { clientId: string; clientSecret?: string }): Promise<OAuthClient | null> => {
  const [row] = await sql<(DbClient & { client_secret_hash: string | null })[]>`
    SELECT id, name, description, client_id, client_secret_hash, redirect_uris, logout_uri, scopes, audiences, service_account_id, allowed_profiles, access_mode, registration_kind, is_public, created_at, created_by
    FROM oauth.clients
    WHERE client_id = ${params.clientId}
  `;

  if (!row) return null;

  const access = await loadAccessPrincipals([row.id]);

  // Public clients don't need secret validation
  if (row.is_public) {
    return mapToClient(row, access.get(row.id));
  }

  // Confidential clients require valid secret
  if (!params.clientSecret || !row.client_secret_hash) {
    return null;
  }

  const valid = await Bun.password.verify(params.clientSecret, row.client_secret_hash);
  if (!valid) return null;

  return mapToClient(row, access.get(row.id));
};

/**
 * Validate that a redirect URI is allowed for this client
 */
export const validateRedirectUri = (client: OAuthClient, redirectUri: string): boolean => {
  return client.redirectUris.some((registeredUri) => registeredUri === redirectUri || isLoopbackRedirectMatch(registeredUri, redirectUri));
};

/** Dynamic public clients are resource-bound to an explicit URI on this Cloud origin. */
export const validateResource = (client: OAuthClient, resource: string | undefined, issuer: string): boolean => {
  if (client.registrationKind !== "dynamic") return !resource || client.audiences.includes(resource);
  if (!resource) return false;
  try {
    return new URL(resource).origin === new URL(issuer).origin;
  } catch {
    return false;
  }
};

const LOOPBACK_IP_LITERAL_HOSTS = new Set(["127.0.0.1", "::1", "[::1]"]);

const isLoopbackRedirectMatch = (registeredUri: string, redirectUri: string): boolean => {
  let registered: URL;
  let requested: URL;
  try {
    registered = new URL(registeredUri);
    requested = new URL(redirectUri);
  } catch {
    return false;
  }

  if (registered.protocol !== "http:" || requested.protocol !== "http:") return false;
  if (!LOOPBACK_IP_LITERAL_HOSTS.has(registered.hostname) || !LOOPBACK_IP_LITERAL_HOSTS.has(requested.hostname)) return false;
  if (registered.hostname !== requested.hostname) return false;
  return registered.pathname === requested.pathname && registered.search === requested.search;
};

/**
 * Check if a user profile is allowed for this client
 */
export const isProfileAllowed = (client: OAuthClient, profile: OAuthAllowedProfile): boolean => {
  return client.allowedProfiles.includes(profile);
};

export const canAuthorizeUser = async (params: { client: OAuthClient; userId: string; profile: OAuthAllowedProfile }): Promise<boolean> => {
  if (!isProfileAllowed(params.client, params.profile)) return false;
  if (params.client.accessMode !== "specific") return true;

  const [row] = await sql<{ allowed: boolean }[]>`
    WITH RECURSIVE user_all_groups(group_id) AS (
      SELECT ug.group_id
      FROM auth.user_groups_v2 ug
      WHERE ug.user_id = ${params.userId}::uuid
      UNION
      SELECT gg.parent_group_id
      FROM auth.group_groups_v2 gg
      JOIN user_all_groups ag ON ag.group_id = gg.child_group_id
    )
    SELECT EXISTS (
      SELECT 1
      FROM oauth.client_access_users cau
      WHERE cau.client_id = ${params.client.id}::uuid
        AND cau.user_id = ${params.userId}::uuid
      UNION
      SELECT 1
      FROM oauth.client_access_groups cag
      JOIN user_all_groups ag ON ag.group_id = cag.group_id
      WHERE cag.client_id = ${params.client.id}::uuid
    ) AS allowed
  `;

  return row?.allowed === true;
};

const validateServiceAccountBinding = async (params: {
  serviceAccountId: string | null;
  isPublic: boolean;
}): Promise<MutationResult<void>> => {
  const { serviceAccountId, isPublic } = params;
  if (!serviceAccountId) return { ok: true, data: undefined };
  if (isPublic) {
    return { ok: false, error: "Service-account OAuth clients must be confidential", status: 400 };
  }

  const serviceAccount = await serviceAccounts.get({ id: serviceAccountId });
  if (!serviceAccount) return { ok: false, error: "Service account not found", status: 404 };
  if (serviceAccount.kind !== "resource_bound") {
    return { ok: false, error: "OAuth client credentials can only bind resource service accounts", status: 400 };
  }
  if (serviceAccount.status !== "active") {
    return { ok: false, error: "Service account is not active", status: 400 };
  }

  return { ok: true, data: undefined };
};
