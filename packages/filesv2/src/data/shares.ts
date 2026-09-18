import { sql } from "bun";

export type ShareRow = {
  id: string;
  token: string;
  kind: "download" | "inbox";
  base_id: string;
  root: string;
  base_path: string;
  scope: string;
  items: string[];
  title: string;
  note: string | null;
  owner_uid: number | null;
  owner_gid: number | null;
  created_by: string;
  created_by_name: string;
  created_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
  revoked_by: string | null;
  access_count: number;
  last_accessed_at: Date | null;
};
// Bun's sql returns JSONB as text; rows are normalised once here.
const normalize = (row: ShareRow): ShareRow => ({ ...row, items: typeof row.items === "string" ? (JSON.parse(row.items) as string[]) : row.items });
export const shares = {
  async create(input: Omit<ShareRow, "id" | "created_at" | "revoked_at" | "revoked_by" | "access_count" | "last_accessed_at">): Promise<ShareRow> {
    const [row] = await sql<
      ShareRow[]
    >`INSERT INTO filesv2.shares(token,kind,base_id,root,base_path,scope,items,title,note,owner_uid,owner_gid,created_by,created_by_name,expires_at)
      VALUES(${input.token},${input.kind},${input.base_id}::uuid,${input.root},${input.base_path},${input.scope},${input.items},${input.title},${input.note},${input.owner_uid},${input.owner_gid},${input.created_by}::uuid,${input.created_by_name},${input.expires_at}) RETURNING *`;
    return normalize(row!);
  },
  async listByBase(baseId: string): Promise<ShareRow[]> {
    return (await sql<ShareRow[]>`SELECT * FROM filesv2.shares WHERE base_id=${baseId}::uuid ORDER BY created_at DESC, id LIMIT 200`).map(normalize);
  },
  async get(id: string): Promise<ShareRow | null> {
    const row = (await sql<ShareRow[]>`SELECT * FROM filesv2.shares WHERE id=${id}::uuid`)[0];
    return row ? normalize(row) : null;
  },
  async byToken(token: string): Promise<ShareRow | null> {
    const row = (await sql<ShareRow[]>`SELECT * FROM filesv2.shares WHERE token=${token}`)[0];
    return row ? normalize(row) : null;
  },
  async revoke(id: string, userId: string): Promise<void> {
    await sql`UPDATE filesv2.shares SET revoked_at=now(), revoked_by=${userId}::uuid WHERE id=${id}::uuid AND revoked_at IS NULL`;
  },
  async touch(id: string): Promise<void> {
    await sql`UPDATE filesv2.shares SET access_count=access_count+1, last_accessed_at=now() WHERE id=${id}::uuid`;
  },
};
