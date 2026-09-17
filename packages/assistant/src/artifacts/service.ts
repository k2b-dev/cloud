import { databaseConfigLock } from "./database-lock";
import { hasRole } from "@k2b/cloud/contracts";
import { sql, type SQL } from "bun";
import { z } from "zod";
import { AI_FILES_MAX_CONVERSATION_BYTES_DEFAULT, withAiShortIdForDb, CodeResourceId, aiConversations, aiProjects } from "@k2b/cloud/ai";
import {
  type AccessSubject, type AuthContext, type PermissionLevel, type Principal,
  buildAccessPrincipalCondition, createAccess, getAccess, deleteAccess, updateAccess,
  hasPermission, resolveDisplayNames, userFromActor, accessRevision,
} from "@k2b/cloud/server";
import { app } from "../config";
import { checkStorageBudget } from "./storage-budget";
import { StorageRequest, STORAGE_FILE_MAX_BYTES } from "./storage-contracts";
import { LIMITS, ArtifactKind, ArtifactMetadata, PublicationNote, ArtifactCreate, ArtifactFile, ArtifactPath, ArtifactSource, ArtifactUpdate } from "./contracts";
import { validateArtifact } from "./runtime/compile";

export type ArtifactIdentity = { actor: AuthContext["Variables"]["actor"]; accessSubject: AccessSubject; conversationId?: string; administrative?: boolean };
export class ArtifactError extends Error {
  constructor(readonly code: "NOT_FOUND" | "ACCESS_DENIED" | "CONFLICT" | "STORAGE_FULL" | "INVALID_INPUT" | "LAST_MANAGER" | "TOO_MANY_REQUESTS" | "PUBLIC_READ_ONLY") {
    super(code);
  }
}
type ArtifactRow = { storage_revision: number; short_id: string; forked_from_short_id?: string | null; kind: ArtifactKind; icon: string; published_icon: string | null; published_version: number | null; id: string; title: string; description?: string; revision: number; updated_at: Date; published_revision: number | null; published_title: string | null; published_description: string | null; forked_from_id: string | null; forked_from_revision: number | null };
export type ArtifactSummary = { kind: ArtifactKind; icon?: string; publishedVersion?: number | null; id: string; title: string; description?: string; revision: number; permission: PermissionLevel; updatedAt: string; publishedRevision: number | null; forkedFromId: string | null; forkedFromRevision: number | null };
export type ArtifactBundle = ArtifactSummary & { source: ArtifactSource; sourceRevision: number };
const summarize = (row: ArtifactRow, permission: PermissionLevel): ArtifactSummary => ({
  kind: row.kind, icon: permission === "admin" ? row.icon : row.published_icon ?? row.icon, publishedVersion: row.published_version,
  id: row.short_id, title: permission === "admin" ? row.title : row.published_title ?? row.title,
  description: (permission === "admin" ? row.description : row.published_description) ?? "",
  revision: permission === "admin" ? row.revision : row.published_revision!, permission, updatedAt: row.updated_at.toISOString(),
  publishedRevision: row.published_revision, forkedFromId: row.forked_from_short_id ?? null, forkedFromRevision: row.forked_from_revision,
});
export function user(identity: ArtifactIdentity) {
  const actor = userFromActor(identity.actor);
  if (!actor || identity.accessSubject.type !== "user" || identity.accessSubject.userId !== actor.id)
    throw new ArtifactError("ACCESS_DENIED");
  return actor;
}
function predicate(identity: ArtifactIdentity) {
  user(identity);
  const match = buildAccessPrincipalCondition({ subject: identity.accessSubject, columns: {
    userId: sql`a.user_id`, groupId: sql`a.group_id`, serviceAccountId: sql`a.service_account_id`,
    authenticatedOnly: sql`a.authenticated_only`,
  } });
  // Public grants allow the isolated runner only, never server-backed operations.
  return sql`(${match}) AND (a.user_id IS NOT NULL OR a.group_id IS NOT NULL OR a.service_account_id IS NOT NULL OR a.authenticated_only)`;
}
/** Resolve membership through the owning project service, without copying grants. */
async function accessibleLinkedProjects(db: SQL, subject: AccessSubject, artifactId?: string) {
  const links = await db<{ project_id: string }[]>`SELECT DISTINCT project_id FROM assistant.artifact_projects
    WHERE ${artifactId ? db`artifact_id=${artifactId}::uuid` : db`true`}`;
  return [...(await aiProjects.resolveShortIds(links.map(link => link.project_id), subject)).keys()];
}

