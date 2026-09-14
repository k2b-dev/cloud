import { hasRole } from "@k2b/cloud/contracts";
import {
  type AccessSubject,
  type AuthContext,
  buildAccessPrincipalCondition,
  hasPermission,
  type PermissionLevel,
  userFromActor,
} from "@k2b/cloud/server";
import { sql } from "bun";
import { PublicId } from "../contracts";
import { ProjectError } from "../errors";

export type Identity = {
  actor: AuthContext["Variables"]["actor"];
  accessSubject: AccessSubject;
};
type Db = typeof sql;
export type Row = {
  id: string;
  short_id: string;
  name: string;
  description: string;
  revision: number;
  sdk_version: number;
  persistence_enabled: boolean;
  updated_at: Date;
};
export function user(identity: Identity) {
  const u = userFromActor(identity.actor);
  if (!u || identity.accessSubject.type !== "user" || identity.accessSubject.userId !== u.id) throw new ProjectError(403, "USER_REQUIRED");
  return u;
}
export const predicate = (identity: Identity) => {
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
export async function requireProject(db: Db, publicId: string, identity: Identity, required: PermissionLevel, lock = false) {
  PublicId.parse(publicId);
  user(identity);
  const rows = lock
    ? await db<Row[]>`SELECT * FROM kit.projects WHERE short_id=${publicId} FOR UPDATE`
    : await db<Row[]>`SELECT * FROM kit.projects WHERE short_id=${publicId}`;
  const row = rows[0];
  if (!row) throw new ProjectError(404, "NOT_FOUND");
  const level = hasRole(user(identity), "admin") ? "admin" : await permission(db, row.id, identity);
  if (!hasPermission(level, required)) throw new ProjectError(403, "ACCESS_DENIED");
  return { row, level };
}
