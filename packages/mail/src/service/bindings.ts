import { err, fail, ok, type Result } from "@k2b/stdlib";
import { audit, isUniqueViolation, logger, toPgTextArray } from "@k2b/cloud/services";
import { sql } from "bun";
import type { ConnectorVerification, ProviderBinding, RemoteFolder, RemoteNamespace } from "../contracts";
import { withShortIdDb } from "../lib/short-id";
import { requireMailboxPermission } from "./access";
import { auditActorFromRequest, type MailRequestContext } from "./auth";
import { sha256Json } from "./canonical";
import { imapSmtpConnector } from "./connectors";
import { logDatabaseFailure } from "./database-errors";
import { getProviderConnection, type loadProviderConnectionRuntime, loadProviderConnectionRuntimeSnapshot } from "./provider-connections";
import { isProviderAuthenticationFailure, providerErrorCode, providerErrorMessage } from "./provider-errors";
import { withMailboxProviderOperationBarrier } from "./provider-operation-lock";

type SqlClient = typeof sql;

const log = logger("mail:bindings");

type FolderEvidence = {
  relativePath: string;
  parentRelativePath: string | null;
  name: string;
  role: RemoteFolder["role"];
  remotePath: string;
  delimiter: string | null;
  selectable: boolean;
  subscribed: boolean;
  uidValidity: string | null;
  uidNext: string | null;
  highestModseq: string | null;
  rights: string[];
  rightsSource: RemoteFolder["rightsSource"];
  namespaceKind?: RemoteNamespace["kind"] | null;
};

type ScopeEvidence = {
  version: 1;
  serverKey: string;
  accountId: string;
  namespaces: RemoteNamespace[];
  folders: FolderEvidence[];
};

