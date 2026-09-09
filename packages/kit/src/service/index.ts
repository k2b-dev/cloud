import { sql } from "bun";
import { crypto } from "@k2b/stdlib";
import {
  buildAccessPrincipalCondition,
  createAccess,
  deleteAccess,
  getAccess,
  hasPermission,
  resolveDisplayNames,
  updateAccess,
  userFromActor,
  type AccessSubject,
  type AuthContext,
  type PermissionLevel,
  type Principal,
} from "@valentinkolb/cloud/server";
import { type Bundle, type Project, type ProjectInput, PublicId } from "../contracts";
import { validateProject } from "../project";
export class ProjectError extends Error {
  constructor(
    public status: 400 | 403 | 404 | 409,
    public code: string,
  ) {
    super(code);
  }
}
export type Identity = {
  actor: AuthContext["Variables"]["actor"];
  accessSubject: AccessSubject;
};
type Db = typeof sql;
type Row = {
  id: string;
  short_id: string;
  name: string;
  description: string;
  revision: number;
  sdk_version: number;
  persistence_enabled: boolean;
  updated_at: Date;
};
function user(identity: Identity) {
  const u = userFromActor(identity.actor);
  if (!u || identity.accessSubject.type !== "user" || identity.accessSubject.userId !== u.id) throw new ProjectError(403, "USER_REQUIRED");
  return u;
}
const predicate = (identity: Identity) => {
  user(identity);
  return buildAccessPrincipalCondition({
    subject: identity.accessSubject,
    columns: {
      userId: sql`a.user_id`,
      groupId: sql`a.group_id`,
      serviceAccountId: sql`a.service_account_id`,
      authenticatedOnly: sql`a.authenticated_only`,
    },
  });
};
async function permission(db: Db, id: string, identity: Identity): Promise<PermissionLevel> {
  const match = predicate(identity);
  const [r] = await db<
    { permission: PermissionLevel }[]
  >`SELECT a.permission FROM auth.access a JOIN kit.project_access pa ON pa.access_id=a.id WHERE pa.project_id=${id}::uuid AND ${match} ORDER BY CASE a.permission WHEN 'admin' THEN 3 WHEN 'write' THEN 2 WHEN 'read' THEN 1 ELSE 0 END DESC LIMIT 1`;
  return r?.permission ?? "none";
}
async function requireProject(db: Db, publicId: string, identity: Identity, required: PermissionLevel, lock = false) {
  PublicId.parse(publicId);
  user(identity);
  const rows = lock
    ? await db<Row[]>`SELECT * FROM kit.projects WHERE short_id=${publicId} FOR UPDATE`
    : await db<Row[]>`SELECT * FROM kit.projects WHERE short_id=${publicId}`;
  const row = rows[0];
  if (!row) throw new ProjectError(404, "NOT_FOUND");
  const level = await permission(db, row.id, identity);
  if (!hasPermission(level, required)) throw new ProjectError(403, "ACCESS_DENIED");
  return { row, level };
}
const project = (r: Row, level: PermissionLevel): Project => ({
  id: r.short_id,
  name: r.name,
  description: r.description,
  revision: r.revision,
  sdkVersion: r.sdk_version,
  persistenceEnabled: r.persistence_enabled,
  updatedAt: r.updated_at.toISOString(),
  permission: level,
});
async function bundle(db: Db, row: Row, level: PermissionLevel): Promise<Bundle> {
  const files = await db<
    { path: string; content: string }[]
  >`SELECT path,content FROM kit.project_files WHERE project_id=${row.id}::uuid ORDER BY path`;
  return {
    ...project(row, level),
    files,
    entries: validateProject({
      name: row.name,
      description: row.description,
      persistenceEnabled: row.persistence_enabled,
      files,
    }).entries,
  };
}
async function writeFiles(db: Db, id: string, input: ProjectInput) {
  for (const f of input.files) await db`INSERT INTO kit.project_files(project_id,path,content) VALUES(${id}::uuid,${f.path},${f.content})`;
}
export const projects = {
  async list(identity: Identity, page = 1, search = "") {
    const match = predicate(identity);
    const rows = await sql<
      (Row & { permission: PermissionLevel })[]
    >`SELECT p.*, CASE MAX(CASE a.permission WHEN 'admin' THEN 3 WHEN 'write' THEN 2 WHEN 'read' THEN 1 ELSE 0 END) WHEN 3 THEN 'admin' WHEN 2 THEN 'write' ELSE 'read' END AS permission FROM kit.projects p JOIN kit.project_access pa ON pa.project_id=p.id JOIN auth.access a ON a.id=pa.access_id WHERE ${match} AND position(lower(${search}) in lower(p.name || ' ' || p.description))>0 AND a.permission IN ('read','write','admin') GROUP BY p.id ORDER BY p.updated_at DESC,p.id LIMIT 31 OFFSET ${(page - 1) * 30}`;
    return {
      items: rows.slice(0, 30).map((r) => project(r, r.permission)),
      page,
      hasNext: rows.length > 30,
    };
  },
  async get(id: string, identity: Identity, required: PermissionLevel = "write") {
    return sql.begin(async (db) => {
      const { row, level } = await requireProject(db, id, identity, required, true);
      return bundle(db, row, level);
    });
  },
  async create(input: unknown, identity: Identity) {
    const u = user(identity);
    const { project: p } = validateProject(input);
    return sql.begin(async (db) => {
      let row: Row | undefined;
      for (let attempt = 0; attempt < 10 && !row; attempt++) {
        [row] = await db<
          Row[]
        >`INSERT INTO kit.projects(short_id,name,description,persistence_enabled) VALUES(${crypto.common.readableId(6)},${p.name},${p.description},${p.persistenceEnabled}) ON CONFLICT(short_id) DO NOTHING RETURNING *`;
      }
      if (!row) throw new ProjectError(409, "ID_ALLOCATION_FAILED");
      const grant = await createAccess({ principal: { type: "user", userId: u.id }, permission: "admin" }, db);
      if (!grant.ok) throw new ProjectError(400, "INVALID_PRINCIPAL");
      await db`INSERT INTO kit.project_access(project_id,access_id) VALUES(${row.id}::uuid,${grant.data.id}::uuid)`;
      await writeFiles(db, row.id, p);
      return bundle(db, row, "admin");
    });
  },
  async save(id: string, input: ProjectInput, revision: number, identity: Identity) {
    const { project: p } = validateProject(input);
    return sql.begin(async (db) => {
      const { row } = await requireProject(db, id, identity, "admin", true);
      if (row.revision !== revision) throw new ProjectError(409, "REVISION_CONFLICT");
      await db`DELETE FROM kit.project_files WHERE project_id=${row.id}::uuid`;
      await writeFiles(db, row.id, p);
      const [next] = await db<
        Row[]
      >`UPDATE kit.projects SET name=${p.name},description=${p.description},persistence_enabled=${p.persistenceEnabled},revision=revision+1,updated_at=now() WHERE id=${row.id}::uuid RETURNING *`;
      if (!next) throw new ProjectError(404, "NOT_FOUND");
      return bundle(db, next, "admin");
    });
  },
  async remove(id: string, identity: Identity) {
    return sql.begin(async (db) => {
      const { row } = await requireProject(db, id, identity, "admin", true);
      const grants = await db<{ access_id: string }[]>`SELECT access_id FROM kit.project_access WHERE project_id=${row.id}::uuid`;
      await db`DELETE FROM kit.projects WHERE id=${row.id}::uuid`;
      for (const g of grants) await deleteAccess({ id: g.access_id }, db);
      return { deleted: true };
    });
  },
  async access(id: string, identity: Identity) {
    return sql.begin(async (db) => {
      const { row } = await requireProject(db, id, identity, "admin", true);
      const ids = await db<{ access_id: string }[]>`SELECT access_id FROM kit.project_access WHERE project_id=${row.id}::uuid`;
      const entries = await Promise.all(ids.map((g) => getAccess({ id: g.access_id }, db)));
      return resolveDisplayNames(entries.filter((e) => e !== null));
    });
  },
  async grant(id: string, principal: Principal, level: PermissionLevel, identity: Identity) {
    return sql.begin(async (db) => {
      const { row } = await requireProject(db, id, identity, "admin", true);
      const result = await createAccess({ principal, permission: level }, db);
      if (!result.ok) throw new ProjectError(400, "INVALID_PRINCIPAL");
      await db`INSERT INTO kit.project_access(project_id,access_id) VALUES(${row.id}::uuid,${result.data.id}::uuid)`;
      return getAccess({ id: result.data.id }, db);
    });
  },
  async changeGrant(id: string, accessId: string, level: PermissionLevel | null, identity: Identity) {
    return sql.begin(async (db) => {
      const { row } = await requireProject(db, id, identity, "admin", true);
      const [entry] = await db<
        { permission: PermissionLevel }[]
      >`SELECT a.permission FROM auth.access a JOIN kit.project_access pa ON pa.access_id=a.id WHERE pa.project_id=${row.id}::uuid AND a.id=${accessId}::uuid`;
      if (!entry) throw new ProjectError(404, "NOT_FOUND");
      if (entry.permission === "admin" && level !== "admin") {
        const [count] = await db<
          { n: number }[]
        >`SELECT count(*)::int AS n FROM auth.access a JOIN kit.project_access pa ON pa.access_id=a.id WHERE pa.project_id=${row.id}::uuid AND a.permission='admin'`;
        if (!count || count.n <= 1) throw new ProjectError(409, "LAST_ADMIN");
      }
      if (level) await updateAccess({ id: accessId, permission: level }, db);
      else await deleteAccess({ id: accessId }, db);
      return { updated: true };
    });
  },
};
