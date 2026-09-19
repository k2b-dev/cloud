import type { Node } from "@k2b/filegate";
import { sql } from "bun";

export type Upload = {
  id: string;
  base_id: string;
  user_id: string;
  root: string;
  path: string;
  size: number;
  state: "open" | "committed" | "aborted";
  result: Node | null;
  share_id: string | null;
  created_at: Date;
  updated_at: Date;
};
// Bun's sql returns JSONB as text; rows are normalised once here.
const normalize = (row: Upload): Upload => ({ ...row, result: typeof row.result === "string" ? (JSON.parse(row.result) as Node) : row.result });
export const uploads = {
  async create(input: Pick<Upload, "id" | "base_id" | "user_id" | "root" | "path" | "size"> & { share_id?: string | null }): Promise<Upload> {
    const [row] = await sql<
      Upload[]
    >`INSERT INTO filesv2.uploads(id,base_id,user_id,root,path,size,share_id) VALUES(${input.id},${input.base_id}::uuid,${input.user_id}::uuid,${input.root},${input.path},${input.size},${input.share_id ?? null}::uuid) RETURNING *`;
    return row!;
  },
  async getForShare(id: string, shareId: string): Promise<Upload | null> {
    return (await sql<Upload[]>`SELECT * FROM filesv2.uploads WHERE id=${id} AND share_id=${shareId}::uuid`)[0] ?? null;
  },
  async get(id: string, userId: string): Promise<Upload | null> {
    return (await sql<Upload[]>`SELECT * FROM filesv2.uploads WHERE id=${id} AND user_id=${userId}::uuid`)[0] ?? null;
  },
  async openCountForShare(shareId: string): Promise<number> {
    const [row] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM filesv2.uploads WHERE share_id=${shareId}::uuid AND state='open'`;
    return row?.count ?? 0;
  },
  async finish(id: string, state: "committed" | "aborted", result: Node | null): Promise<void> {
    await sql`UPDATE filesv2.uploads SET state=${state}, result=${result ?? null}, updated_at=now() WHERE id=${id}`;
  },
};
