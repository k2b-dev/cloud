import { FilegateError, type Node } from "@k2b/filegate";
import { sql, type TransactionSQL } from "bun";
import type { FilesCall, Intent, UserFilesCall } from "../service/activity";
import { FilesError } from "../service/errors";
import type { FilesRoot } from "../service/filegate-facade";
import { relativePath } from "../service/paths";
import { finishActivity, insertActivity } from "./activity";
import type { Operation } from "./operations";

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
/** Called only after confirmed deletion, while the caller holds the root publication lock. */
export async function finishDeletedTrash(tx: TransactionSQL, operation: Operation, root: FilesRoot): Promise<void> {
  if (!operation.base_id || operation.action !== "delete" || root.name !== operation.root) return;
  // Archived bindings keep their original path. Only the linked archive can
  // supply their physical base; never interpret the old path as its contents.
  const [base] = await tx<{ path: string }[]>`SELECT CASE WHEN ${operation.archive_id}::uuid IS NULL THEN b.path ELSE a.target END AS path
    FROM filesv2.bases b LEFT JOIN filesv2.operations a ON a.id=${operation.archive_id}::uuid
    AND a.action='archive' AND a.state='complete' AND a.base_id=b.id AND a.root=b.root
    AND a.server_url=${operation.server_url} AND a.source=b.path AND a.area=b.area AND a.kind=b.kind
    WHERE b.id=${operation.base_id}::uuid AND b.root=${operation.root} AND b.area=${operation.area} AND b.kind=${operation.kind}
    AND ((${operation.archive_id}::uuid IS NULL AND b.lifecycle NOT IN ('archived','deleted')) OR a.target IS NOT NULL)`;
  if (!base?.path || !(operation.source === base.path || operation.source.startsWith(`${base.path}/`))) return;
  // The existing list page size bounds memory. The initial journal count
  // bounds the number of pages even if rows change during reconciliation.
  const [count] = await tx<{ total: number }[]>`SELECT count(*)::integer AS total FROM filesv2.trash
    WHERE base_id=${operation.base_id}::uuid AND root=${operation.root} AND server_url=${operation.server_url}`;
  let after: string | null = null;
  for (let remaining = count!.total; remaining > 0; remaining -= 50) {
    const candidates: TrashRow[] = await tx<TrashRow[]>`SELECT * FROM filesv2.trash
      WHERE base_id=${operation.base_id}::uuid AND root=${operation.root} AND server_url=${operation.server_url}
      AND state IN ('pending','trashed','restoring') AND (${after}::uuid IS NULL OR id>${after}::uuid)
      AND (EXISTS (SELECT 1 FROM unnest(ARRAY[trashed,CASE state WHEN 'pending' THEN original WHEN 'restoring' THEN restore_path END]) AS endpoints(endpoint)
        WHERE ${base.path}||'/'||endpoint=${operation.source} OR starts_with(${base.path}||'/'||endpoint,${operation.source}||'/')))
      ORDER BY id LIMIT 50`;
    if (!candidates.length) break;
    for (const candidate of candidates) {
      // Same order as normal journal completion: journal advisory lock, then
      // activity rows. Recovery may have changed the phase since selection.
      await tx`SELECT pg_advisory_xact_lock(hashtext(${candidate.id}))`;
      const [row] = await tx<TrashRow[]>`SELECT * FROM filesv2.trash WHERE id=${candidate.id}::uuid
        AND base_id=${operation.base_id}::uuid AND root=${operation.root} AND server_url=${operation.server_url}`;
      if (!row || !["pending", "trashed", "restoring"].includes(row.state)) continue;
      const opposite = row.state === "pending" ? row.original : row.state === "restoring" ? row.restore_path : null;
      const endpoints = row.state === "trashed" ? [row.trashed] : [row.trashed, opposite];
      if (
        !endpoints.some(
          (path) => path && (`${base.path}/${path}` === operation.source || `${base.path}/${path}`.startsWith(`${operation.source}/`)),
        )
      )
        continue;
      if (row.state !== "trashed") {
        let absent = true;
        for (const path of endpoints) {
          if (!path) {
            absent = false;
            break;
          }
          try {
            // Validate persisted paths too. Unknown/malformed endpoints and
            // outages preserve the journal, including on a delayed retry.
            await root.stat(`${base.path}/${relativePath(path, false)}`);
            absent = false;
          } catch (error) {
            if (!(error instanceof FilegateError && error.status === 404)) absent = false;
          }
        }
        if (!absent) continue;
      }
      // Adopt while the old phase still describes what is known. Adopting a
      // pending row after 'gone' would manufacture completed trash history.
      await recordHistory(tx, row, "item.trash");
      if (row.state === "restoring") await recordHistory(tx, row, "item.restore");
      await tx`UPDATE filesv2.activity SET state='unclear',next_check_at='infinity'::timestamptz,
        detail=detail || '{"final":true}'::jsonb WHERE trash_id=${row.id}::uuid AND state IN ('pending','unclear')`;
      await tx`UPDATE filesv2.trash SET state='gone',error_code=NULL,updated_at=now() WHERE id=${row.id}::uuid`;
    }
    after = candidates.at(-1)!.id;
  }
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