export async function requireArtifact(db: SQL, id: string, identity: ArtifactIdentity, required: PermissionLevel) {
  CodeResourceId.parse(id);
  const match = predicate(identity);
  // Serialize authorization with changes to grants, revisions and deletion.
  const [row] = await db<ArtifactRow[]>`SELECT * FROM assistant.artifacts WHERE short_id=${id} FOR UPDATE`;
  if (!row) throw new ArtifactError("NOT_FOUND");
  id = row.id;
  const [grant] = await db<{ permission: PermissionLevel }[]>`SELECT a.permission
    FROM auth.access a JOIN assistant.artifact_access link ON link.access_id=a.id
    WHERE link.artifact_id=${id}::uuid AND ${match}
    ORDER BY CASE a.permission WHEN 'admin' THEN 3 WHEN 'write' THEN 2 WHEN 'read' THEN 1 ELSE 0 END DESC LIMIT 1`;
  let permission = identity.administrative && hasRole(user(identity),"admin") ? "admin" as const : grant?.permission ?? "none";
  if (!hasPermission(permission, required) && required === "read" && row.published_revision !== null) {
    if ((await accessibleLinkedProjects(db, identity.accessSubject, id)).length) permission = "read";
  }
  if (!hasPermission(permission, required)) throw new ArtifactError("ACCESS_DENIED");
  if (permission !== "admin" && row.published_revision === null) throw new ArtifactError("NOT_FOUND");
  return { row, permission };
}
async function revision(db: SQL, row: ArtifactRow, permission: PermissionLevel, sourceRevision = row.revision): Promise<ArtifactBundle> {
  const [stored] = await db<{ source: unknown }[]>`SELECT source FROM assistant.artifact_revisions
    WHERE artifact_id=${row.id}::uuid AND revision=${sourceRevision}`;
  if (!stored) throw new ArtifactError("NOT_FOUND");
  const source = typeof stored.source === "string" ? JSON.parse(stored.source) : stored.source;
  const [origin] = row.forked_from_id ? await db<{short_id: string}[]>`SELECT short_id FROM assistant.artifacts WHERE id=${row.forked_from_id}::uuid` : [];
  return { ...summarize(row, permission), forkedFromId: origin?.short_id ?? null, source: ArtifactSource.parse(source), sourceRevision };
}
async function writeRevision(db: SQL, id: string, number: number, source: ArtifactSource) {
  const encoded = JSON.stringify(source);
  const size = new TextEncoder().encode(encoded).byteLength;
  const [stored] = await db<{ total: number }[]>`SELECT coalesce(sum(source_bytes),0)::bigint AS total
    FROM assistant.artifact_revisions WHERE artifact_id=${id}::uuid`;
  // Reclaim oldest unpublished history only when the existing source budget is full.
  // The caller holds the artifact lock; pruning and the new revision commit together.
  const excess = Number(stored?.total ?? 0) + size - AI_FILES_MAX_CONVERSATION_BYTES_DEFAULT;
  if (excess > 0) {
    const candidates = await db<{ revision: number; source_bytes: number }[]>`SELECT r.revision,r.source_bytes
      FROM assistant.artifact_revisions r JOIN assistant.artifacts a ON a.id=r.artifact_id
      WHERE r.artifact_id=${id}::uuid AND r.revision<>a.revision
      AND NOT EXISTS (SELECT 1 FROM assistant.artifact_publications p WHERE p.artifact_id=r.artifact_id AND p.revision=r.revision)
      ORDER BY r.revision`;
    const remove: number[] = [];
    let reclaimed = 0;
    for (const candidate of candidates) {
      if (reclaimed >= excess) break;
      remove.push(candidate.revision);
      reclaimed += Number(candidate.source_bytes);
    }
    // Published versions are never silently removed to make room.
    if (reclaimed < excess) throw new ArtifactError("STORAGE_FULL");
    await db`DELETE FROM assistant.artifact_revisions WHERE artifact_id=${id}::uuid AND revision IN ${db(remove)}`;
  }
  await db`INSERT INTO assistant.artifact_revisions(artifact_id,revision,source,source_bytes)
    VALUES(${id}::uuid,${number},(${encoded}::text)::jsonb,${size})`;
}

async function checkAccessRevision(db: SQL, id: string, expected: string | undefined) {
  if (expected === undefined) return;
  const links = await db<{ access_id: string }[]>`SELECT access_id FROM assistant.artifact_access WHERE artifact_id=${id}::uuid`;
  const entries = await Promise.all(links.map(link => getAccess({ id: link.access_id }, db)));
  if (accessRevision(entries.filter(entry => entry !== null)) !== expected) throw new ArtifactError("CONFLICT");
}

async function managementState(db: SQL, row: ArtifactRow) {
  const [storage] = await db<{ files: number; kv: number }[]>`SELECT count(*) FILTER (WHERE area='files')::int AS files,count(*) FILTER (WHERE area='kv')::int AS kv FROM assistant.artifact_storage WHERE artifact_id=${row.id}::uuid`;
  const [database] = await db<{ namespace: string; data_revision: string; connected: boolean }[]>`SELECT namespace,data_revision,connected FROM assistant.artifact_databases WHERE artifact_id=${row.id}::uuid`;
  const grants = await db<{ access_id: string }[]>`SELECT access_id FROM assistant.artifact_access WHERE artifact_id=${row.id}::uuid ORDER BY access_id`;
  const entries = await Promise.all(grants.map(grant => getAccess({ id: grant.access_id }, db)));
  const projects = await db<{ project_id: string }[]>`SELECT project_id FROM assistant.artifact_projects WHERE artifact_id=${row.id}::uuid ORDER BY project_id`;
  const state = { id: row.short_id, title: row.title, revision: row.revision, publishedVersion: row.published_version,
    storageRevision: Number(row.storage_revision), files: storage!.files, kv: storage!.kv, databaseConnected: database?.connected ?? false };
  const managementRevision = new Bun.CryptoHasher("sha256").update(JSON.stringify({ state, description: row.description, icon: row.icon,
    database, projects, access: accessRevision(entries.filter(entry => entry !== null)) })).digest("hex");
  return { ...state, managementRevision };
}

