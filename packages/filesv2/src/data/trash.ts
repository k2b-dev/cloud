import { sql } from "bun";

export type TrashRow = {
  id: string;
  base_id: string;
  user_id: string;
  root: string;
  original: string;
  trashed: string;
  directory: boolean;
  state: "trashed" | "restored" | "gone";
  deleted_at: Date;
  updated_at: Date;
};
export const trash = {
  async create(input: Pick<TrashRow, "base_id" | "user_id" | "root" | "original" | "trashed" | "directory">): Promise<TrashRow> {
    const [row] = await sql<
      TrashRow[]
    >`INSERT INTO filesv2.trash(base_id,user_id,root,original,trashed,directory) VALUES(${input.base_id}::uuid,${input.user_id}::uuid,${input.root},${input.original},${input.trashed},${input.directory}) RETURNING *`;
    return row!;
  },
  async list(baseId: string): Promise<TrashRow[]> {
    return sql<TrashRow[]>`SELECT * FROM filesv2.trash WHERE base_id=${baseId}::uuid AND state='trashed' ORDER BY deleted_at DESC, id LIMIT 200`;
  },
  async get(id: string, baseId: string): Promise<TrashRow | null> {
    return (await sql<TrashRow[]>`SELECT * FROM filesv2.trash WHERE id=${id}::uuid AND base_id=${baseId}::uuid`)[0] ?? null;
  },
  async finish(id: string, state: "restored" | "gone"): Promise<void> {
    await sql`UPDATE filesv2.trash SET state=${state}, updated_at=now() WHERE id=${id}::uuid`;
  },
};
