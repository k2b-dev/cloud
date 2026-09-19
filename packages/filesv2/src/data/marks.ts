import { sql } from "bun";
import { FilesError } from "../service/errors";

/** Per-user pointers to entries: recently opened files and explicit favorites. Both name a binding, never a raw path alone. */
export type MarkRow = {
  user_id: string;
  base_id: string;
  path: string;
  name: string;
  directory: boolean;
  marked_at: Date;
};
const RECENT_LIMIT = 30;
const FAVORITE_LIMIT = 200;
export const recent = {
  async touch(input: Pick<MarkRow, "user_id" | "base_id" | "path" | "name" | "directory">): Promise<void> {
    await sql`INSERT INTO filesv2.recent(user_id,base_id,path,name,directory,marked_at) VALUES(${input.user_id}::uuid,${input.base_id}::uuid,${input.path},${input.name},${input.directory},now())
      ON CONFLICT(user_id,base_id,path) DO UPDATE SET name=EXCLUDED.name, directory=EXCLUDED.directory, marked_at=now()`;
    // The list stays short per user; older pointers fall off instead of accumulating.
    await sql`DELETE FROM filesv2.recent WHERE user_id=${input.user_id}::uuid AND (base_id,path) NOT IN (
      SELECT base_id,path FROM filesv2.recent WHERE user_id=${input.user_id}::uuid ORDER BY marked_at DESC LIMIT ${RECENT_LIMIT})`;
  },
  async list(userId: string): Promise<MarkRow[]> {
    return sql<MarkRow[]>`SELECT * FROM filesv2.recent WHERE user_id=${userId}::uuid ORDER BY marked_at DESC LIMIT ${RECENT_LIMIT}`;
  },
  async forget(userId: string, baseId: string, path: string): Promise<void> {
    await sql`DELETE FROM filesv2.recent WHERE user_id=${userId}::uuid AND base_id=${baseId}::uuid AND (path=${path} OR starts_with(path, ${`${path}/`}))`;
  },
};
export const favorites = {
  async add(input: Pick<MarkRow, "user_id" | "base_id" | "path" | "name" | "directory">): Promise<void> {
    await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${'filesv2:favorites:' + input.user_id}, 0))`;
      const [count] = await tx<{ count: number }[]>`SELECT count(*)::int AS count FROM filesv2.favorites WHERE user_id=${input.user_id}::uuid AND NOT (base_id=${input.base_id}::uuid AND path=${input.path})`;
      if ((count?.count ?? 0) >= FAVORITE_LIMIT) throw new FilesError("favorites_full", 409);
      await tx`INSERT INTO filesv2.favorites(user_id,base_id,path,name,directory,marked_at) VALUES(${input.user_id}::uuid,${input.base_id}::uuid,${input.path},${input.name},${input.directory},now())
        ON CONFLICT(user_id,base_id,path) DO UPDATE SET name=EXCLUDED.name, directory=EXCLUDED.directory`;
    });
  },
  async remove(userId: string, baseId: string, path: string): Promise<void> {
    await sql`DELETE FROM filesv2.favorites WHERE user_id=${userId}::uuid AND base_id=${baseId}::uuid AND (path=${path} OR starts_with(path, ${`${path}/`}))`;
  },
  async removeByIdentity(userId: string, area: string, kind: string, identityId: string, path: string): Promise<void> {
    await sql`DELETE FROM filesv2.favorites f USING filesv2.bases b WHERE f.base_id=b.id AND f.user_id=${userId}::uuid AND b.area=${area} AND b.kind=${kind} AND b.identity_id=${identityId}::uuid AND f.path=${path}`;
  },
  async list(userId: string): Promise<MarkRow[]> {
    return sql<MarkRow[]>`SELECT * FROM filesv2.favorites WHERE user_id=${userId}::uuid ORDER BY name, path LIMIT ${FAVORITE_LIMIT}`;
  },
  async has(userId: string, baseId: string, path: string): Promise<boolean> {
    return (await sql<{ ok: number }[]>`SELECT 1 AS ok FROM filesv2.favorites WHERE user_id=${userId}::uuid AND base_id=${baseId}::uuid AND path=${path}`).length > 0;
  },
  async count(userId: string): Promise<number> {
    const [row] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM filesv2.favorites WHERE user_id=${userId}::uuid`;
    return row?.count ?? 0;
  },
};
export const MARK_LIMITS = { recent: RECENT_LIMIT, favorites: FAVORITE_LIMIT };
