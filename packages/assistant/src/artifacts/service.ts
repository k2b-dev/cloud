import { hasRole } from "@k2b/cloud/contracts";
import { sql, type SQL } from "bun";
import { z } from "zod";
import { AI_FILES_MAX_CONVERSATION_BYTES_DEFAULT, aiConversations, aiProjects } from "@k2b/cloud/ai";
import {
  type AccessSubject, type AuthContext, type PermissionLevel, type Principal,
  buildAccessPrincipalCondition, createAccess, getAccess, deleteAccess, updateAccess,
  hasPermission, resolveDisplayNames, userFromActor,
} from "@k2b/cloud/server";
import { StorageRequest } from "./storage-contracts";
import { LIMITS, ArtifactKind, ArtifactMetadata, PublicationNote, ArtifactCreate, ArtifactFile, ArtifactPath, ArtifactSource, ArtifactUpdate } from "./contracts";
import { compileArtifact } from "./runtime/compile";

export type ArtifactIdentity = { actor: AuthContext["Variables"]["actor"]; accessSubject: AccessSubject; conversationId?: string; administrative?: boolean };
export class ArtifactError extends Error {
  constructor(readonly code: "NOT_FOUND" | "ACCESS_DENIED" | "CONFLICT" | "STORAGE_FULL" | "INVALID_INPUT" | "LAST_MANAGER" | "TOO_MANY_REQUESTS") {
    super(code);
  }
}
type ArtifactRow = { kind: ArtifactKind; icon: string; published_icon: string | null; published_version: number | null; id: string; title: string; description?: string; revision: number; updated_at: Date; published_revision: number | null; published_title: string | null; published_description: string | null; forked_from_id: string | null; forked_from_revision: number | null };
export type ArtifactSummary = { kind: ArtifactKind; icon?: string; publishedVersion?: number | null; id: string; title: string; description?: string; revision: number; permission: PermissionLevel; updatedAt: string; publishedRevision: number | null; forkedFromId: string | null; forkedFromRevision: number | null };
export type ArtifactBundle = ArtifactSummary & { source: ArtifactSource; sourceRevision: number };
const summarize = (row: ArtifactRow, permission: PermissionLevel): ArtifactSummary => ({
  kind: row.kind, icon: permission === "admin" ? row.icon : row.published_icon ?? row.icon, publishedVersion: row.published_version,
  id: row.id, title: permission === "admin" ? row.title : row.published_title ?? row.title,
  description: (permission === "admin" ? row.description : row.published_description) ?? "",
  revision: permission === "admin" ? row.revision : row.published_revision!, permission, updatedAt: row.updated_at.toISOString(),
  publishedRevision: row.published_revision, forkedFromId: row.forked_from_id, forkedFromRevision: row.forked_from_revision,
});
export function user(identity: ArtifactIdentity) {
  const actor = userFromActor(identity.actor);
  if (!actor || identity.accessSubject.type !== "user" || identity.accessSubject.userId !== actor.id)
    throw new ArtifactError("ACCESS_DENIED");
  return actor;
}
function predicate(identity: ArtifactIdentity) {
  user(identity);
  return buildAccessPrincipalCondition({ subject: identity.accessSubject, columns: {
    userId: sql`a.user_id`, groupId: sql`a.group_id`, serviceAccountId: sql`a.service_account_id`,
    authenticatedOnly: sql`a.authenticated_only`,
  } });
}
async function projectContext(identity: ArtifactIdentity) {
  if (!identity.conversationId) return undefined;
  const actor = user(identity);
  const conversation = z.uuid().safeParse(identity.conversationId).success
    ? await aiConversations.getConversation({conversationId:identity.conversationId,ownerUserId:actor.id})
    : await aiConversations.getConversationByShortId({shortId:identity.conversationId,ownerUserId:actor.id});
  if (!conversation) throw new ArtifactError("ACCESS_DENIED");
  if (!conversation.projectId) return undefined;
  return (await aiProjects.get(conversation.projectId,identity.accessSubject,"read"))?.id;
}

