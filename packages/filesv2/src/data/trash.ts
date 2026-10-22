import type { Node } from "@k2b/filegate";
import { sql, type TransactionSQL } from "bun";
import type { FilesCall, Intent, UserFilesCall } from "../service/activity";
import { FilesError } from "../service/errors";
import { finishActivity, insertActivity } from "./activity";

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
  activity_recorded: boolean;
  restore_activity_recorded: boolean;
};
type HistoryInput = { call: UserFilesCall; basePath: string; batchId?: string };
type TrashActivity = { id: string; state: string; path_before: string; path_after: string };
const phase = (row: TrashRow) => (row.state === "restoring" || row.state === "restored" ? "item.restore" : "item.trash");
async function recordHistory(
  tx: TransactionSQL,
  row: TrashRow,
  action: "item.trash" | "item.restore",
  history?: HistoryInput,
): Promise<TrashActivity | null> {
  const [existing] = await tx<
    TrashActivity[]
  >`SELECT id,state,path_before,path_after FROM filesv2.activity WHERE trash_id=${row.id}::uuid AND action=${action}`;
  if (existing) return existing;
  const restoring = action === "item.restore";
  if (restoring ? row.restore_activity_recorded : row.activity_recorded) return null;
  if (!restoring && !row.original) return null; // An adopted filesystem trash entry is not a Cloud deletion.
  const [base] = await tx<{ path: string }[]>`SELECT path FROM filesv2.bases WHERE id=${row.base_id}::uuid`;
  const basePath = history?.basePath ?? base?.path;
  if (!basePath) throw new FilesError("operation_unresolved", 409);
  const source = restoring ? row.trashed : row.original!;
  const target = restoring ? row.restore_path : row.trashed;
  if (!target) throw new FilesError("operation_unresolved", 409);
  const actorId = (await tx<{ id: string }[]>`SELECT id FROM auth.users WHERE id=${row.user_id}::uuid`)[0]?.id ?? null;
  const call: FilesCall = history?.call ?? { kind: "system", job: "legacy-trash" };
  const intent: Intent = {
    action,
    serverUrl: row.server_url ?? "",
    root: row.root,
    baseId: row.base_id,
    directory: row.directory,
    name: (row.original ?? row.restore_path ?? row.trashed).split("/").at(-1)!,
    pathBefore: `${basePath}/${source}`,
    pathAfter: `${basePath}/${target}`,
    itemId: row.snapshot?.id,
    size: row.snapshot?.size,
    revisionBefore: row.snapshot?.revision,
    trashId: row.id,
    batchId: history?.batchId,
    trashDirectory: restoring ? undefined : `${basePath}/trash`,
    detail: history ? undefined : { adopted: true },
  };
  const id = await insertActivity(call, intent, tx);
  if (!history)
    await tx`UPDATE filesv2.activity SET actor_kind='user',actor_user_id=${actorId}::uuid,via='unknown',started_at=${restoring ? row.updated_at : row.deleted_at},detail=detail-'job' WHERE id=${id}::uuid`;
  if (restoring) await tx`UPDATE filesv2.trash SET restore_activity_recorded=true WHERE id=${row.id}::uuid`;
  else await tx`UPDATE filesv2.trash SET activity_recorded=true WHERE id=${row.id}::uuid`;
  if ((restoring && row.state === "restored") || (!restoring && row.state !== "pending")) {
    await finishActivity(tx, id, "done", async () => ({ itemAfterId: row.snapshot?.id }));
    await tx`UPDATE filesv2.activity SET finished_at=${row.updated_at} WHERE id=${id}::uuid`;
  }
  return (await tx<TrashActivity[]>`SELECT id,state,path_before,path_after FROM filesv2.activity WHERE id=${id}::uuid`)[0]!;
}
export const trash = {
  async create(
    input: Pick<
      TrashRow,
      "id" | "base_id" | "user_id" | "root" | "original" | "trashed" | "directory" | "snapshot" | "state" | "server_url"
    >,
    history?: HistoryInput,
  ): Promise<TrashRow> {
    if (input.state === "pending" && !history) throw new FilesError("activity_scope_missing", 500);
    return sql.begin(async (tx) => {
      const [row] = await tx<
        TrashRow[]
      >`INSERT INTO filesv2.trash(id,base_id,user_id,root,original,trashed,directory,snapshot,state,server_url)
        VALUES(${input.id}::uuid,${input.base_id}::uuid,${input.user_id}::uuid,${input.root},${input.original},${input.trashed},${input.directory},${input.snapshot}::jsonb,${input.state},${input.server_url}) RETURNING *`;
      if (input.state === "pending") await recordHistory(tx, row!, "item.trash", history);
      return row!;
    });
  },
  async history(id: string): Promise<TrashActivity | null> {
    return sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${id}))`;
      const [row] = await tx<TrashRow[]>`SELECT * FROM filesv2.trash WHERE id=${id}::uuid`;
      if (!row) throw new FilesError("not_found", 404);
      const activity = await recordHistory(tx, row, phase(row));
      if (!activity && (row.state === "pending" || row.state === "restoring")) throw new FilesError("activity_scope_missing", 500);
      return activity;
    });
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
  async restoring(id: string, path: string, snapshot: Node, serverUrl: string, history: HistoryInput): Promise<void> {
    await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${id}))`;
      const [previous] = await tx<TrashRow[]>`SELECT * FROM filesv2.trash WHERE id=${id}::uuid AND state='trashed'`;
      if (!previous) throw new FilesError("operation_unresolved", 409);
      await recordHistory(tx, previous, "item.trash");
      const [row] = await tx<
        TrashRow[]
      >`UPDATE filesv2.trash SET state='restoring',restore_path=${path},snapshot=${snapshot}::jsonb,server_url=${serverUrl},error_code=NULL,updated_at=now()
        WHERE id=${id}::uuid AND state='trashed' RETURNING *`;
      if (!row) throw new FilesError("operation_unresolved", 409);
      await recordHistory(tx, row, "item.restore", history);
    });
  },
  async finish(id: string, state: "trashed" | "restored", node: Node): Promise<void> {
    await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${id}))`;
      const [row] = await tx<TrashRow[]>`SELECT * FROM filesv2.trash WHERE id=${id}::uuid`;
      if (!row) throw new FilesError("operation_unresolved", 409);
      const action = state === "trashed" ? "item.trash" : "item.restore";
      const activity = await recordHistory(tx, row, action);
      if (row.state === state) return;
      if (!activity || row.state !== (state === "trashed" ? "pending" : "restoring")) throw new FilesError("operation_unresolved", 409);
      if (node.root !== row.root || node.path !== activity.path_after || node.directory !== row.directory)
        throw new FilesError("operation_unresolved", 409);
      await finishActivity(tx, activity.id, "done", async () => {
        await tx`UPDATE filesv2.trash SET state=${state},error_code=NULL,updated_at=now() WHERE id=${id}::uuid`;
        return { itemAfterId: node.id, size: node.size, revisionAfter: node.revision };
      });
    });
  },
  async error(id: string, code: string): Promise<void> {
    await sql`UPDATE filesv2.trash SET error_code=${code},updated_at=now() WHERE id=${id}::uuid AND state IN ('pending','restoring')`;
  },
};