export const artifacts = {
  /** The runner always receives the current publication, even for an App administrator. */
  async runner(id: string, identity: { actor?: ArtifactIdentity["actor"]; accessSubject?: AccessSubject }) {
    CodeResourceId.parse(id);
    return sql.begin(async db => {
      let authorized: Awaited<ReturnType<typeof requireArtifact>> | undefined;
      if (identity.actor && userFromActor(identity.actor) && identity.accessSubject?.type === "user") {
        try { authorized = await requireArtifact(db, id, { actor: identity.actor, accessSubject: identity.accessSubject }, "read"); }
        catch (error) { if (!(error instanceof ArtifactError) || error.code !== "ACCESS_DENIED") throw error; }
      }
      const [row] = authorized ? [authorized.row] : await db<ArtifactRow[]>`
        SELECT artifact.* FROM assistant.artifacts artifact
        WHERE short_id=${id} AND EXISTS (
          SELECT 1 FROM assistant.artifact_access link JOIN auth.access a ON a.id=link.access_id
          WHERE link.artifact_id=artifact.id AND a.permission='read'
            AND a.user_id IS NULL AND a.group_id IS NULL AND a.service_account_id IS NULL AND NOT a.authenticated_only
        ) FOR UPDATE`;
      if (!row || row.published_revision === null) throw new ArtifactError("NOT_FOUND");
      // Read metadata comes from the publication; never leak unpublished names or source.
      const bundle = await revision(db, row, "read", row.published_revision);
      return { ...bundle, serverAccess: !!authorized, canManage: authorized?.permission === "admin" };
    });
  },
  async managementState(id: string, identity: ArtifactIdentity) {
    return sql.begin(async db => managementState(db, (await requireArtifact(db, id, identity, "admin")).row));
  },
  async remove(id: string, identity: ArtifactIdentity, expectedManagementRevision?: string) {
    return sql.begin(async db => {
      await databaseConfigLock(db);
      const { row } = await requireArtifact(db, id,identity,"admin");
      id = row.id;
      if (expectedManagementRevision !== undefined && (await managementState(db, row)).managementRevision !== expectedManagementRevision) throw new ArtifactError("CONFLICT");
      const cleanup = await db`INSERT INTO assistant.database_cleanup(namespace)
        SELECT namespace FROM assistant.artifact_databases WHERE artifact_id=${id}::uuid ON CONFLICT DO NOTHING RETURNING namespace`;
      await db`DELETE FROM auth.access WHERE id IN (SELECT access_id FROM assistant.artifact_access WHERE artifact_id=${id}::uuid)`;
      await db`DELETE FROM assistant.artifacts WHERE id=${id}::uuid`;
      return {deleted:true,databaseCleanupQueued:cleanup.length>0};
    });
  },
  async describe(ids: string[], userId: string, _conversationId?: string): Promise<Array<ArtifactSummary & { description: string; icon: string }>> {
    if (!ids.length) return [];
    const valid = ids.filter(id => CodeResourceId.safeParse(id).success);
    if (!valid.length) return [];
    const projects = await accessibleLinkedProjects(sql, { type: "user", userId });
    const projectMatch = projects.length ? sql`project.project_id IN ${sql(projects)}` : sql`false`;
    const match = buildAccessPrincipalCondition({ subject: { type: "user", userId }, columns: {
      userId: sql`a.user_id`, groupId: sql`a.group_id`, serviceAccountId: sql`a.service_account_id`, authenticatedOnly: sql`a.authenticated_only`,
    } });
    return sql<(ArtifactSummary & { description: string; icon: string })[]>`SELECT artifact.short_id AS id, artifact.kind,
      CASE WHEN bool_or(a.permission='admin') THEN artifact.revision ELSE artifact.published_revision END AS revision,
      artifact.published_version AS "publishedVersion",
      artifact.published_revision AS "publishedRevision", artifact.updated_at::text AS "updatedAt",
      NULL AS "forkedFromId", NULL AS "forkedFromRevision",
      CASE WHEN bool_or(a.permission='admin') THEN 'admin' ELSE 'read' END AS permission,
      CASE WHEN bool_or(a.permission='admin') THEN artifact.icon ELSE artifact.published_icon END AS icon,
      CASE WHEN bool_or(a.permission='admin') THEN artifact.title ELSE artifact.published_title END AS title,
      CASE WHEN bool_or(a.permission='admin') THEN artifact.description ELSE artifact.published_description END AS description FROM assistant.artifacts artifact
      LEFT JOIN assistant.artifact_access link ON link.artifact_id=artifact.id
      LEFT JOIN auth.access a ON a.id=link.access_id AND ${match} AND a.permission IN ('read','write','admin')
      WHERE artifact.short_id IN ${sql(valid)}
      GROUP BY artifact.id HAVING bool_or(a.permission='admin') OR (artifact.published_revision IS NOT NULL AND
        (count(a.id)>0 OR (EXISTS(SELECT 1 FROM assistant.artifact_projects project
          WHERE project.artifact_id=artifact.id AND ${projectMatch}))))`;
  },
  async list(identity: ArtifactIdentity, page = 1, search = "", pageSize = 30) {
    z.number().int().min(1).max(100000).parse(page);
    z.string().max(500).parse(search);
    z.number().int().min(1).max(100).parse(pageSize);
    const match = predicate(identity);
    const projects = await accessibleLinkedProjects(sql, identity.accessSubject);
    const projectMatch = projects.length ? sql`project.project_id IN ${sql(projects)}` : sql`false`;
    const rows = await sql<(ArtifactRow & { permission: PermissionLevel })[]>`SELECT p.*, (SELECT origin.short_id FROM assistant.artifacts origin WHERE origin.id=p.forked_from_id) AS forked_from_short_id,
      CASE max(CASE a.permission WHEN 'admin' THEN 3 WHEN 'write' THEN 2 ELSE 1 END)
      WHEN 3 THEN 'admin' WHEN 2 THEN 'write' ELSE 'read' END AS permission
      FROM assistant.artifacts p LEFT JOIN assistant.artifact_access link ON link.artifact_id=p.id
      LEFT JOIN auth.access a ON a.id=link.access_id AND ${match} AND a.permission IN ('read','write','admin')
      GROUP BY p.id HAVING (bool_or(a.permission='admin') OR (p.published_revision IS NOT NULL AND
        (count(a.id)>0 OR (EXISTS(SELECT 1 FROM assistant.artifact_projects project
          WHERE project.artifact_id=p.id AND ${projectMatch})))))
      AND strpos(lower(CASE WHEN bool_or(a.permission='admin') THEN p.title || ' ' || p.description
        ELSE coalesce(p.published_title,'') || ' ' || coalesce(p.published_description,'') END),lower(${search}))>0
      ORDER BY p.updated_at DESC,p.id LIMIT ${pageSize + 1} OFFSET ${(page - 1) * pageSize}`;
    return { items: rows.slice(0,pageSize).map((row) => summarize(row,row.permission)), hasNext: rows.length > pageSize, page };
  },
  async get(id: string, identity: ArtifactIdentity, sourceRevision?: number, published = false, version?: number): Promise<ArtifactBundle> {
    if (sourceRevision !== undefined) z.number().int().positive().parse(sourceRevision);
    return sql.begin(async (db) => {
      const { row, permission } = await requireArtifact(db,id,identity,"read");
      id = row.id;
      if (version !== undefined) {
        z.number().int().positive().parse(version);
        if (permission !== "admin") throw new ArtifactError("ACCESS_DENIED");
        const [release] = await db`SELECT * FROM assistant.artifact_publications WHERE artifact_id=${id}::uuid AND version=${version}`;
        if (!release) throw new ArtifactError("NOT_FOUND");
        return revision(db, { ...row, title: release.title, description: release.description, icon: release.icon }, permission, release.revision);
      }
      if (published && row.published_revision === null) throw new ArtifactError("NOT_FOUND");
      if (permission !== "admin" && sourceRevision !== undefined && sourceRevision !== row.published_revision)
        throw new ArtifactError("ACCESS_DENIED");
      return revision(db,row,permission, published || permission !== "admin" ? row.published_revision! : sourceRevision);
    });
  },
  async create(input: unknown, identity: ArtifactIdentity): Promise<ArtifactBundle> {
    const actor = user(identity);
    const parsed = ArtifactCreate.parse(input);
    return sql.begin(async (db) => {
      const [row] = await withAiShortIdForDb(db, "assistant_artifacts_short_id_key", (tx, shortId) => tx<ArtifactRow[]>`INSERT INTO assistant.artifacts(short_id,kind,title,description,icon) VALUES(${shortId},${parsed.kind},${parsed.title},${parsed.description ?? ""},${parsed.icon ?? "ti ti-app-window"}) RETURNING *`);
      if (!row) throw new ArtifactError("NOT_FOUND");
      const access = await createAccess({ principal: { type: "user", userId: actor.id }, permission: "admin" },db);
      if (!access.ok) throw new ArtifactError("INVALID_INPUT");
      await db`INSERT INTO assistant.artifact_access VALUES(${row.id}::uuid,${access.data.id}::uuid)`;
      await writeRevision(db,row.id,1,parsed.source);
      return revision(db,row,"admin");
    });
  },
  async update(id: string, input: unknown, identity: ArtifactIdentity): Promise<ArtifactBundle> {
    const parsed = ArtifactUpdate.parse(input);
    return sql.begin(async (db) => {
      const { row, permission } = await requireArtifact(db,id,identity,"admin");
      id = row.id;
      if (row.revision !== parsed.expectedRevision) throw new ArtifactError("CONFLICT");
      await writeRevision(db,id,row.revision + 1,parsed.source);
      const [updated] = await db<ArtifactRow[]>`UPDATE assistant.artifacts SET title=${parsed.title}, icon=${parsed.icon ?? row.icon}, description=${parsed.description ?? row.description ?? ""},
        revision=revision+1,updated_at=now() WHERE id=${id}::uuid RETURNING *`;
      return revision(db,updated!,permission);
    });
  },
  async writeFile(id: string, path: string, content: string | null, identity: ArtifactIdentity): Promise<ArtifactBundle> {
    ArtifactPath.parse(path);
    if (content !== null) ArtifactFile.parse({ path, content });
    return sql.begin(async (db) => {
      const { row, permission } = await requireArtifact(db, id, identity, "admin");
      id = row.id;
      const current = await revision(db, row, permission);
      const files = new Map(current.source.files.map((file) => [file.path, file]));
      if (content === null) files.delete(path);
      else files.set(path, { path, content });
      const source = ArtifactSource.parse({ ...current.source, files: [...files.values()] });
      await writeRevision(db, id, row.revision + 1, source);
      const [updated] = await db<ArtifactRow[]>`UPDATE assistant.artifacts SET revision=revision+1,updated_at=now()
        WHERE id=${id}::uuid RETURNING *`;
      return revision(db, updated!, permission);
    });
  },
  async writeFiles(id: string, input: { expectedRevision: number; entry?: string; files: { path: string; content: string }[] }, identity: ArtifactIdentity): Promise<ArtifactBundle> {
    z.number().int().positive().parse(input.expectedRevision);
    z.array(ArtifactFile).min(1).max(LIMITS.files).parse(input.files);
    if (new Set(input.files.map(file => file.path)).size !== input.files.length) throw new ArtifactError("INVALID_INPUT");
    return sql.begin(async db => {
      const { row, permission } = await requireArtifact(db, id, identity, "admin");
      id = row.id;
      if (row.revision !== input.expectedRevision) throw new ArtifactError("CONFLICT");
      const current = await revision(db, row, permission);
      const files = new Map(current.source.files.map(file => [file.path, file]));
      for (const file of input.files) files.set(file.path, file);
      const source = ArtifactSource.parse({ entry: input.entry ?? current.source.entry, files: [...files.values()] });
      await writeRevision(db, id, row.revision + 1, source);
      const [updated] = await db<ArtifactRow[]>`UPDATE assistant.artifacts SET revision=revision+1,updated_at=now() WHERE id=${id}::uuid RETURNING *`;
      return revision(db, updated!, permission);
    });
  },
  async history(id: string, identity: ArtifactIdentity, page = 1) {
    z.number().int().min(1).max(100000).parse(page);
    return sql.begin(async (db) => {
      id = (await requireArtifact(db, id,identity,"admin")).row.id;
      const rows = await db<{ revision: number; created_at: Date }[]>`SELECT revision,created_at
        FROM assistant.artifact_revisions WHERE artifact_id=${id}::uuid ORDER BY revision DESC LIMIT 31 OFFSET ${(page - 1) * 30}`;
      return { items: rows.slice(0,30).map((row) => ({ revision: row.revision, createdAt: row.created_at.toISOString() })), hasNext: rows.length > 30, page };
    });
  },
  async access(id: string, identity: ArtifactIdentity) {
    return sql.begin(async (db) => {
      id = (await requireArtifact(db, id,identity,"admin")).row.id;
      const links = await db<{ access_id: string }[]>`SELECT access_id FROM assistant.artifact_access WHERE artifact_id=${id}::uuid`;
      const grants = await Promise.all(links.map((link) => getAccess({ id: link.access_id },db)));
      return resolveDisplayNames(grants.filter((grant) => grant !== null));
    });
  },
  async grant(id: string, principal: Principal, level: "read" | "admin", identity: ArtifactIdentity, expectedAccessRevision?: string) {
    z.enum(["read", "admin"]).parse(level);
    if (principal.type === "public" && level !== "read") throw new ArtifactError("PUBLIC_READ_ONLY");
    if (principal.type === "service_account") throw new ArtifactError("INVALID_INPUT");
    return sql.begin(async (db) => {
      id = (await requireArtifact(db, id,identity,"admin")).row.id;
      await checkAccessRevision(db, id, expectedAccessRevision);
      const access = await createAccess({ principal, permission: level },db);
      if (!access.ok) throw new ArtifactError("INVALID_INPUT");
      await db`INSERT INTO assistant.artifact_access VALUES(${id}::uuid,${access.data.id}::uuid)`;
      return getAccess({ id: access.data.id },db);
    });
  },
  async changeGrant(id: string, accessId: string, level: "read" | "admin" | null, identity: ArtifactIdentity, expectedAccessRevision?: string) {
    z.enum(["read", "admin"]).nullable().parse(level);
    z.uuid().parse(accessId);
    return sql.begin(async (db) => {
      id = (await requireArtifact(db, id,identity,"admin")).row.id;
      await checkAccessRevision(db, id, expectedAccessRevision);
      const [grant] = await db<{ permission: PermissionLevel; public: boolean }[]>`SELECT a.permission,
        (a.user_id IS NULL AND a.group_id IS NULL AND a.service_account_id IS NULL AND NOT a.authenticated_only) AS public FROM auth.access a
        JOIN assistant.artifact_access link ON link.access_id=a.id WHERE link.artifact_id=${id}::uuid AND a.id=${accessId}::uuid`;
      if (!grant) throw new ArtifactError("NOT_FOUND");
      if (grant.public && level !== null && level !== "read") throw new ArtifactError("PUBLIC_READ_ONLY");
      if (grant.permission === "admin" && level !== "admin") {
        const [count] = await db<{ n: number }[]>`SELECT count(*)::int AS n FROM auth.access a
          JOIN assistant.artifact_access link ON link.access_id=a.id WHERE link.artifact_id=${id}::uuid AND a.permission='admin'`;
        if (count!.n <= 1) throw new ArtifactError("LAST_MANAGER");
      }
      if (level) await updateAccess({ id: accessId, permission: level },db);
      else await deleteAccess({ id: accessId },db);
      return { updated: true };
    });
  },
  async publish(id: string, expectedRevision: number, identity: ArtifactIdentity, note: string) {
    PublicationNote.parse(note);
    const draft = await artifacts.get(id, identity);
    if (draft.permission !== "admin") throw new ArtifactError("ACCESS_DENIED");
    await validateArtifact(draft.source);
    return sql.begin(async db => {
      const { row } = await requireArtifact(db, id, identity, "admin");
      id = row.id;
      if (row.revision !== expectedRevision || draft.revision !== expectedRevision) throw new ArtifactError("CONFLICT");
      const [next] = await db<{ version: number }[]>`SELECT coalesce(max(version),0)+1 AS version FROM assistant.artifact_publications WHERE artifact_id=${id}::uuid`;
      const version = next!.version;
      await db`INSERT INTO assistant.artifact_publications(artifact_id,version,revision,title,description,icon,note,author_id)
        VALUES(${id}::uuid,${version},${row.revision},${row.title},${row.description ?? ""},${row.icon},${note.trim()},${user(identity).id}::uuid)`;
      await db`UPDATE assistant.artifacts SET published_revision=revision,published_title=title,
        published_description=description,published_icon=icon,published_version=${version} WHERE id=${id}::uuid`;
      return { publishedRevision: row.revision, publishedVersion: version };
    });
  },
  async storageState(id: string, identity: ArtifactIdentity) {
    return sql.begin(async db => {
      const { row } = await requireArtifact(db, id, identity, "admin");
      const areas = await db<{ area: "files" | "kv"; items: number; bytes: number }[]>`SELECT area,count(*)::int AS items,coalesce(sum(bytes),0)::bigint AS bytes
        FROM assistant.artifact_storage WHERE artifact_id=${row.id}::uuid GROUP BY area ORDER BY area`;
      return { id: row.short_id, title: row.title, storageRevision: Number(row.storage_revision), areas: areas.map(area => ({ ...area, bytes: Number(area.bytes) })) };
    });
  },
  async clearStorage(id: string, area: "files" | "kv" | "all", identity: ArtifactIdentity, expectedStorageRevision?: number) {
    z.enum(["files", "kv", "all"]).parse(area);
    return sql.begin(async db => {
      const { row } = await requireArtifact(db, id,identity,"admin");
      id = row.id;
      if (expectedStorageRevision !== undefined && Number(row.storage_revision) !== expectedStorageRevision) throw new ArtifactError("CONFLICT");
      await db`UPDATE assistant.artifacts SET storage_revision=storage_revision+1 WHERE id=${id}::uuid`;
      await db`DELETE FROM assistant.artifact_storage WHERE artifact_id=${id}::uuid AND (${area} = 'all' OR area=${area})`;
      return {cleared:true};
    });
  },
  async storageFileLimit(id: string, key: string, identity: ArtifactIdentity, management = false) {
    const previous=await sql.begin(async db=>{
      const resource=await requireArtifact(db,id,identity,management ? "admin" : "read");
      const [file]=await db<{bytes:number}[]>`SELECT bytes FROM assistant.artifact_storage
        WHERE artifact_id=${resource.row.id}::uuid AND area='files' AND key=${key}`;
      return Number(file?.bytes ?? 0);
    });
    const maximum=Math.min(STORAGE_FILE_MAX_BYTES,Math.max(previous,Number(await app.settings.get("assistant.storage_file_mib"))*1024*1024));
    if (!Number.isSafeInteger(maximum) || maximum < 1) throw new ArtifactError("INVALID_INPUT");
    return maximum;
  },
  async storage(id: string, input: unknown, identity: ArtifactIdentity, management = false, fileData?: Uint8Array, expected?: { storageRevision?: number; version?: number | null }) {
    const request = StorageRequest.parse(input);
    if (request.operation !== "list" && !request.key) throw new ArtifactError("INVALID_INPUT");
    let bytes = 0;
    if (request.operation === "write") {
      if (request.content === undefined && fileData === undefined) throw new ArtifactError("INVALID_INPUT");
      if (request.area === "kv") {
        try { JSON.parse(request.content!); } catch { throw new ArtifactError("INVALID_INPUT"); }
        bytes = new TextEncoder().encode(request.content).byteLength;
      } else {
        if (!fileData || fileData.byteLength > STORAGE_FILE_MAX_BYTES) throw new ArtifactError("INVALID_INPUT");
        bytes = fileData.byteLength;
      }
    }
    const limits = request.operation === "write" && request.area === "files"
      ? { total: Number(await app.settings.get("assistant.storage_total_mib")) * 1024 * 1024,
          file: Number(await app.settings.get("assistant.storage_file_mib")) * 1024 * 1024 }
      : { total: LIMITS.rpcBytes, file: LIMITS.rpcBytes };
    return sql.begin(async db => {
      // App use includes its runtime data effects. Code administration remains
      // separate. Lock the resource so quota checks and writes serialize.
      const { row } = await requireArtifact(db, id,identity,management ? "admin" : "read");
      id = row.id;
      if (expected?.storageRevision !== undefined && Number(row.storage_revision) !== expected.storageRevision) throw new ArtifactError("CONFLICT");
      if (expected?.version !== undefined) {
        const [current] = await db<{ version: number }[]>`SELECT version FROM assistant.artifact_storage WHERE artifact_id=${id}::uuid AND area=${request.area} AND key=${request.key!}`;
        if ((current ? Number(current.version) : null) !== expected.version) throw new ArtifactError("CONFLICT");
      }
      if (request.operation === "list") {
        const items = await db<{key:string;bytes:number;mediaType:string;version:number}[]>`SELECT key,bytes,version,media_type AS "mediaType"
          FROM assistant.artifact_storage WHERE artifact_id=${id}::uuid AND area=${request.area} AND key > ${request.after} ORDER BY key LIMIT ${request.limit}`;
        return {items: items.map(item => ({ ...item, bytes: Number(item.bytes), version: Number(item.version) }))};
      }
      if (request.operation === "delete") {
        await db`UPDATE assistant.artifacts SET storage_revision=storage_revision+1 WHERE id=${id}::uuid`;
        await db`DELETE FROM assistant.artifact_storage WHERE artifact_id=${id}::uuid AND area=${request.area} AND key=${request.key!}`;
        return {deleted:true};
      }
      if (request.operation === "write") {
        const [usage] = await db<{bytes:number;items:number;previous:number}[]>`SELECT
          coalesce(sum(bytes),0)::bigint AS bytes,count(*)::int AS items,
          coalesce(max(bytes) FILTER (WHERE key=${request.key!}),0)::bigint AS previous
          FROM assistant.artifact_storage WHERE artifact_id=${id}::uuid AND area=${request.area}`;
        const [existing] = await db`SELECT 1 FROM assistant.artifact_storage
          WHERE artifact_id=${id}::uuid AND area=${request.area} AND key=${request.key!}`;
        if (!checkStorageBudget({ area: request.area, bytes, total: Number(usage!.bytes), previous: Number(usage!.previous),
          items: Number(usage!.items), exists: Boolean(existing), limits })) throw new ArtifactError("STORAGE_FULL");
        const version = Number(row.storage_revision) + 1;
        await db`UPDATE assistant.artifacts SET storage_revision=${version} WHERE id=${id}::uuid`;
        await db`INSERT INTO assistant.artifact_storage(artifact_id,area,key,content,data,media_type,bytes,version)
          VALUES(${id}::uuid,${request.area},${request.key!},${request.content ?? ""},${fileData ?? null},${request.mediaType},${bytes},${version})
          ON CONFLICT(artifact_id,area,key) DO UPDATE SET content=excluded.content,data=excluded.data,media_type=excluded.media_type,bytes=excluded.bytes,version=excluded.version,updated_at=now()`;
        return {written:true, version};
      }
      const [item] = await db<{content:string;mediaType:string;data:Uint8Array|null;version:number}[]>`SELECT content,data,version,media_type AS "mediaType"
        FROM assistant.artifact_storage WHERE artifact_id=${id}::uuid AND area=${request.area} AND key=${request.key!}`;
      return {item:item ? {...item, version: Number(item.version)} : null};
    });
  },
  async projects(id: string, identity: ArtifactIdentity) {
    return sql.begin(async db => {
      id = (await requireArtifact(db, id,identity,"admin")).row.id;
      const links = await db<{projectId:string}[]>`SELECT project_id AS "projectId" FROM assistant.artifact_projects WHERE artifact_id=${id}::uuid ORDER BY project_id`;
      const result: Array<{ projectId: string; shortId: string | null; name: string | null }> = [];
      for (const link of links) {
        const project = await aiProjects.get(link.projectId, identity.accessSubject, "read");
        result.push({ ...link, shortId: project?.shortId ?? null, name: project?.name ?? null });
      }
      return result;
    });
  },
  async projectApps(projectReference: string, identity: ArtifactIdentity, page = 1, search = "", available = false) {
    z.string().min(1).max(80).parse(projectReference);
    z.number().int().min(1).max(100000).parse(page);
    z.string().max(500).parse(search);
    const required = available ? "admin" : "read";
    const project = z.uuid().safeParse(projectReference).success
      ? await aiProjects.get(projectReference, identity.accessSubject, required)
      : await aiProjects.getByShortId(projectReference, identity.accessSubject, required);
    if (!project) throw new ArtifactError("ACCESS_DENIED");
    const match = predicate(identity);
    const rows = await sql<{ id: string; title: string; icon: string; published: boolean; canManage: boolean; linked: boolean }[]>`
      WITH candidates AS (
        SELECT p.short_id AS id, p.updated_at,
          CASE WHEN coalesce(bool_or(a.permission='admin'),false) THEN p.title ELSE p.published_title END AS title,
          CASE WHEN coalesce(bool_or(a.permission='admin'),false) THEN p.icon ELSE p.published_icon END AS icon,
          p.published_revision IS NOT NULL AS published,
          coalesce(bool_or(a.permission='admin'),false) AS "canManage",
          EXISTS(SELECT 1 FROM assistant.artifact_projects l WHERE l.artifact_id=p.id AND l.project_id=${project.id}::uuid) AS linked
        FROM assistant.artifacts p
        LEFT JOIN assistant.artifact_access link ON link.artifact_id=p.id
        LEFT JOIN auth.access a ON a.id=link.access_id AND ${match}
        GROUP BY p.id
      ) SELECT id,title,coalesce(icon,'ti ti-app-window') AS icon,published,"canManage",linked FROM candidates
      WHERE (${available} AND "canManage" AND NOT linked OR NOT ${available} AND linked AND (published OR "canManage"))
        AND strpos(lower(title),lower(${search}))>0
      ORDER BY updated_at DESC,id LIMIT 31 OFFSET ${(page-1)*30}`;
    return { items: rows.slice(0,30), hasNext: rows.length>30, page };
  },
  async linkProject(id: string, projectReference: string, linked: boolean, identity: ArtifactIdentity) {
    z.string().min(1).max(80).parse(projectReference);
    const project = z.uuid().safeParse(projectReference).success
      ? await aiProjects.get(projectReference,identity.accessSubject,"admin")
      : await aiProjects.getByShortId(projectReference,identity.accessSubject,"admin");
    if (!project) throw new ArtifactError("ACCESS_DENIED");
    const projectId = project.id;
    return sql.begin(async db => {
      const {row} = await requireArtifact(db,id,identity,"admin");
      id = row.id;
      if (linked) await db`INSERT INTO assistant.artifact_projects(artifact_id,project_id) VALUES(${id}::uuid,${projectId}::uuid) ON CONFLICT DO NOTHING`;
      else await db`DELETE FROM assistant.artifact_projects WHERE artifact_id=${id}::uuid AND project_id=${projectId}::uuid`;
      return {linked};
    });
  },
  async metadata(id: string, input: unknown, identity: ArtifactIdentity) {
    const patch = ArtifactMetadata.parse(input);
    return sql.begin(async db => {
      const { row, permission } = await requireArtifact(db,id,identity,"admin");
      id = row.id;
      const current = await revision(db,row,permission);
      await writeRevision(db,id,row.revision+1,current.source);
      const [updated] = await db<ArtifactRow[]>`UPDATE assistant.artifacts SET title=${patch.title ?? row.title},
        description=${patch.description ?? row.description ?? ""},icon=${patch.icon ?? row.icon},revision=revision+1,updated_at=now()
        WHERE id=${id}::uuid RETURNING *`;
      return revision(db,updated!,permission);
    });
  },
  async versions(id: string, identity: ArtifactIdentity, page = 1) {
    z.number().int().min(1).max(100000).parse(page);
    return sql.begin(async db => {
      id = (await requireArtifact(db, id,identity,"admin")).row.id;
      const rows = await db<{version: number; revision: number; note: string; authorId: string | null; createdAt: Date}[]>`
        SELECT version,revision,note,author_id AS "authorId",created_at AS "createdAt" FROM assistant.artifact_publications
        WHERE artifact_id=${id}::uuid ORDER BY version DESC LIMIT 31 OFFSET ${(page-1)*30}`;
      return { items: rows.slice(0,30), page, hasNext: rows.length>30 };
    });
  },
  async restore(id: string, version: number, expectedRevision: number, identity: ArtifactIdentity) {
    z.number().int().positive().parse(version);
    return sql.begin(async db => {
      const {row,permission} = await requireArtifact(db,id,identity,"admin");
      id = row.id;
      if (row.revision !== expectedRevision) throw new ArtifactError("CONFLICT");
      const [release] = await db`SELECT * FROM assistant.artifact_publications WHERE artifact_id=${id}::uuid AND version=${version}`;
      if (!release) throw new ArtifactError("NOT_FOUND");
      const previous = await revision(db,row,permission,release.revision);
      await writeRevision(db,id,row.revision+1,previous.source);
      const [next] = await db<{ version: number }[]>`SELECT coalesce(max(version),0)+1 AS version FROM assistant.artifact_publications WHERE artifact_id=${id}::uuid`;
      const publishedVersion = next!.version;
      await db`INSERT INTO assistant.artifact_publications(artifact_id,version,revision,title,description,icon,note,author_id)
        VALUES(${id}::uuid,${publishedVersion},${row.revision+1},${release.title},${release.description},${release.icon},${`Restore version ${version}`},${user(identity).id}::uuid)`;
      const [updated] = await db<ArtifactRow[]>`UPDATE assistant.artifacts SET title=${release.title},description=${release.description},
        icon=${release.icon},revision=revision+1,published_revision=revision+1,published_title=${release.title},
        published_description=${release.description},published_icon=${release.icon},published_version=${publishedVersion},
        updated_at=now() WHERE id=${id}::uuid RETURNING *`;
      return revision(db,updated!,permission);
    });
  },
  async editChat(id: string, identity: ArtifactIdentity) {
    const bundle = await artifacts.get(id, identity);
    if (!hasPermission(bundle.permission, "admin")) throw new ArtifactError("ACCESS_DENIED");
    const ref = { type: "assistant.artifact", id };
    const href = `/app/assistant/apps/${id}`;
    const conversation = await aiConversations.createConversation({ ownerUserId: user(identity).id,
      title: bundle.title, draft: [{ type: "resource", ref, title: bundle.title, icon: "ti ti-app-window", href }] });
    await aiConversations.indexConversationResources({ conversationId: conversation.id,
      resources: [{ ref, title: bundle.title, icon: "ti ti-app-window", href }] });
    return { href: `/app/assistant?conversation=${conversation.shortId}&workspace=${encodeURIComponent(JSON.stringify(["app", id]))}` };
  },
  async unpublish(id: string, identity: ArtifactIdentity, expectedPublishedVersion?: number) {
    return sql.begin(async db => {
      const { row } = await requireArtifact(db, id, identity, "admin");
      if (expectedPublishedVersion !== undefined && row.published_version !== expectedPublishedVersion) throw new ArtifactError("CONFLICT");
      id = row.id;
      await db`UPDATE assistant.artifacts SET published_revision=NULL,published_title=NULL,published_description=NULL,published_icon=NULL,published_version=NULL WHERE id=${id}::uuid`;
      return { unpublished: true };
    });
  },
  async fork(id: string, identity: ArtifactIdentity) {
    identity = { actor: identity.actor, accessSubject: identity.accessSubject };
    const actor = user(identity);
    return sql.begin(async db => {
      const { row, permission } = await requireArtifact(db, id, identity, "read");
      id = row.id;
      if (row.published_revision === null) throw new ArtifactError("NOT_FOUND");
      const source = await revision(db, row, permission, row.published_revision);
      const [copy] = await withAiShortIdForDb(db, "assistant_artifacts_short_id_key", (tx, shortId) => tx<ArtifactRow[]>`INSERT INTO assistant.artifacts(short_id,kind,title,description,icon,forked_from_id,forked_from_revision)
        VALUES(${shortId},${row.kind},${row.published_title!},${row.published_description ?? ""},${row.published_icon ?? row.icon},${id}::uuid,${row.published_revision}) RETURNING *`);
      const access = await createAccess({ principal: { type: "user", userId: actor.id }, permission: "admin" }, db);
      if (!access.ok) throw new ArtifactError("INVALID_INPUT");
      await db`INSERT INTO assistant.artifact_access VALUES(${copy!.id}::uuid,${access.data.id}::uuid)`;
      await writeRevision(db, copy!.id, 1, source.source);
      return revision(db, copy!, "admin");
    });
  },
};
