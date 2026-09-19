import type { Node } from "@k2b/filegate";
import { sql } from "bun";

export type TrashRow = {
  id: string;
  base_id: string;
  user_id: string;
  root: string;
  server_url: string | null;
  original: string | null;
  trashed: string;
  directory: boolean;
  state: "pending" | "trashed" | "restoring" | "restored" | "gone";
  snapshot: Node | null;
  restore_path: string | null;
  error_code: string | null;
  deleted_at: Date;
  cursor_date?: string;
  updated_at: Date;
};
export const trash = {
  async create(
    input: Pick<
      TrashRow,
      "id" | "base_id" | "user_id" | "root" | "original" | "trashed" | "directory" | "snapshot" | "state" | "server_url"
    >,
  ): Promise<TrashRow> {
    const [row] = await sql<
      TrashRow[]
    >`INSERT INTO filesv2.trash(id,base_id,user_id,root,original,trashed,directory,snapshot,state,server_url)
      VALUES(${input.id}::uuid,${input.base_id}::uuid,${input.user_id}::uuid,${input.root},${input.original},${input.trashed},${input.directory},${input.snapshot}::jsonb,${input.state},${input.server_url}) RETURNING *`;
    return row!;
  },
  async list(baseId: string, after?: { date: string; id: string }, limit = 50): Promise<TrashRow[]> {
    return after
      ? sql<
          TrashRow[]
        >`SELECT *,to_char(deleted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_date FROM filesv2.trash WHERE base_id=${baseId}::uuid AND state IN ('pending','trashed','restoring')
          AND (deleted_at < ${after.date}::timestamptz OR (deleted_at=${after.date}::timestamptz AND id>${after.id}::uuid))
          ORDER BY deleted_at DESC,id LIMIT ${limit}`
      : sql<
          TrashRow[]
        >`SELECT *,to_char(deleted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_date FROM filesv2.trash WHERE base_id=${baseId}::uuid AND state IN ('pending','trashed','restoring') ORDER BY deleted_at DESC,id LIMIT ${limit}`;
  },
  async get(id: string, baseId: string): Promise<TrashRow | null> {
    return (await sql<TrashRow[]>`SELECT * FROM filesv2.trash WHERE id=${id}::uuid AND base_id=${baseId}::uuid`)[0] ?? null;
  },
  async at(baseId: string, path: string, includeRestored = false): Promise<TrashRow | null> {
    return (
      (
        await sql<TrashRow[]>`SELECT * FROM filesv2.trash WHERE base_id=${baseId}::uuid AND trashed=${path}
      AND (state IN ('pending','trashed','restoring') OR (${includeRestored} AND state='restored')) ORDER BY deleted_at DESC,id DESC LIMIT 1`
      )[0] ?? null
    );
  },
  async pending(baseId: string, original: string): Promise<TrashRow | null> {
    return (
      (await sql<TrashRow[]>`SELECT * FROM filesv2.trash WHERE base_id=${baseId}::uuid AND original=${original} AND state='pending'`)[0] ??
      null
    );
  },
  async restoring(id: string, path: string, snapshot: Node, serverUrl: string): Promise<void> {
    const rows =
      await sql`UPDATE filesv2.trash SET state='restoring',restore_path=${path},snapshot=${snapshot}::jsonb,server_url=${serverUrl},error_code=NULL,updated_at=now()
      WHERE id=${id}::uuid AND state='trashed' RETURNING id`;
    if (!rows.length) throw new Error("operation_unresolved");
  },
  async finish(id: string, state: "trashed" | "restored" | "gone"): Promise<void> {
    const expected = state === "trashed" ? "pending" : state === "restored" ? "restoring" : "trashed";
    const rows = await sql`UPDATE filesv2.trash SET state=${state},error_code=NULL,updated_at=now()
      WHERE id=${id}::uuid AND state=${expected} RETURNING id`;
    if (!rows.length) throw new Error("operation_unresolved");
  },
  async error(id: string, code: string): Promise<void> {
    await sql`UPDATE filesv2.trash SET error_code=${code},updated_at=now() WHERE id=${id}::uuid AND state IN ('pending','restoring')`;
  },
};
