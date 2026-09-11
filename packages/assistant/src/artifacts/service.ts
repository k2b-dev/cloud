import { sql, type SQL } from "bun";
import { z } from "zod";
import { AI_FILES_MAX_CONVERSATION_BYTES_DEFAULT } from "@k2b/cloud/ai";
import {
  type AccessSubject, type AuthContext, type PermissionLevel, type Principal,
  buildAccessPrincipalCondition, createAccess, getAccess, deleteAccess, updateAccess,
  hasPermission, resolveDisplayNames, userFromActor,
} from "@k2b/cloud/server";
import { ArtifactCreate, ArtifactFile, ArtifactPath, ArtifactSource, ArtifactUpdate } from "./contracts";

export type ArtifactIdentity = { actor: AuthContext["Variables"]["actor"]; accessSubject: AccessSubject };
export class ArtifactError extends Error {
  constructor(readonly code: "NOT_FOUND" | "ACCESS_DENIED" | "CONFLICT" | "STORAGE_FULL" | "INVALID_INPUT" | "LAST_MANAGER") {
    super(code);
  }
}
type ArtifactRow = { id: string; title: string; description?: string; revision: number; updated_at: Date };
export type ArtifactSummary = { id: string; title: string; description?: string; revision: number; permission: PermissionLevel; updatedAt: string };
export type ArtifactBundle = ArtifactSummary & { source: ArtifactSource; sourceRevision: number };
const summarize = (row: ArtifactRow, permission: PermissionLevel): ArtifactSummary => ({
  id: row.id, title: row.title, description: row.description ?? "", revision: row.revision, permission, updatedAt: row.updated_at.toISOString(),
});
function user(identity: ArtifactIdentity) {
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
async function requireArtifact(db: SQL, id: string, identity: ArtifactIdentity, required: PermissionLevel) {
  z.uuid().parse(id);
  const match = predicate(identity);
  // Serialize authorization with changes to grants, revisions and deletion.
  const [row] = await db<ArtifactRow[]>`SELECT * FROM assistant.artifacts WHERE id=${id}::uuid FOR UPDATE`;
  if (!row) throw new ArtifactError("NOT_FOUND");
  const [grant] = await db<{ permission: PermissionLevel }[]>`SELECT a.permission
    FROM auth.access a JOIN assistant.artifact_access link ON link.access_id=a.id
    WHERE link.artifact_id=${id}::uuid AND ${match}
    ORDER BY CASE a.permission WHEN 'admin' THEN 3 WHEN 'write' THEN 2 WHEN 'read' THEN 1 ELSE 0 END DESC LIMIT 1`;
  if (!hasPermission(grant?.permission ?? "none", required)) throw new ArtifactError("ACCESS_DENIED");
  return { row, permission: grant!.permission };
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
  // Use the existing Assistant workspace storage budget for retained source history.
  if (Number(stored?.total ?? 0) + size > AI_FILES_MAX_CONVERSATION_BYTES_DEFAULT) throw new ArtifactError("STORAGE_FULL");
  await db`INSERT INTO assistant.artifact_revisions(artifact_id,revision,source,source_bytes)
    VALUES(${id}::uuid,${number},${encoded}::jsonb,${size})`;
}

export const artifacts = {
  async describe(ids: string[], userId: string): Promise<Array<{ id: string; title: string; description: string }>> {
    if (!ids.length) return [];
    const valid = ids.filter(id => z.uuid().safeParse(id).success);
    if (!valid.length) return [];
    const match = buildAccessPrincipalCondition({ subject: { type: "user", userId }, columns: {
      userId: sql`a.user_id`, groupId: sql`a.group_id`, serviceAccountId: sql`a.service_account_id`, authenticatedOnly: sql`a.authenticated_only`,
    } });
    return sql<{ id: string; title: string; description: string }[]>`SELECT DISTINCT artifact.id, artifact.title, artifact.description FROM assistant.artifacts artifact
      JOIN assistant.artifact_access link ON link.artifact_id=artifact.id JOIN auth.access a ON a.id=link.access_id
      WHERE artifact.id IN ${sql(valid)} AND ${match} AND a.permission IN ('read','write','admin')`;
  },
  async list(identity: ArtifactIdentity, page = 1) {
    z.number().int().min(1).max(100000).parse(page);
    const match = predicate(identity);
    const rows = await sql<(ArtifactRow & { permission: PermissionLevel })[]>`SELECT p.*,
      CASE max(CASE a.permission WHEN 'admin' THEN 3 WHEN 'write' THEN 2 ELSE 1 END)
      WHEN 3 THEN 'admin' WHEN 2 THEN 'write' ELSE 'read' END AS permission
      FROM assistant.artifacts p JOIN assistant.artifact_access link ON link.artifact_id=p.id
      JOIN auth.access a ON a.id=link.access_id WHERE ${match} AND a.permission IN ('read','write','admin')
      GROUP BY p.id ORDER BY p.updated_at DESC,p.id LIMIT 31 OFFSET ${(page - 1) * 30}`;
    return { items: rows.slice(0,30).map((row) => summarize(row,row.permission)), hasNext: rows.length > 30, page };
  },
  async get(id: string, identity: ArtifactIdentity, sourceRevision?: number): Promise<ArtifactBundle> {
    if (sourceRevision !== undefined) z.number().int().positive().parse(sourceRevision);
    return sql.begin(async (db) => {
      const { row, permission } = await requireArtifact(db,id,identity,"read");
      return revision(db,row,permission,sourceRevision);
    });
  },
  async create(input: unknown, identity: ArtifactIdentity): Promise<ArtifactBundle> {
    const actor = user(identity);
    const parsed = ArtifactCreate.parse(input);
    return sql.begin(async (db) => {
      const [row] = await db<ArtifactRow[]>`INSERT INTO assistant.artifacts(title,description) VALUES(${parsed.title},${parsed.description ?? ""}) RETURNING *`;
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
      const { row, permission } = await requireArtifact(db,id,identity,"write");
      if (row.revision !== parsed.expectedRevision) throw new ArtifactError("CONFLICT");
      await writeRevision(db,id,row.revision + 1,parsed.source);
      const [updated] = await db<ArtifactRow[]>`UPDATE assistant.artifacts SET title=${parsed.title}, description=${parsed.description ?? row.description ?? ""},
        revision=revision+1,updated_at=now() WHERE id=${id}::uuid RETURNING *`;
      return revision(db,updated!,permission);
    });
  },
  async writeFile(id: string, path: string, content: string | null, identity: ArtifactIdentity): Promise<ArtifactBundle> {
    ArtifactPath.parse(path);
    if (content !== null) ArtifactFile.parse({ path, content });
    return sql.begin(async (db) => {
      const { row, permission } = await requireArtifact(db, id, identity, "write");
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
      await requireArtifact(db,id,identity,"read");
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
  async grant(id: string, principal: Principal, level: "read" | "write" | "admin", identity: ArtifactIdentity) {
    return sql.begin(async (db) => {
      await requireArtifact(db,id,identity,"admin");
      const access = await createAccess({ principal, permission: level },db);
      if (!access.ok) throw new ArtifactError("INVALID_INPUT");
      await db`INSERT INTO assistant.artifact_access VALUES(${id}::uuid,${access.data.id}::uuid)`;
      return getAccess({ id: access.data.id },db);
    });
  },
  async changeGrant(id: string, accessId: string, level: "read" | "write" | "admin" | null, identity: ArtifactIdentity) {
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
};
