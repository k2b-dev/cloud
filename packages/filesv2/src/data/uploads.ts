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
  created_at: Date;
  updated_at: Date;
};
export const uploads = {
  async create(input: Pick<Upload, "id" | "base_id" | "user_id" | "root" | "path" | "size">): Promise<Upload> {
    const [row] = await sql<
      Upload[]
    >`INSERT INTO filesv2.uploads(id,base_id,user_id,root,path,size) VALUES(${input.id},${input.base_id}::uuid,${input.user_id}::uuid,${input.root},${input.path},${input.size}) RETURNING *`;
    return row!;
  },
  async get(id: string, userId: string): Promise<Upload | null> {
    return (await sql<Upload[]>`SELECT * FROM filesv2.uploads WHERE id=${id} AND user_id=${userId}::uuid`)[0] ?? null;
  },
  async finish(id: string, state: "committed" | "aborted", result: Node | null): Promise<void> {
    await sql`UPDATE filesv2.uploads SET state=${state}, result=${result ? JSON.stringify(result) : null}::jsonb, updated_at=now() WHERE id=${id}`;
  },
};