type DbBinding = {
  id: string;
  mailbox_id: string;
  connection_id: string;
  state: ProviderBinding["state"];
  authenticated_principal: string | null;
  remote_locator: Record<string, unknown> | string;
  capabilities: Record<string, unknown> | string;
  last_verified_at: Date | string | null;
  last_error_message: string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

const toIso = (value: Date | string): string => (value instanceof Date ? value : new Date(value)).toISOString();
const parseRecord = (value: Record<string, unknown> | string): Record<string, unknown> =>
  typeof value === "string" ? (JSON.parse(value) as Record<string, unknown>) : value;

const mapBinding = (row: DbBinding): ProviderBinding => {
  return {
    id: row.id,
    mailboxId: row.mailbox_id,
    connectionId: row.connection_id,
    state: row.state,
    authenticatedPrincipal: row.authenticated_principal,
    capabilities: parseRecord(row.capabilities),
    lastVerifiedAt: row.last_verified_at ? toIso(row.last_verified_at) : null,
    lastError: row.last_error_message,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
};

const sha256 = sha256Json;

const listMailboxRemoteResourceIds = async (mailboxId: string, db: SqlClient = sql): Promise<string[]> => {
  const rows = await db<{ id: string }[]>`
    SELECT id
    FROM mail.remote_resources
    WHERE mailbox_id = ${mailboxId}::uuid
    ORDER BY id
  `;
  return rows.map((row) => row.id);
};

const sameResourceIds = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

const relativePathFor = (folder: RemoteFolder): string => (folder.path.toUpperCase() === "INBOX" ? "INBOX" : folder.path);

const namespaceKindForPath = (path: string, namespaces: RemoteNamespace[]): RemoteNamespace["kind"] | null =>
  namespaces
    .filter((namespace) => namespace.prefix === "" || path.startsWith(namespace.prefix))
    .sort((left, right) => right.prefix.length - left.prefix.length)[0]?.kind ?? null;

const buildScopeEvidence = async (params: {
  verification: ConnectorVerification;
  folders: RemoteFolder[];
  runtime: Awaited<ReturnType<typeof loadProviderConnectionRuntime>>;
}): Promise<ScopeEvidence> => {
  const account = params.verification.accounts[0];
  if (!account) throw new Error("Provider verification returned no account");
  const namespaces = account.namespaces;
  const snapshots: FolderEvidence[] = params.folders.map((folder) => ({
    relativePath: relativePathFor(folder),
    parentRelativePath: folder.parentPath,
    name: folder.name,
    role: folder.role,
    remotePath: folder.path,
    delimiter: folder.delimiter,
    selectable: folder.selectable,
    subscribed: folder.subscribed,
    uidValidity: folder.uidValidity,
    uidNext: folder.uidNext,
    highestModseq: folder.highestModseq,
    rights: [...folder.rights].sort(),
    rightsSource: folder.rightsSource,
    namespaceKind: namespaceKindForPath(folder.path, namespaces),
  }));

  return {
    version: 1,
    serverKey: sha256({
      host: params.runtime.imap.host.toLowerCase(),
      port: params.runtime.imap.port,
      tlsMode: params.runtime.imap.tlsMode,
      serverInfo: params.verification.serverIdentity["serverInfo"] ?? {},
    }),
    accountId: account.id,
    namespaces,
    folders: snapshots.sort((left, right) => left.relativePath.localeCompare(right.relativePath)),
  };
};

type EvidenceComparison = { state: "verified" | "different"; reason: string };

const compareEvidence = (expected: ScopeEvidence, candidate: ScopeEvidence): EvidenceComparison => {
  if (expected.serverKey !== candidate.serverKey) return { state: "different", reason: "Provider server identity differs" };
  if (expected.accountId !== candidate.accountId) return { state: "different", reason: "Authenticated provider account differs" };
  return { state: "verified", reason: "Provider server and authenticated account match" };
};

const canonicalFolderKey = (relativePath: string): string => sha256({ version: 1, relativePath });

type FolderProjectionStats = {
  discovered: number;
  missing: number;
  ambiguous: number;
  renamed: number;
};

export type BindingRediscoveryResult = FolderProjectionStats & {
  bindingId: string;
  discoveryGeneration: number;
  state: ProviderBinding["state"];
  rightsSources: Record<RemoteFolder["rightsSource"], number>;
};

type ExistingFolderProjection = {
  folder_id: string;
  stable_key: string;
  role: RemoteFolder["role"];
  remote_path: string | null;
  uid_validity: string | number | null;
};

type FolderProjectionMatch = {
  folder: ExistingFolderProjection | null;
  ambiguousFolderIds: string[];
  renamed: boolean;
  skip: boolean;
};

const matchFolderProjection = (params: {
  folder: FolderEvidence;
  stableKey: string;
  byStableKey: Map<string, ExistingFolderProjection>;
  byRemotePath: Map<string, ExistingFolderProjection>;
  byUidValidity: Map<string, ExistingFolderProjection[]>;
  discoveredUidCounts: Map<string, number>;
  usedFolderIds: Set<string>;
}): FolderProjectionMatch => {
  const pathCandidate = params.byRemotePath.get(params.folder.remotePath) ?? null;
  const stableCandidate = params.byStableKey.get(params.stableKey) ?? null;
  const pathMatch = pathCandidate && !params.usedFolderIds.has(pathCandidate.folder_id) ? pathCandidate : null;
  const stableMatch = stableCandidate && !params.usedFolderIds.has(stableCandidate.folder_id) ? stableCandidate : null;
  if (pathMatch && stableMatch && pathMatch.folder_id !== stableMatch.folder_id) {
    return {
      folder: null,
      ambiguousFolderIds: [pathMatch.folder_id, stableMatch.folder_id],
      renamed: false,
      skip: true,
    };
  }
  const exactMatch = pathMatch ?? stableMatch;
  if (!params.folder.uidValidity) {
    return { folder: exactMatch, ambiguousFolderIds: [], renamed: false, skip: false };
  }
  const identityMatches = (params.byUidValidity.get(params.folder.uidValidity) ?? []).filter(
    (candidate) => candidate.role === params.folder.role && !params.usedFolderIds.has(candidate.folder_id),
  );
  const uniqueIdentity = identityMatches.length === 1 && params.discoveredUidCounts.get(params.folder.uidValidity) === 1;
  if (!uniqueIdentity) {
    if (exactMatch) return { folder: exactMatch, ambiguousFolderIds: [], renamed: false, skip: false };
    return identityMatches.length === 0
      ? { folder: null, ambiguousFolderIds: [], renamed: false, skip: false }
      : { folder: null, ambiguousFolderIds: identityMatches.map((candidate) => candidate.folder_id), renamed: false, skip: true };
  }
  const identityMatch = identityMatches[0]!;
  if (exactMatch && exactMatch.folder_id !== identityMatch.folder_id) {
    return {
      folder: null,
      ambiguousFolderIds: [exactMatch.folder_id, identityMatch.folder_id],
      renamed: false,
      skip: true,
    };
  }
  return {
    folder: identityMatch,
    ambiguousFolderIds: [],
    renamed: Boolean(identityMatch.remote_path && identityMatch.remote_path !== params.folder.remotePath),
    skip: false,
  };
};

type FolderProjectionIndexes = {
  byStableKey: Map<string, ExistingFolderProjection>;
  byRemotePath: Map<string, ExistingFolderProjection>;
  byUidValidity: Map<string, ExistingFolderProjection[]>;
  discoveredUidCounts: Map<string, number>;
};

const buildFolderProjectionIndexes = (existing: ExistingFolderProjection[], evidence: ScopeEvidence): FolderProjectionIndexes => {
  const byStableKey = new Map(existing.map((folder) => [folder.stable_key, folder]));
  const byRemotePath = new Map(existing.filter((folder) => folder.remote_path).map((folder) => [folder.remote_path!, folder]));
  const byUidValidity = new Map<string, ExistingFolderProjection[]>();
  for (const folder of existing) {
    if (folder.uid_validity == null) continue;
    const key = String(folder.uid_validity);
    byUidValidity.set(key, [...(byUidValidity.get(key) ?? []), folder]);
  }
  const discoveredUidCounts = new Map<string, number>();
  for (const folder of evidence.folders) {
    if (!folder.uidValidity) continue;
    discoveredUidCounts.set(folder.uidValidity, (discoveredUidCounts.get(folder.uidValidity) ?? 0) + 1);
  }
  return { byStableKey, byRemotePath, byUidValidity, discoveredUidCounts };
};

const folderProjectionPriority = (folder: FolderEvidence, indexes: FolderProjectionIndexes): number => {
  if (!folder.uidValidity || indexes.discoveredUidCounts.get(folder.uidValidity) !== 1) return 1;
  const matches = (indexes.byUidValidity.get(folder.uidValidity) ?? []).filter((candidate) => candidate.role === folder.role);
  return matches.length === 1 && matches[0]?.remote_path && matches[0].remote_path !== folder.remotePath ? 0 : 1;
};

const rememberProjectedFolder = (params: {
  indexes: FolderProjectionIndexes;
  previous: ExistingFolderProjection | null;
  folderId: string;
  stableKey: string;
  folder: FolderEvidence;
}): void => {
  if (params.previous) {
    if (params.indexes.byStableKey.get(params.previous.stable_key)?.folder_id === params.previous.folder_id) {
      params.indexes.byStableKey.delete(params.previous.stable_key);
    }
    if (
      params.previous.remote_path &&
      params.indexes.byRemotePath.get(params.previous.remote_path)?.folder_id === params.previous.folder_id
    ) {
      params.indexes.byRemotePath.delete(params.previous.remote_path);
    }
    if (params.previous.uid_validity != null) {
      const key = String(params.previous.uid_validity);
      const remaining = (params.indexes.byUidValidity.get(key) ?? []).filter((item) => item.folder_id !== params.previous!.folder_id);
      if (remaining.length > 0) params.indexes.byUidValidity.set(key, remaining);
      else params.indexes.byUidValidity.delete(key);
    }
  }
  const projected: ExistingFolderProjection = {
    folder_id: params.folderId,
    stable_key: params.stableKey,
    role: params.folder.role,
    remote_path: params.folder.remotePath,
    uid_validity: params.folder.uidValidity,
  };
  params.indexes.byStableKey.set(params.stableKey, projected);
  params.indexes.byRemotePath.set(params.folder.remotePath, projected);
  if (params.folder.uidValidity) {
    params.indexes.byUidValidity.set(params.folder.uidValidity, [
      ...(params.indexes.byUidValidity.get(params.folder.uidValidity) ?? []),
      projected,
    ]);
  }
};

const upsertProjectedFolder = async (params: {
  db: SqlClient;
  remoteResourceId: string;
  discoveryGeneration: number;
  stableKey: string;
  folder: FolderEvidence;
  existing: ExistingFolderProjection | null;
}): Promise<string> => {
  if (params.existing) {
    const [updated] = await params.db<{ id: string }[]>`
      UPDATE mail.folders
      SET
        stable_key = ${params.stableKey},
        name = ${params.folder.name},
        role = ${params.folder.role},
        selectable = ${params.folder.selectable},
        discovery_generation = ${params.discoveryGeneration},
        discovery_state = 'active',
        missing_since = NULL,
        dismissed_at = NULL
      WHERE id = ${params.existing.folder_id}::uuid
      RETURNING id
    `;
    if (!updated) throw new Error("Discovered folder disappeared during projection");
    return updated.id;
  }
  const readable = params.folder.selectable && params.folder.rights.includes("read");
  const createdRows = await withShortIdDb(
    params.db,
    "folder",
    (db, shortId) => db<{ id: string }[]>`
    INSERT INTO mail.folders (
      short_id, remote_resource_id, stable_key, name, role, selectable, selected_for_sync,
      show_in_sidebar, discovery_generation, discovery_state, sync_status
    )
    VALUES (
      ${shortId},
      ${params.remoteResourceId}::uuid,
      ${params.stableKey},
      ${params.folder.name},
      ${params.folder.role},
      ${params.folder.selectable},
      ${readable},
      ${!params.folder.selectable || params.folder.subscribed},
      ${params.discoveryGeneration},
      'active',
      ${readable ? "pending" : "excluded"}
    )
    RETURNING id
  `,
  );
  const [created] = createdRows;
  if (!created) throw new Error("Discovered folder insert returned no row");
  return created.id;
};

const upsertProjectedFolderRef = async (params: {
  db: SqlClient;
  bindingId: string;
  folderId: string;
  discoveryGeneration: number;
  folder: FolderEvidence;
}): Promise<void> => {
  await params.db`
    INSERT INTO mail.binding_folder_refs (
      binding_id, folder_id, remote_path, delimiter, namespace_kind, uid_validity,
      highest_modseq, uid_next, subscribed, effective_rights, rights_source,
      last_seen_generation, missing_since, last_verified_at
    )
    VALUES (
      ${params.bindingId}::uuid,
      ${params.folderId}::uuid,
      ${params.folder.remotePath},
      ${params.folder.delimiter},
      ${params.folder.namespaceKind ?? null},
      ${params.folder.uidValidity},
      ${params.folder.highestModseq},
      ${params.folder.uidNext},
      ${params.folder.subscribed},
      ${toPgTextArray(params.folder.rights)}::text[],
      ${params.folder.rightsSource ?? "unknown"},
      ${params.discoveryGeneration},
      NULL,
      now()
    )
    ON CONFLICT (binding_id, folder_id) DO UPDATE SET
      remote_path = EXCLUDED.remote_path,
      delimiter = EXCLUDED.delimiter,
      namespace_kind = EXCLUDED.namespace_kind,
      uid_validity = EXCLUDED.uid_validity,
      highest_modseq = EXCLUDED.highest_modseq,
      uid_next = EXCLUDED.uid_next,
      subscribed = EXCLUDED.subscribed,
      effective_rights = EXCLUDED.effective_rights,
      rights_source = EXCLUDED.rights_source,
      last_seen_generation = EXCLUDED.last_seen_generation,
      missing_since = NULL,
      last_verified_at = EXCLUDED.last_verified_at
  `;
};

const updateProjectedFolderParents = async (db: SqlClient, folders: FolderEvidence[], folderIds: Map<string, string>): Promise<void> => {
  for (const folder of folders) {
    const folderId = folderIds.get(folder.relativePath);
    if (!folderId) continue;
    const parentId = folder.parentRelativePath ? (folderIds.get(folder.parentRelativePath) ?? null) : null;
    await db`UPDATE mail.folders SET parent_id = ${parentId}::uuid WHERE id = ${folderId}::uuid`;
  }
};

const finalizeFolderProjection = async (params: {
  db: SqlClient;
  bindingId: string;
  remoteResourceId: string;
  discoveryGeneration: number;
  ambiguousFolderIds: Set<string>;
}): Promise<{ missing: number; ambiguous: number }> => {
  await params.db`
    UPDATE mail.binding_folder_refs
    SET
      missing_since = COALESCE(missing_since, now()),
      effective_rights = ARRAY[]::text[],
      rights_source = 'unknown',
      last_verified_at = now()
    WHERE binding_id = ${params.bindingId}::uuid
      AND last_seen_generation < ${params.discoveryGeneration}
  `;
  await params.db`
    WITH folder_availability AS MATERIALIZED (
      SELECT
        folder.id,
        EXISTS (
          SELECT 1
          FROM mail.binding_folder_refs ref
          JOIN mail.provider_bindings binding ON binding.id = ref.binding_id
          WHERE ref.folder_id = folder.id AND ref.missing_since IS NULL AND binding.state = 'active'
        ) AS available,
        EXISTS (
          SELECT 1
          FROM mail.binding_folder_refs ref
          JOIN mail.provider_bindings binding ON binding.id = ref.binding_id
          WHERE ref.folder_id = folder.id
            AND ref.missing_since IS NULL
            AND binding.state = 'active'
            AND 'read' = ANY(ref.effective_rights)
        ) AS readable
      FROM mail.folders folder
      WHERE folder.remote_resource_id = ${params.remoteResourceId}::uuid
    )
    UPDATE mail.folders folder
    SET
      discovery_state = CASE WHEN availability.available THEN 'active' ELSE 'missing' END,
      missing_since = CASE WHEN availability.available THEN NULL ELSE COALESCE(folder.missing_since, now()) END,
      dismissed_at = CASE WHEN availability.available THEN NULL ELSE folder.dismissed_at END,
      selected_for_sync = folder.selected_for_sync AND availability.readable,
      sync_status = CASE
        WHEN NOT availability.available OR NOT availability.readable THEN 'excluded'
        WHEN folder.sync_status = 'excluded' THEN 'pending'
        ELSE folder.sync_status
      END
    FROM folder_availability availability
    WHERE folder.id = availability.id
  `;
  if (params.ambiguousFolderIds.size > 0) {
    await params.db`
      UPDATE mail.folders
      SET discovery_state = 'ambiguous', missing_since = COALESCE(missing_since, now())
      WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text(${[...params.ambiguousFolderIds]}::jsonb))
        AND discovery_state = 'missing'
    `;
  }
  const [stats] = await params.db<{ missing: number; ambiguous: number }[]>`
    SELECT
      COUNT(*) FILTER (WHERE discovery_state = 'missing')::int AS missing,
      COUNT(*) FILTER (WHERE discovery_state = 'ambiguous')::int AS ambiguous
    FROM mail.folders
    WHERE remote_resource_id = ${params.remoteResourceId}::uuid
  `;
  return { missing: stats?.missing ?? 0, ambiguous: stats?.ambiguous ?? 0 };
};

const projectFolders = async (params: {
  db: SqlClient;
  remoteResourceId: string;
  bindingId: string;
  discoveryGeneration: number;
  evidence: ScopeEvidence;
}): Promise<FolderProjectionStats> => {
  const existing = await params.db<ExistingFolderProjection[]>`
    SELECT
      folder.id AS folder_id,
      folder.stable_key,
      folder.role,
      ref.remote_path,
      ref.uid_validity
    FROM mail.folders folder
    LEFT JOIN mail.binding_folder_refs ref
      ON ref.folder_id = folder.id
     AND ref.binding_id = ${params.bindingId}::uuid
    WHERE folder.remote_resource_id = ${params.remoteResourceId}::uuid
    ORDER BY folder.id
    FOR UPDATE OF folder
  `;
  const indexes = buildFolderProjectionIndexes(existing, params.evidence);

  const usedFolderIds = new Set<string>();
  const ambiguousFolderIds = new Set<string>();
  const folderIds = new Map<string, string>();
  let renamed = 0;

  const projectionOrder = params.evidence.folders
    .map((folder, index) => ({ folder, index, priority: folderProjectionPriority(folder, indexes) }))
    .sort((left, right) => left.priority - right.priority || left.index - right.index)
    .map((item) => item.folder);
  for (const folder of projectionOrder) {
    const stableKey = canonicalFolderKey(folder.relativePath);
    const match = matchFolderProjection({
      folder,
      stableKey,
      ...indexes,
      usedFolderIds,
    });
    for (const folderId of match.ambiguousFolderIds) ambiguousFolderIds.add(folderId);
    if (match.skip) continue;
    if (match.renamed) renamed += 1;
    const folderId = await upsertProjectedFolder({
      db: params.db,
      remoteResourceId: params.remoteResourceId,
      discoveryGeneration: params.discoveryGeneration,
      stableKey,
      folder,
      existing: match.folder,
    });
    rememberProjectedFolder({ indexes, previous: match.folder, folderId, stableKey, folder });
    usedFolderIds.add(folderId);
    folderIds.set(folder.relativePath, folderId);
    await upsertProjectedFolderRef({
      db: params.db,
      bindingId: params.bindingId,
      folderId,
      discoveryGeneration: params.discoveryGeneration,
      folder,
    });
  }

  await updateProjectedFolderParents(params.db, params.evidence.folders, folderIds);
  const stats = await finalizeFolderProjection({
    db: params.db,
    bindingId: params.bindingId,
    remoteResourceId: params.remoteResourceId,
    discoveryGeneration: params.discoveryGeneration,
    ambiguousFolderIds,
  });
  return {
    discovered: params.evidence.folders.length,
    missing: stats.missing,
    ambiguous: stats.ambiguous,
    renamed,
  };
};

const updateMailboxBindingHealth = async (mailboxId: string, failure?: { code: string; message: string }): Promise<void> => {
  const [state] = await sql<{ active: number; degraded: number; ambiguous: number }[]>`
    SELECT
      COUNT(*) FILTER (
        WHERE binding.state = 'active'
          AND binding.verified_scope_fingerprint = resource.scope_fingerprint
          AND binding.verified_secret_revision = connection.secret_revision
          AND connection.status = 'active'
          AND connection.encrypted_secret IS NOT NULL
      )::int AS active,
      COUNT(*) FILTER (
        WHERE binding.state = 'degraded'
          OR connection.status = 'degraded'
          OR (
            binding.state = 'active'
            AND (
              binding.verified_scope_fingerprint IS DISTINCT FROM resource.scope_fingerprint
              OR binding.verified_secret_revision <> connection.secret_revision
              OR connection.encrypted_secret IS NULL
            )
          )
      )::int AS degraded,
      (
        SELECT COUNT(*)::int
        FROM mail.folders folder
        JOIN mail.remote_resources folder_resource ON folder_resource.id = folder.remote_resource_id
        WHERE folder_resource.mailbox_id = ${mailboxId}::uuid AND folder.discovery_state = 'ambiguous'
      ) AS ambiguous
    FROM mail.provider_bindings binding
    JOIN mail.remote_resources resource ON resource.id = binding.remote_resource_id
    JOIN mail.provider_connections connection ON connection.id = binding.connection_id
    WHERE resource.mailbox_id = ${mailboxId}::uuid
  `;
  if ((state?.active ?? 0) > 0) {
    await sql`
      UPDATE mail.mailboxes
      SET
        health = CASE
          WHEN sync_enabled = false THEN 'paused'
          WHEN ${state?.degraded ?? 0} > 0 OR ${state?.ambiguous ?? 0} > 0 THEN 'degraded'
          WHEN health IN ('auth_required', 'connection_required', 'degraded', 'reconnecting') THEN 'bootstrapping'
          ELSE health
        END,
        health_reason = CASE
          WHEN sync_enabled = false THEN 'Synchronization paused by a mailbox administrator'
          WHEN ${state?.degraded ?? 0} > 0 THEN 'One or more provider bindings require attention'
          WHEN ${state?.ambiguous ?? 0} > 0 THEN 'One or more remote folders require identity review'
          WHEN health IN ('auth_required', 'connection_required', 'degraded', 'reconnecting') THEN 'Provider access restored; synchronization pending'
          ELSE health_reason
        END
      WHERE id = ${mailboxId}::uuid AND deleted_at IS NULL
    `;
    return;
  }
  const authFailure = failure ? isProviderAuthenticationFailure(failure, failure.code) : false;
  await sql`
    UPDATE mail.mailboxes
    SET
      health = CASE WHEN sync_enabled = false THEN 'paused' ELSE ${authFailure ? "auth_required" : "connection_required"} END,
      health_reason = CASE
        WHEN sync_enabled = false THEN 'Synchronization paused by a mailbox administrator'
        ELSE ${failure?.message ?? "No active provider binding is available"}
      END
    WHERE id = ${mailboxId}::uuid AND deleted_at IS NULL
  `;
};

const markRediscoveryFailure = async (
  bindingId: string,
  connectionId: string,
  expectedSecretRevision: number,
  expectedOAuthTokenRevision: number | null,
  error: unknown,
): Promise<void> => {
  const code = providerErrorCode(error, "PROVIDER_REDISCOVERY_FAILED");
  const message = providerErrorMessage(error, "Provider rediscovery failed");
  const authFailure = isProviderAuthenticationFailure(error, code);
  const affected = authFailure
    ? await sql.begin(async (tx) => {
        const [connection] = await tx<{ id: string }[]>`
          UPDATE mail.provider_connections
          SET status = 'degraded', last_error_code = ${code}, last_error_message = ${message}
          WHERE id = ${connectionId}::uuid
            AND secret_revision = ${expectedSecretRevision}
            AND (
              ${expectedOAuthTokenRevision}::bigint IS NULL
              OR oauth_token_revision = ${expectedOAuthTokenRevision}::bigint
            )
            AND status IN ('active', 'degraded')
          RETURNING id
        `;
        if (!connection) return [];
        return tx<{ mailbox_id: string }[]>`
          UPDATE mail.provider_bindings binding
          SET state = 'degraded', last_error_code = ${code}, last_error_message = ${message}
          FROM mail.remote_resources resource
          WHERE binding.connection_id = ${connectionId}::uuid
            AND binding.verified_secret_revision = ${expectedSecretRevision}
            AND binding.state IN ('active', 'degraded')
            AND resource.id = binding.remote_resource_id
          RETURNING resource.mailbox_id
        `;
      })
    : await sql<{ mailbox_id: string }[]>`
        UPDATE mail.provider_bindings binding
        SET state = 'degraded', last_error_code = ${code}, last_error_message = ${message}
        FROM mail.remote_resources resource, mail.provider_connections connection
        WHERE binding.id = ${bindingId}::uuid
          AND binding.state IN ('active', 'degraded')
          AND resource.id = binding.remote_resource_id
          AND connection.id = binding.connection_id
          AND connection.secret_revision = ${expectedSecretRevision}
          AND binding.verified_secret_revision = ${expectedSecretRevision}
          AND (
            ${expectedOAuthTokenRevision}::bigint IS NULL
            OR connection.oauth_token_revision = ${expectedOAuthTokenRevision}::bigint
          )
        RETURNING resource.mailbox_id
      `;
  for (const mailboxId of new Set(affected.map((row) => row.mailbox_id))) {
    await updateMailboxBindingHealth(mailboxId, { code, message });
  }
};

const REDISCOVERY_SUPERSEDED_CODES = new Set([
  "BINDING_CONFIGURATION_CHANGED",
  "BINDING_STATE_CHANGED",
  "BINDING_UNAVAILABLE",
  "CONNECTION_UNAVAILABLE",
  "CREDENTIAL_REVISION_CHANGED",
  "MAILBOX_TRANSPORT_CHANGED",
]);

export const rediscoverProviderBinding = async (params: {
  bindingId: string;
  allowCredentialRevision?: boolean;
  signal?: AbortSignal;
}): Promise<BindingRediscoveryResult> => {
  const [current] = await sql<
    {
      binding_id: string;
      mailbox_id: string;
      remote_resource_id: string;
      connection_id: string;
      binding_state: ProviderBinding["state"];
      remote_locator: Record<string, unknown> | string;
      verification_evidence: ScopeEvidence | string;
      verified_secret_revision: number;
      secret_revision: number;
      scope_fingerprint: string;
      sync_generation: string | number;
    }[]
  >`
    SELECT
      binding.id AS binding_id,
      resource.mailbox_id,
      resource.id AS remote_resource_id,
      binding.connection_id,
      binding.state AS binding_state,
      binding.remote_locator,
      binding.verification_evidence,
      binding.verified_secret_revision,
      connection.secret_revision,
      resource.scope_fingerprint,
      resource.sync_generation
    FROM mail.provider_bindings binding
    JOIN mail.remote_resources resource ON resource.id = binding.remote_resource_id
    JOIN mail.provider_connections connection ON connection.id = binding.connection_id
    JOIN mail.mailboxes mailbox ON mailbox.id = resource.mailbox_id
    WHERE binding.id = ${params.bindingId}::uuid
      AND (
        binding.state IN ('active', 'degraded')
        OR (${params.allowCredentialRevision === true} AND binding.state = 'pending')
      )
      AND connection.status IN ('active', 'degraded')
      AND connection.encrypted_secret IS NOT NULL
      AND mailbox.deleted_at IS NULL
  `;
  if (!current) throw Object.assign(new Error("Provider binding is unavailable for rediscovery"), { code: "BINDING_UNAVAILABLE" });
  if (current.verified_secret_revision !== current.secret_revision && !params.allowCredentialRevision) {
    throw Object.assign(new Error("Provider credentials changed; explicit binding verification is required"), {
      code: "CREDENTIAL_REVERIFY_REQUIRED",
    });
  }
  let expectedOAuthTokenRevision: number | null = null;
  try {
    const snapshot = await loadProviderConnectionRuntimeSnapshot(current.connection_id);
    expectedOAuthTokenRevision = snapshot.oauthTokenRevision;
    if (snapshot.secretRevision !== current.secret_revision) {
      throw Object.assign(new Error("Provider credentials changed during rediscovery"), { code: "CREDENTIAL_REVISION_CHANGED" });
    }
    const [verification, folders] = await Promise.all([
      imapSmtpConnector.verify(snapshot.runtime),
      imapSmtpConnector.discoverFolders(snapshot.runtime, params.signal),
    ]);
    if (folders.length === 0)
      throw Object.assign(new Error("The provider account contains no visible folders"), { code: "REMOTE_ACCOUNT_EMPTY" });
    const evidence = await buildScopeEvidence({ verification, folders, runtime: snapshot.runtime });
    const previousEvidence =
      typeof current.verification_evidence === "string"
        ? (JSON.parse(current.verification_evidence) as ScopeEvidence)
        : current.verification_evidence;
    const comparison = compareEvidence(previousEvidence, evidence);
    if (comparison.state === "different") {
      throw Object.assign(new Error(comparison.reason), { code: "REMOTE_RESOURCE_CHANGED" });
    }
    const result = await sql.begin(async (tx) => {
      const [locked] = await tx<
        {
          mailbox_id: string;
          remote_resource_id: string;
          binding_state: ProviderBinding["state"];
          remote_locator: Record<string, unknown> | string;
          scope_fingerprint: string;
          secret_revision: number;
          connection_status: string;
          has_secret: boolean;
          discovery_generation: string | number;
          sync_generation: string | number;
          mailbox_deleted_at: Date | string | null;
        }[]
      >`
        SELECT
          resource.mailbox_id,
          resource.id AS remote_resource_id,
          binding.state AS binding_state,
          binding.remote_locator,
          resource.scope_fingerprint,
          connection.secret_revision,
          connection.status AS connection_status,
          connection.encrypted_secret IS NOT NULL AS has_secret,
          resource.discovery_generation,
          resource.sync_generation,
          mailbox.deleted_at AS mailbox_deleted_at
        FROM mail.provider_bindings binding
        JOIN mail.remote_resources resource ON resource.id = binding.remote_resource_id
        JOIN mail.provider_connections connection ON connection.id = binding.connection_id
        JOIN mail.mailboxes mailbox ON mailbox.id = resource.mailbox_id
        WHERE binding.id = ${params.bindingId}::uuid
        FOR UPDATE OF binding, resource, connection, mailbox
      `;
      if (!locked) throw Object.assign(new Error("Provider binding disappeared during rediscovery"), { code: "BINDING_UNAVAILABLE" });
      if (locked.mailbox_deleted_at || Number(locked.sync_generation) !== Number(current.sync_generation)) {
        throw Object.assign(new Error("Mailbox transport changed during rediscovery"), { code: "MAILBOX_TRANSPORT_CHANGED" });
      }
      if (locked.secret_revision !== snapshot.secretRevision) {
        throw Object.assign(new Error("Provider credentials changed during rediscovery"), { code: "CREDENTIAL_REVISION_CHANGED" });
      }
      const bindingStateAllowed =
        locked.binding_state === "active" ||
        locked.binding_state === "degraded" ||
        (params.allowCredentialRevision === true && locked.binding_state === "pending");
      if (!bindingStateAllowed) {
        throw Object.assign(new Error("Provider binding state changed during rediscovery"), { code: "BINDING_STATE_CHANGED" });
      }
      if (locked.connection_status === "revoked" || !locked.has_secret) {
        throw Object.assign(new Error("Provider connection was revoked during rediscovery"), { code: "CONNECTION_UNAVAILABLE" });
      }
      if (locked.scope_fingerprint !== current.scope_fingerprint) {
        throw Object.assign(new Error("Remote resource scope changed during rediscovery"), { code: "BINDING_CONFIGURATION_CHANGED" });
      }
      const [generation] = await tx<{ discovery_generation: string | number }[]>`
        UPDATE mail.remote_resources
        SET discovery_generation = discovery_generation + 1, last_discovery_at = now()
        WHERE id = ${locked.remote_resource_id}::uuid
        RETURNING discovery_generation
      `;
      if (!generation) throw new Error("Remote discovery generation update returned no row");
      const discoveryGeneration = Number(generation.discovery_generation);
      const nextState: ProviderBinding["state"] = "active";
      await tx`
        UPDATE mail.provider_bindings
        SET
          state = ${nextState},
          authenticated_principal = ${verification.authenticatedPrincipal},
          capabilities = ${verification.capabilities}::jsonb,
          verification_evidence = ${{ ...evidence, comparisonReason: comparison.reason }}::jsonb,
          verified_scope_fingerprint = ${locked.scope_fingerprint},
          verified_secret_revision = ${snapshot.secretRevision},
          last_verified_at = now(),
          last_error_code = NULL,
          last_error_message = NULL
        WHERE id = ${params.bindingId}::uuid
      `;
      await tx`
        UPDATE mail.provider_connections
        SET
          status = 'active',
          authenticated_principal = ${verification.authenticatedPrincipal},
          capabilities = ${verification.capabilities}::jsonb,
          server_identity = ${verification.serverIdentity}::jsonb,
          last_verified_at = now(),
          last_error_code = NULL,
          last_error_message = NULL
        WHERE id = ${current.connection_id}::uuid
          AND secret_revision = ${snapshot.secretRevision}
          AND status <> 'revoked'
      `;
      const projection = await projectFolders({
        db: tx,
        remoteResourceId: locked.remote_resource_id,
        bindingId: params.bindingId,
        discoveryGeneration,
        evidence,
      });
      await tx`DELETE FROM mail.remote_namespaces WHERE binding_id = ${params.bindingId}::uuid`;
      if (evidence.namespaces.length > 0) {
        const namespaceRows = evidence.namespaces.map((namespace) => ({
          binding_id: params.bindingId,
          kind: namespace.kind,
          prefix: namespace.prefix,
          delimiter: namespace.delimiter,
        }));
        await tx`
          INSERT INTO mail.remote_namespaces ${sql(namespaceRows, "binding_id", "kind", "prefix", "delimiter")}
        `;
      }
      await tx`
        UPDATE mail.remote_resources
        SET status = 'active', last_error_code = NULL, last_error_message = NULL
        WHERE id = ${locked.remote_resource_id}::uuid
      `;
      const rightsSources: BindingRediscoveryResult["rightsSources"] = { acl: 0, select: 0, probe: 0, unknown: 0 };
      for (const folder of folders) rightsSources[folder.rightsSource] += 1;
      return {
        bindingId: params.bindingId,
        discoveryGeneration,
        state: nextState,
        ...projection,
        rightsSources,
      } satisfies BindingRediscoveryResult;
    });
    await updateMailboxBindingHealth(current.mailbox_id);
    return result;
  } catch (error) {
    if (!REDISCOVERY_SUPERSEDED_CODES.has(providerErrorCode(error, "PROVIDER_REDISCOVERY_FAILED"))) {
      await markRediscoveryFailure(params.bindingId, current.connection_id, current.secret_revision, expectedOAuthTokenRevision, error);
    }
    throw error;
  }
};

export const attachProviderBinding = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  connectionId: string;
}): Promise<Result<ProviderBinding>> => {
  const allowed = await requireMailboxPermission(params.context, params.mailboxId, "admin");
  if (!allowed.ok) return allowed;

  const connectionResult = await getProviderConnection(params.context, params.connectionId);
  if (!connectionResult.ok) return connectionResult;
  if (connectionResult.data.mailboxId !== params.mailboxId) return fail(err.badInput("Provider connection belongs to another mailbox"));

  try {
    const resourceIds = await listMailboxRemoteResourceIds(params.mailboxId);
    const barrier = await withMailboxProviderOperationBarrier(params.mailboxId, resourceIds, async (assertLeaseActive) => {
      if (!sameResourceIds(resourceIds, await listMailboxRemoteResourceIds(params.mailboxId))) {
        return fail(err.conflict("Mailbox provider bindings changed before verification; retry the operation"));
      }
      const currentConnection = await getProviderConnection(params.context, params.connectionId);
      if (!currentConnection.ok) return currentConnection;
      if (currentConnection.data.mailboxId !== params.mailboxId) {
        return fail(err.badInput("Provider connection belongs to another mailbox"));
      }

      let runtime: Awaited<ReturnType<typeof loadProviderConnectionRuntime>>;
      let verifiedSecretRevision: number;
      let verification: ConnectorVerification;
      let folders: RemoteFolder[];
      try {
        const snapshot = await loadProviderConnectionRuntimeSnapshot(params.connectionId);
        runtime = snapshot.runtime;
        verifiedSecretRevision = snapshot.secretRevision;
        await assertLeaseActive();
        [verification, folders] = await Promise.all([imapSmtpConnector.verify(runtime), imapSmtpConnector.discoverFolders(runtime)]);
        await assertLeaseActive();
      } catch (error) {
        if ((error as { code?: unknown } | null)?.code === "MAIL_PROVIDER_OPERATION_LEASE_LOST") throw error;
        return fail(err.badInput("Provider binding verification failed"));
      }
      if (folders.length === 0) return fail(err.badInput("The provider account contains no visible folders"));

      let evidence: ScopeEvidence;
      try {
        evidence = await buildScopeEvidence({ verification, folders, runtime });
      } catch {
        return fail(err.badInput("Remote resource fingerprint verification failed"));
      }
      const evidenceFingerprint = sha256(evidence);
      const account = verification.accounts[0];
      if (!account) return fail(err.badInput("The provider did not expose a remote account"));

      return sql.begin(async (tx) => {
        const [lockedMailbox] = await tx<{ id: string }[]>`
        SELECT id
        FROM mail.mailboxes
        WHERE id = ${params.mailboxId}::uuid AND deleted_at IS NULL
        FOR UPDATE
      `;
        if (!lockedMailbox) return fail(err.notFound("Mailbox"));
        const permission = await requireMailboxPermission(params.context, params.mailboxId, "admin", tx);
        if (!permission.ok) return permission;
        if (!sameResourceIds(resourceIds, await listMailboxRemoteResourceIds(params.mailboxId, tx))) {
          return fail(err.conflict("Mailbox provider bindings changed during verification; retry the operation"));
        }
        const [lockedConnection] = await tx<
          {
            status: string;
            secret_revision: number;
            owner_mailbox_id: string;
          }[]
        >`
        SELECT status, secret_revision, owner_mailbox_id
        FROM mail.provider_connections
        WHERE id = ${params.connectionId}::uuid
        FOR UPDATE
      `;
        if (!lockedConnection || lockedConnection.status !== "active") return fail(err.badInput("Provider connection is no longer active"));
        if (lockedConnection.owner_mailbox_id !== params.mailboxId) {
          return fail(err.badInput("Provider connection belongs to another mailbox"));
        }
        if (lockedConnection.secret_revision !== verifiedSecretRevision) {
          return fail(err.conflict("Provider credentials changed during remote verification"));
        }

        let [resource] = await tx<
          {
            id: string;
            scope_fingerprint: string;
            discovery_generation: string | number;
          }[]
        >`
        SELECT id, scope_fingerprint, discovery_generation
        FROM mail.remote_resources
        WHERE mailbox_id = ${params.mailboxId}::uuid
        FOR UPDATE
      `;
        let comparison: EvidenceComparison = { state: "verified", reason: "Initial verified provider binding" };

        if (!resource) {
          [resource] = await tx<
            {
              id: string;
              scope_fingerprint: string;
              discovery_generation: string | number;
            }[]
          >`
          INSERT INTO mail.remote_resources (
            mailbox_id,
            connector_kind,
            remote_locator,
            server_identity,
            scope_fingerprint,
            status,
            discovery_generation
          )
          VALUES (
            ${params.mailboxId}::uuid,
            'imap_smtp',
            ${{ accountId: account.id }}::jsonb,
            ${verification.serverIdentity}::jsonb,
            ${evidenceFingerprint},
            'active',
            1
          )
          RETURNING id, scope_fingerprint, discovery_generation
        `;
        } else {
          const [prior] = await tx<{ verification_evidence: ScopeEvidence | string }[]>`
          SELECT verification_evidence
          FROM mail.provider_bindings
          WHERE remote_resource_id = ${resource.id}::uuid
            AND verified_scope_fingerprint = ${resource.scope_fingerprint}
          ORDER BY (state = 'active') DESC, last_verified_at DESC NULLS LAST, created_at
          LIMIT 1
        `;
          if (!prior) return fail(err.internal("Remote resource has no trusted verification evidence"));
          const existingEvidence =
            typeof prior.verification_evidence === "string"
              ? (JSON.parse(prior.verification_evidence) as ScopeEvidence)
              : prior.verification_evidence;
          comparison = compareEvidence(existingEvidence, evidence);
          if (comparison.state === "different") return fail(err.badInput(comparison.reason));
          await tx`
          UPDATE mail.remote_resources
          SET discovery_generation = discovery_generation + 1
          WHERE id = ${resource.id}::uuid
          RETURNING discovery_generation
        `;
          resource.discovery_generation = Number(resource.discovery_generation) + 1;
        }
        if (!resource) throw new Error("Remote resource insert returned no row");

        const [binding] = await tx<DbBinding[]>`
        INSERT INTO mail.provider_bindings AS pb (
          remote_resource_id,
          connection_id,
          state,
          authenticated_principal,
          remote_locator,
          capabilities,
          rights,
          verification_evidence,
          verified_scope_fingerprint,
          verified_secret_revision,
          last_verified_at
        )
        VALUES (
          ${resource.id}::uuid,
          ${params.connectionId}::uuid,
          'active',
          ${verification.authenticatedPrincipal},
          ${{ accountId: account.id }}::jsonb,
          ${verification.capabilities}::jsonb,
          ${{}}::jsonb,
          ${{ ...evidence, comparisonReason: comparison.reason }}::jsonb,
          ${resource.scope_fingerprint},
          ${verifiedSecretRevision},
          now()
        )
        RETURNING
          pb.id,
          (SELECT mailbox_id FROM mail.remote_resources WHERE id = pb.remote_resource_id) AS mailbox_id,
          pb.connection_id,
          pb.state,
          pb.authenticated_principal,
          pb.remote_locator,
          pb.capabilities,
          pb.last_verified_at,
          pb.last_error_message,
          pb.created_at,
          pb.updated_at
      `;
        if (!binding) throw new Error("Provider binding insert returned no row");
        await tx`DELETE FROM mail.remote_namespaces WHERE binding_id = ${binding.id}::uuid`;

        await projectFolders({
          db: tx,
          remoteResourceId: resource.id,
          bindingId: binding.id,
          discoveryGeneration: Number(resource.discovery_generation),
          evidence,
        });
        if (evidence.namespaces.length > 0) {
          const namespaceRows = evidence.namespaces.map((namespace) => ({
            binding_id: binding.id,
            kind: namespace.kind,
            prefix: namespace.prefix,
            delimiter: namespace.delimiter,
          }));
          await tx`
          INSERT INTO mail.remote_namespaces ${sql(namespaceRows, "binding_id", "kind", "prefix", "delimiter")}
          ON CONFLICT (binding_id, kind, prefix) DO UPDATE SET delimiter = EXCLUDED.delimiter, discovered_at = now()
        `;
        }
        await tx`
        UPDATE mail.remote_resources
        SET status = 'active', last_error_code = NULL, last_error_message = NULL
        WHERE id = ${resource.id}::uuid
      `;
        await tx`
        UPDATE mail.mailboxes
        SET health = 'bootstrapping', health_reason = 'Initial synchronization pending'
        WHERE id = ${params.mailboxId}::uuid
      `;

        await audit.record(
          {
            action: "mail.provider_binding.attach",
            outcome: "allowed",
            actor: auditActorFromRequest(params.context),
            target: { type: "mailbox", id: params.mailboxId },
            requestId: params.context.requestId,
            metadata: {
              bindingId: binding.id,
              connectionId: params.connectionId,
              comparisonReason: comparison.reason,
            },
          },
          tx,
        );
        await assertLeaseActive();
        return ok(mapBinding(binding));
      });
    });
    return barrier.acquired ? barrier.value : fail(err.conflict("Provider work is still running; retry binding shortly"));
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === "MAIL_PROVIDER_OPERATION_LEASE_LOST") {
      return fail(err.conflict("Provider state changed during binding verification; retry the operation"));
    }
    if (isUniqueViolation(error)) return fail(err.conflict("Provider binding"));
    logDatabaseFailure(log.error, "attach", "provider binding", error);
    return fail(err.internal("Failed to attach provider binding"));
  }
};

export const listProviderBindings = async (context: MailRequestContext, mailboxId: string): Promise<Result<ProviderBinding[]>> => {
  const allowed = await requireMailboxPermission(context, mailboxId, "read");
  if (!allowed.ok) return allowed;
  const rows = await sql<DbBinding[]>`
    SELECT
      pb.id,
      rr.mailbox_id,
      pb.connection_id,
      pb.state,
      pb.authenticated_principal,
      pb.remote_locator,
      pb.capabilities,
      pb.last_verified_at,
      pb.last_error_message,
      pb.created_at,
      pb.updated_at
    FROM mail.provider_bindings pb
    JOIN mail.remote_resources rr ON rr.id = pb.remote_resource_id
    WHERE rr.mailbox_id = ${mailboxId}::uuid
    ORDER BY pb.created_at, pb.id
  `;
  return ok(rows.map(mapBinding));
};