export async function requireArtifact(db: SQL, id: string, identity: ArtifactIdentity, required: PermissionLevel) {
  z.uuid().parse(id);
  const match = predicate(identity);
  // Serialize authorization with changes to grants, revisions and deletion.
  const [row] = await db<ArtifactRow[]>`SELECT * FROM assistant.artifacts WHERE id=${id}::uuid FOR UPDATE`;
  if (!row) throw new ArtifactError("NOT_FOUND");
  const [grant] = await db<{ permission: PermissionLevel }[]>`SELECT a.permission
    FROM auth.access a JOIN assistant.artifact_access link ON link.access_id=a.id
    WHERE link.artifact_id=${id}::uuid AND ${match}
    ORDER BY CASE a.permission WHEN 'admin' THEN 3 WHEN 'write' THEN 2 WHEN 'read' THEN 1 ELSE 0 END DESC LIMIT 1`;
  let permission = identity.administrative && hasRole(user(identity),"admin") ? "admin" as const : grant?.permission ?? "none";
  if (!hasPermission(permission, required) && required === "read" && row.kind === "script" && row.published_revision !== null) {
    const projectId = await projectContext(identity);
    if (projectId) {
      const [link] = await db`SELECT 1 FROM assistant.artifact_projects WHERE artifact_id=${id}::uuid AND project_id=${projectId}::uuid`;
      if (link) permission = "read";
    }
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
  return { ...summarize(row, permission), source: ArtifactSource.parse(source), sourceRevision };
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
    VALUES(${id}::uuid,${number},${encoded}::jsonb,${size})`;
}

export const artifacts = {
  async remove(id: string, identity: ArtifactIdentity) {
    const { databaseConfigLock } = await import("./database");
    return sql.begin(async db => {
      await databaseConfigLock(db);
      await requireArtifact(db,id,identity,"admin");
      const cleanup = await db`INSERT INTO assistant.database_cleanup(namespace)
        SELECT namespace FROM assistant.artifact_databases WHERE artifact_id=${id}::uuid ON CONFLICT DO NOTHING RETURNING namespace`;
      await db`DELETE FROM auth.access WHERE id IN (SELECT access_id FROM assistant.artifact_access WHERE artifact_id=${id}::uuid)`;
      await db`DELETE FROM assistant.artifacts WHERE id=${id}::uuid`;
      return {deleted:true,databaseCleanupQueued:cleanup.length>0};
    });
  },
  async describe(ids: string[], userId: string, conversationId?: string): Promise<Array<{ id: string; title: string; description: string; icon: string }>> {
    if (!ids.length) return [];
    const valid = ids.filter(id => z.uuid().safeParse(id).success);
    if (!valid.length) return [];
    const conversation = conversationId ? await aiConversations.getConversation({conversationId,ownerUserId:userId}) : null;
    const projectId = conversation && !conversation.archivedAt && conversation.projectId
      ? (await aiProjects.get(conversation.projectId,{type:"user",userId},"read"))?.id : undefined;
    const match = buildAccessPrincipalCondition({ subject: { type: "user", userId }, columns: {
      userId: sql`a.user_id`, groupId: sql`a.group_id`, serviceAccountId: sql`a.service_account_id`, authenticatedOnly: sql`a.authenticated_only`,
    } });
    return sql<{ id: string; title: string; description: string; icon: string }[]>`SELECT artifact.id,
      CASE WHEN bool_or(a.permission='admin') THEN artifact.icon ELSE artifact.published_icon END AS icon,
      CASE WHEN bool_or(a.permission='admin') THEN artifact.title ELSE artifact.published_title END AS title,
      CASE WHEN bool_or(a.permission='admin') THEN artifact.description ELSE artifact.published_description END AS description FROM assistant.artifacts artifact
      LEFT JOIN assistant.artifact_access link ON link.artifact_id=artifact.id
      LEFT JOIN auth.access a ON a.id=link.access_id AND ${match} AND a.permission IN ('read','write','admin')
      WHERE artifact.id IN ${sql(valid)}
      GROUP BY artifact.id HAVING bool_or(a.permission='admin') OR (artifact.published_revision IS NOT NULL AND
        (count(a.id)>0 OR (artifact.kind='script' AND EXISTS(SELECT 1 FROM assistant.artifact_projects project
          WHERE project.artifact_id=artifact.id AND project.project_id=${projectId ?? null}::uuid))))`;
  },
  async list(identity: ArtifactIdentity, page = 1, kind?: ArtifactKind, search = "") {
    z.number().int().min(1).max(100000).parse(page);
    z.string().max(120).parse(search);
    if (kind !== undefined) ArtifactKind.parse(kind);
    const match = predicate(identity), projectId = await projectContext(identity);
    const rows = await sql<(ArtifactRow & { permission: PermissionLevel })[]>`SELECT p.*,
      CASE max(CASE a.permission WHEN 'admin' THEN 3 WHEN 'write' THEN 2 ELSE 1 END)
      WHEN 3 THEN 'admin' WHEN 2 THEN 'write' ELSE 'read' END AS permission
      FROM assistant.artifacts p LEFT JOIN assistant.artifact_access link ON link.artifact_id=p.id
      LEFT JOIN auth.access a ON a.id=link.access_id AND ${match} AND a.permission IN ('read','write','admin')
      WHERE (${kind ?? null}::text IS NULL OR p.kind=${kind ?? null})
      GROUP BY p.id HAVING (bool_or(a.permission='admin') OR (p.published_revision IS NOT NULL AND
        (count(a.id)>0 OR (p.kind='script' AND EXISTS(SELECT 1 FROM assistant.artifact_projects project
          WHERE project.artifact_id=p.id AND project.project_id=${projectId ?? null}::uuid)))))
      AND strpos(lower(CASE WHEN bool_or(a.permission='admin') THEN p.title || ' ' || p.description
        ELSE coalesce(p.published_title,'') || ' ' || coalesce(p.published_description,'') END),lower(${search}))>0
      ORDER BY p.updated_at DESC,p.id LIMIT 31 OFFSET ${(page - 1) * 30}`;
    return { items: rows.slice(0,30).map((row) => summarize(row,row.permission)), hasNext: rows.length > 30, page };
  },
  async get(id: string, identity: ArtifactIdentity, sourceRevision?: number, published = false, version?: number): Promise<ArtifactBundle> {
    if (sourceRevision !== undefined) z.number().int().positive().parse(sourceRevision);
    return sql.begin(async (db) => {
      const { row, permission } = await requireArtifact(db,id,identity,"read");
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
      const [row] = await db<ArtifactRow[]>`INSERT INTO assistant.artifacts(kind,title,description,icon) VALUES(${parsed.kind},${parsed.title},${parsed.description ?? ""},${parsed.icon ?? "ti ti-app-window"}) RETURNING *`;
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
  async history(id: string, identity: ArtifactIdentity, page = 1) {
    z.number().int().min(1).max(100000).parse(page);
    return sql.begin(async (db) => {
      await requireArtifact(db,id,identity,"admin");
      const rows = await db<{ revision: number; created_at: Date }[]>`SELECT revision,created_at
        FROM assistant.artifact_revisions WHERE artifact_id=${id}::uuid ORDER BY revision DESC LIMIT 31 OFFSET ${(page - 1) * 30}`;
      return { items: rows.slice(0,30).map((row) => ({ revision: row.revision, createdAt: row.created_at.toISOString() })), hasNext: rows.length > 30, page };
    });
  },
  async access(id: string, identity: ArtifactIdentity) {
    return sql.begin(async (db) => {
      await requireArtifact(db,id,identity,"admin");
      const links = await db<{ access_id: string }[]>`SELECT access_id FROM assistant.artifact_access WHERE artifact_id=${id}::uuid`;
      const grants = await Promise.all(links.map((link) => getAccess({ id: link.access_id },db)));
      return resolveDisplayNames(grants.filter((grant) => grant !== null));
    });
  },
  async grant(id: string, principal: Principal, level: "read" | "admin", identity: ArtifactIdentity) {
    z.enum(["read", "admin"]).parse(level);
    if (principal.type === "public" || principal.type === "service_account") throw new ArtifactError("INVALID_INPUT");
    return sql.begin(async (db) => {
      await requireArtifact(db,id,identity,"admin");
      const access = await createAccess({ principal, permission: level },db);
      if (!access.ok) throw new ArtifactError("INVALID_INPUT");
      await db`INSERT INTO assistant.artifact_access VALUES(${id}::uuid,${access.data.id}::uuid)`;
      return getAccess({ id: access.data.id },db);
    });
  },
  async changeGrant(id: string, accessId: string, level: "read" | "admin" | null, identity: ArtifactIdentity) {
    z.enum(["read", "admin"]).nullable().parse(level);
    z.uuid().parse(accessId);
    return sql.begin(async (db) => {
      await requireArtifact(db,id,identity,"admin");
      const [grant] = await db<{ permission: PermissionLevel }[]>`SELECT a.permission FROM auth.access a
        JOIN assistant.artifact_access link ON link.access_id=a.id WHERE link.artifact_id=${id}::uuid AND a.id=${accessId}::uuid`;
      if (!grant) throw new ArtifactError("NOT_FOUND");
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
    await compileArtifact(draft.source);
    return sql.begin(async db => {
      const { row } = await requireArtifact(db, id, identity, "admin");
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
  async storage(id: string, input: unknown, identity: ArtifactIdentity) {
    const request = StorageRequest.parse(input);
    if (request.operation !== "list" && !request.key) throw new ArtifactError("INVALID_INPUT");
    let bytes = 0;
    if (request.operation === "write") {
      if (request.content === undefined) throw new ArtifactError("INVALID_INPUT");
      if (request.area === "kv") {
        try { JSON.parse(request.content); } catch { throw new ArtifactError("INVALID_INPUT"); }
        bytes = new TextEncoder().encode(request.content).byteLength;
      } else {
        if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(request.content))
          throw new ArtifactError("INVALID_INPUT");
        bytes = Buffer.from(request.content,"base64").length;
      }
    }
    return sql.begin(async db => {
      // App use includes its runtime data effects. Code administration remains
      // separate. Lock the resource so quota checks and writes serialize.
      await requireArtifact(db,id,identity,"read");
      if (request.operation === "list") {
        const items = await db<{key:string;bytes:number;mediaType:string}[]>`SELECT key,bytes,media_type AS "mediaType"
          FROM assistant.artifact_storage WHERE artifact_id=${id}::uuid AND area=${request.area} AND key > ${request.after} ORDER BY key LIMIT ${request.limit}`;
        return {items};
      }
      if (request.operation === "delete") {
        await db`DELETE FROM assistant.artifact_storage WHERE artifact_id=${id}::uuid AND area=${request.area} AND key=${request.key!}`;
        return {deleted:true};
      }
      if (request.operation === "write") {
        const [usage] = await db<{bytes:number;items:number}[]>`SELECT coalesce(sum(bytes),0)::bigint AS bytes,count(*)::int AS items
          FROM assistant.artifact_storage WHERE artifact_id=${id}::uuid AND NOT(area=${request.area} AND key=${request.key!})`;
        if (Number(usage!.bytes)+bytes > LIMITS.rpcBytes || usage!.items >= 1000) throw new ArtifactError("STORAGE_FULL");
        await db`INSERT INTO assistant.artifact_storage(artifact_id,area,key,content,media_type,bytes)
          VALUES(${id}::uuid,${request.area},${request.key!},${request.content!},${request.mediaType},${bytes})
          ON CONFLICT(artifact_id,area,key) DO UPDATE SET content=excluded.content,media_type=excluded.media_type,bytes=excluded.bytes,updated_at=now()`;
        return {written:true};
      }
      const [item] = await db<{content:string;mediaType:string}[]>`SELECT content,media_type AS "mediaType"
        FROM assistant.artifact_storage WHERE artifact_id=${id}::uuid AND area=${request.area} AND key=${request.key!}`;
      return {item:item ?? null};
    });
  },
  async projects(id: string, identity: ArtifactIdentity) {
    return sql.begin(async db => {
      await requireArtifact(db,id,identity,"admin");
      return db<{projectId:string}[]>`SELECT project_id AS "projectId" FROM assistant.artifact_projects WHERE artifact_id=${id}::uuid ORDER BY project_id`;
    });
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
      if (row.kind !== "script") throw new ArtifactError("INVALID_INPUT");
      if (linked) await db`INSERT INTO assistant.artifact_projects(artifact_id,project_id) VALUES(${id}::uuid,${projectId}::uuid) ON CONFLICT DO NOTHING`;
      else await db`DELETE FROM assistant.artifact_projects WHERE artifact_id=${id}::uuid AND project_id=${projectId}::uuid`;
      return {linked};
    });
  },
  async metadata(id: string, input: unknown, identity: ArtifactIdentity) {
    const patch = ArtifactMetadata.parse(input);
    return sql.begin(async db => {
      const { row, permission } = await requireArtifact(db,id,identity,"admin");
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
      await requireArtifact(db,id,identity,"admin");
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
  async unpublish(id: string, identity: ArtifactIdentity) {
    return sql.begin(async db => {
      await requireArtifact(db, id, identity, "admin");
      await db`UPDATE assistant.artifacts SET published_revision=NULL,published_title=NULL,published_description=NULL,published_icon=NULL,published_version=NULL WHERE id=${id}::uuid`;
      return { unpublished: true };
    });
  },
  async fork(id: string, identity: ArtifactIdentity) {
    identity = { actor: identity.actor, accessSubject: identity.accessSubject };
    const actor = user(identity);
    return sql.begin(async db => {
      const { row, permission } = await requireArtifact(db, id, identity, "read");
      if (row.published_revision === null) throw new ArtifactError("NOT_FOUND");
      const source = await revision(db, row, permission, row.published_revision);
      const [copy] = await db<ArtifactRow[]>`INSERT INTO assistant.artifacts(kind,title,description,icon,forked_from_id,forked_from_revision)
        VALUES(${row.kind},${row.published_title!},${row.published_description ?? ""},${row.published_icon ?? row.icon},${id}::uuid,${row.published_revision}) RETURNING *`;
      const access = await createAccess({ principal: { type: "user", userId: actor.id }, permission: "admin" }, db);
      if (!access.ok) throw new ArtifactError("INVALID_INPUT");
      await db`INSERT INTO assistant.artifact_access VALUES(${copy!.id}::uuid,${access.data.id}::uuid)`;
      await writeRevision(db, copy!.id, 1, source.source);
      return revision(db, copy!, "admin");
    });
  },
};
