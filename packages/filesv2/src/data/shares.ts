import { createHash } from "node:crypto";
import { sql } from "bun";

export const shareTokenHash = (token: string) => createHash("sha256").update(token).digest("hex");
export type ShareRow = {
  id: string;
  token_hash: string;
  password_hash: string | null;
  kind: "download" | "inbox";
  base_id: string;
  root: string;
  base_path: string;
  scope: string;
  items: string[];
  title: string;
  note: string | null;
  public_note: string | null;
  owner_uid: number | null;
  owner_gid: number | null;
  created_by: string;
  created_by_name: string;
  created_at: Date;
  expires_at: Date | null;
  revoked_at: Date | null;
  revoked_by: string | null;
  access_count: number;
  last_accessed_at: Date | null;
  max_file_size: number;
  max_total_size: number;
  show_upload_names: boolean;
};
const normalize = (row: ShareRow): ShareRow => ({
  ...row,
  max_file_size: Number(row.max_file_size),
  max_total_size: Number(row.max_total_size),
  items: typeof row.items === "string" ? (JSON.parse(row.items) as string[]) : row.items,
});
export const shares = {
  async create(
    input: Omit<ShareRow, "id" | "created_at" | "revoked_at" | "revoked_by" | "access_count" | "last_accessed_at">,
  ): Promise<ShareRow> {
    const [row] = await sql<
      ShareRow[]
    >`INSERT INTO filesv2.shares(token_hash,password_hash,kind,base_id,root,base_path,scope,items,title,note,public_note,owner_uid,owner_gid,created_by,created_by_name,expires_at,max_file_size,max_total_size,show_upload_names)
      VALUES(${input.token_hash},${input.password_hash},${input.kind},${input.base_id}::uuid,${input.root},${input.base_path},${input.scope},${input.items},${input.title},${input.note},${input.public_note},${input.owner_uid},${input.owner_gid},${input.created_by}::uuid,${input.created_by_name},${input.expires_at},${input.max_file_size},${input.max_total_size},${input.show_upload_names}) RETURNING *`;
    return normalize(row!);
  },
  /** An owner's management list never depends on retaining access to the old storage. */
  async list(input: { ownerId?: string; after?: string; limit?: number }): Promise<{ items: ShareRow[]; next: string | null }> {
    const limit = input.limit ?? 50;
    const rows = await sql<ShareRow[]>`SELECT * FROM filesv2.shares
      WHERE (${input.ownerId ?? null}::uuid IS NULL OR created_by=${input.ownerId ?? null}::uuid)
      AND (${input.after ?? null}::uuid IS NULL OR (created_at,id)<(SELECT created_at,id FROM filesv2.shares WHERE id=${input.after ?? null}::uuid))
      ORDER BY created_at DESC,id DESC LIMIT ${limit + 1}`;
    return { items: rows.slice(0, limit).map(normalize), next: rows.length > limit ? rows[limit - 1]!.id : null };
  },
  async get(id: string): Promise<ShareRow | null> {
    const row = (await sql<ShareRow[]>`SELECT * FROM filesv2.shares WHERE id=${id}::uuid`)[0];
    return row ? normalize(row) : null;
  },
  async byToken(token: string): Promise<ShareRow | null> {
    const row = (await sql<ShareRow[]>`SELECT * FROM filesv2.shares WHERE token_hash=${shareTokenHash(token)}`)[0];
    return row ? normalize(row) : null;
  },
  async revoke(id: string, userId: string): Promise<void> {
    await sql`UPDATE filesv2.shares SET revoked_at=now(), revoked_by=${userId}::uuid WHERE id=${id}::uuid AND revoked_at IS NULL`;
  },
  async touch(id: string): Promise<void> {
    await sql`UPDATE filesv2.shares SET access_count=access_count+1, last_accessed_at=now() WHERE id=${id}::uuid`;
  },
};
