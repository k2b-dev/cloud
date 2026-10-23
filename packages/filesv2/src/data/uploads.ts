import type { ExecutionIdentity, Node, WriteOptions } from "@k2b/filegate";
import { sql, type TransactionSQL } from "bun";
import type { FilesCall, Intent } from "../service/activity";
import { FilesError } from "../service/errors";
import { finishActivity, insertActivity } from "./activity";

export type Upload = {
  id: string;
  base_id: string;
  user_id: string;
  root: string;
  path: string;
  size: number;
  state: "open" | "committed" | "aborted" | "expired";
  result: Node | null;
  share_id: string | null;
  filegate_session_id: string | null;
  server_url: string;
  write_options: WriteOptions | null;
  execution: ExecutionIdentity | null;
  expires_at: Date | null;
  retain_until: Date | null;
  error_code: string | null;
  expected_revision: string | null;
  created_at: Date;
  updated_at: Date;
  activity_recorded: boolean;
};
const normalize = (row: Upload): Upload => ({
  ...row,
  size: Number(row.size),
  result: typeof row.result === "string" ? (JSON.parse(row.result) as Node) : row.result,
});
export const uploadSessionId = (row: Upload) => row.filegate_session_id ?? (row.share_id || row.write_options ? null : row.id);
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
};
export const sameUploadOptions = (a: WriteOptions | null, b: WriteOptions | null) => canonical(a) === canonical(b);
export const normalizeExecution = (identity: ExecutionIdentity | null): ExecutionIdentity | null =>
  identity ? { uid: identity.uid, gid: identity.gid, groups: [...new Set(identity.groups ?? [])].sort((a, b) => a - b) } : null;
export const sameUploadExecution = (a: ExecutionIdentity | null, b: ExecutionIdentity | null) =>
  canonical(normalizeExecution(a)) === canonical(normalizeExecution(b));
type Reservation = Pick<Upload, "id" | "base_id" | "user_id" | "root" | "path" | "size" | "server_url"> & {
  expected_revision?: string | null;
  write_options: WriteOptions;
  execution: ExecutionIdentity | null;
};
function reservationOptions(options: WriteOptions | null): WriteOptions | null {
  if (!options?.metadata || !Object.hasOwn(options.metadata, "activity")) return options;
  const { activity: _activity, ...metadata } = options.metadata;
  return { ...options, metadata: Object.keys(metadata).length ? metadata : undefined };
}
function verifyReservation(row: Upload, input: Reservation & { share_id?: string | null }) {
  if (
    row.expected_revision !== (input.expected_revision ?? null) ||
    row.base_id !== input.base_id ||
    row.user_id !== input.user_id ||
    row.root !== input.root ||
    row.path !== input.path ||
    row.size !== input.size ||
    row.server_url !== input.server_url ||
    row.share_id !== (input.share_id ?? null) ||
    !sameUploadOptions(reservationOptions(row.write_options), reservationOptions(input.write_options)) ||
    !sameUploadExecution(row.execution, input.execution)
  )
    throw new FilesError("upload_changed", 409);
  return row;
}
export type UploadHistory = {
  call: FilesCall;
  target: string;
  previous: Pick<Node, "id" | "revision"> | null;
};
export type UploadActivity = {
  id: string;
  state: "pending" | "unclear" | "done" | "failed" | "not_done";
  action: "file.upload" | "file.overwrite";
  server_url: string;
  root: string;
  base_id: string;
  path_after: string;
  size: number;
  name: string;
};
async function recordHistory(tx: TransactionSQL, row: Upload, history: UploadHistory) {
  const intent: Intent = {
    action: history.previous ? "file.overwrite" : "file.upload",
    serverUrl: row.server_url,
    root: row.root,
    baseId: row.base_id,
    directory: false,
    name: row.path.split("/").at(-1)!,
    pathBefore: history.previous ? history.target : null,
    pathAfter: history.target,
    itemId: history.previous?.id,
    revisionBefore: history.previous?.revision,
    size: row.size,
  };
  const id = await insertActivity(history.call, intent, tx, row.id);
  const options = { ...row.write_options, metadata: { ...row.write_options?.metadata, activity: id } };
  await tx`UPDATE filesv2.uploads SET write_options=${options},activity_recorded=true WHERE id=${row.id}`;
  return { ...row, write_options: options, activity_recorded: true };
}
/** Old journals retain their original person/link, even when a different caller resumes them. */
async function historyFor(tx: TransactionSQL, row: Upload): Promise<UploadActivity | null> {
  const [existing] = await tx<UploadActivity[]>`SELECT * FROM filesv2.activity WHERE upload_id=${row.id}`;
  if (existing) {
    if (!row.activity_recorded) await tx`UPDATE filesv2.uploads SET activity_recorded=true WHERE id=${row.id}`;
    return existing;
  }
  // Purging an old terminal activity is final; a later receipt/status read must not resurrect it.
  if (row.activity_recorded) return null;
  const [binding] = await tx<
    { path: string }[]
  >`SELECT coalesce(s.base_path,b.path) AS path FROM filesv2.bases b LEFT JOIN filesv2.shares s ON s.id=${row.share_id}::uuid WHERE b.id=${row.base_id}::uuid`;
  if (!binding) throw new FilesError("upload_changed", 409);
  const target = [binding.path, row.path].filter(Boolean).join("/");
  const id = Bun.randomUUIDv7();
  const condition = row.write_options?.precondition;
  const revision = condition && "ifMatch" in condition ? condition.ifMatch : null;
  const overwrite = Boolean(revision || row.expected_revision);
  await tx`INSERT INTO filesv2.activity(id,state,action,server_url,root,base_id,directory,name,path_after,size,actor_kind,actor_user_id,via,share_id,upload_id,detail,started_at,path_before,revision_before)
    VALUES(${id}::uuid,'pending',${overwrite ? "file.overwrite" : "file.upload"},${row.server_url},${row.root},${row.base_id}::uuid,false,${row.path.split("/").at(-1)!},${target},${row.size},${row.share_id ? "visitor" : "user"},
    (SELECT id FROM auth.users WHERE id=${row.user_id}::uuid AND ${row.share_id === null}),'unknown',${row.share_id}::uuid,${row.id},'{"adopted":true}'::jsonb,${row.created_at},${overwrite ? target : null},${revision})`;
  await tx`UPDATE filesv2.uploads SET activity_recorded=true WHERE id=${row.id}`;
  if (row.state !== "open") {
    await finishActivity(tx, id, row.state === "committed" ? "done" : "not_done", async () => ({
      pathAfter: row.result?.path,
      itemAfterId: row.result?.id,
      revisionAfter: row.result?.revision,
      size: row.result?.size,
    }));
    await tx`UPDATE filesv2.activity SET finished_at=${row.updated_at} WHERE id=${id}::uuid`;
  }
  return (await tx<UploadActivity[]>`SELECT * FROM filesv2.activity WHERE id=${id}::uuid`)[0]!;
}
export const uploads = {
  async create(
    input: Pick<Upload, "id" | "base_id" | "user_id" | "root" | "path" | "size"> & {
      share_id?: string | null;
      expires_at?: Date;
      server_url?: string;
    },
  ): Promise<Upload> {
    const [row] = await sql<
      Upload[]
    >`INSERT INTO filesv2.uploads(id,base_id,user_id,root,path,size,share_id,filegate_session_id,expires_at,server_url)
      VALUES(${input.id},${input.base_id}::uuid,${input.user_id}::uuid,${input.root},${input.path},${input.size},${input.share_id ?? null}::uuid,${input.id},${input.expires_at ?? null},${input.server_url ?? ""}) RETURNING *`;
    return normalize(row!);
  },
  async reservePrivate(input: Reservation, history: UploadHistory): Promise<Upload> {
    return sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${input.id}))`;
      const [existing] = await tx<Upload[]>`SELECT * FROM filesv2.uploads WHERE id=${input.id}`;
      if (existing) {
        const row = verifyReservation(normalize(existing), input);
        await historyFor(tx, row);
        return row;
      }
      const [row] = await tx<
        Upload[]
      >`INSERT INTO filesv2.uploads(id,base_id,user_id,root,path,size,error_code,server_url,write_options,execution,expected_revision)
        VALUES(${input.id},${input.base_id}::uuid,${input.user_id}::uuid,${input.root},${input.path},${input.size},'opening',${input.server_url},${input.write_options},${normalizeExecution(input.execution)},${input.expected_revision ?? null}) RETURNING *`;
      const normalized = normalize(row!);
      return recordHistory(tx, normalized, history);
    });
  },
  /** Serialize quota decisions on the share row; committed bytes count for the link's entire lifetime. */
  async reserve(input: Reservation & { share_id: string }, history: UploadHistory): Promise<Upload> {
    return sql.begin(async (tx) => {
      const [share] = await tx<
        { max_file_size: string; max_total_size: string; revoked_at: Date | null; expires_at: Date | null }[]
      >`SELECT max_file_size,max_total_size,revoked_at,expires_at FROM filesv2.shares WHERE id=${input.share_id}::uuid FOR UPDATE`;
      if (!share || share.revoked_at || (share.expires_at && share.expires_at.getTime() <= Date.now()))
        throw new FilesError("not_found", 404);
      await tx`SELECT pg_advisory_xact_lock(hashtext(${input.id}))`;
      const [existing] = await tx<Upload[]>`SELECT * FROM filesv2.uploads WHERE id=${input.id}`;
      if (existing) {
        const row = verifyReservation(normalize(existing), input);
        await historyFor(tx, row);
        return row;
      }
      if (!Number.isSafeInteger(input.size) || input.size < 0 || input.size > Number(share.max_file_size))
        throw new FilesError("inbox_file_limit", 409);
      const [usage] = await tx<
        { bytes: string; opened: number }[]
      >`SELECT COALESCE(sum(size) FILTER (WHERE state IN ('open','committed')),0)::text AS bytes,count(*) FILTER (WHERE state='open')::int AS opened FROM filesv2.uploads WHERE share_id=${input.share_id}::uuid`;
      if (BigInt(usage?.bytes ?? "0") + BigInt(input.size) > BigInt(share.max_total_size)) throw new FilesError("inbox_total_limit", 409);
      if ((usage?.opened ?? 0) >= 20) throw new FilesError("inbox_busy", 409);
      const [row] = await tx<
        Upload[]
      >`INSERT INTO filesv2.uploads(id,base_id,user_id,root,path,size,share_id,error_code,server_url,write_options,execution,expected_revision)
        VALUES(${input.id},${input.base_id}::uuid,${input.user_id}::uuid,${input.root},${input.path},${input.size},${input.share_id}::uuid,'opening',${input.server_url},${input.write_options},${normalizeExecution(input.execution)},${input.expected_revision ?? null}) RETURNING *`;
      const normalized = normalize(row!);
      return recordHistory(tx, normalized, history);
    });
  },
  async attachSession(id: string, session: { id: string; expires?: string; retainUntil?: string }): Promise<void> {
    await sql`UPDATE filesv2.uploads SET filegate_session_id=${session.id},expires_at=${session.expires ? new Date(session.expires) : null},retain_until=${session.retainUntil ? new Date(session.retainUntil) : null},error_code=NULL,updated_at=now() WHERE id=${id} AND state='open'`;
  },
  async getForShare(id: string, shareId: string): Promise<Upload | null> {
    const [row] = await sql<Upload[]>`SELECT * FROM filesv2.uploads WHERE id=${id} AND share_id=${shareId}::uuid`;
    return row ? normalize(row) : null;
  },
  async get(id: string, userId: string): Promise<Upload | null> {
    const [row] = await sql<Upload[]>`SELECT * FROM filesv2.uploads WHERE id=${id} AND user_id=${userId}::uuid`;
    return row ? normalize(row) : null;
  },
  async pendingForShare(shareId: string): Promise<Upload[]> {
    return (
      await sql<Upload[]>`SELECT * FROM filesv2.uploads WHERE share_id=${shareId}::uuid AND state='open' ORDER BY updated_at,id LIMIT 20`
    ).map(normalize);
  },
  async pending(limit = 50): Promise<Upload[]> {
    return (
      await sql<Upload[]>`SELECT * FROM filesv2.uploads WHERE state='open' AND share_id IS NOT NULL ORDER BY updated_at,id LIMIT ${limit}`
    ).map(normalize);
  },
  async uncertain(after?: string): Promise<{ items: Upload[]; next: string | null }> {
    const rows = await sql<
      Upload[]
    >`SELECT * FROM filesv2.uploads WHERE state='open' AND share_id IS NOT NULL AND error_code IS NOT NULL AND (${after ?? null}::text IS NULL OR id>${after ?? null}) ORDER BY id LIMIT 51`;
    return { items: rows.slice(0, 50).map(normalize), next: rows.length > 50 ? rows[49]!.id : null };
  },
  async names(shareId: string, after?: string): Promise<{ items: string[]; next: string | null }> {
    const rows = (
      await sql<
        Upload[]
      >`SELECT * FROM filesv2.uploads WHERE share_id=${shareId}::uuid AND state='committed' AND (${after ?? null}::text IS NULL OR id>${after ?? null}) ORDER BY id LIMIT 51`
    ).map(normalize);
    return {
      items: rows.slice(0, 50).flatMap((row) => (row.result ? [row.result.path.split("/").at(-1)!] : [])),
      next: rows.length > 50 ? rows[49]!.id : null,
    };
  },
  async unresolved(id: string, code = "receipt_unknown"): Promise<void> {
    await sql`UPDATE filesv2.uploads SET error_code=${code},updated_at=now() WHERE id=${id} AND state='open'`;
  },
  async history(id: string): Promise<{ upload: Upload; activity: UploadActivity | null }> {
    return sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${id}))`;
      const [stored] = await tx<Upload[]>`SELECT * FROM filesv2.uploads WHERE id=${id}`;
      if (!stored) throw new FilesError("upload_changed", 409);
      const upload = normalize(stored);
      return { upload, activity: await historyFor(tx, upload) };
    });
  },
  async finish(id: string, state: "committed" | "aborted" | "expired", result: Node | null): Promise<void> {
    await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${id}))`;
      const [stored] = await tx<Upload[]>`SELECT * FROM filesv2.uploads WHERE id=${id}`;
      if (!stored) throw new FilesError("upload_changed", 409);
      const row = normalize(stored);
      const activity = await historyFor(tx, row);
      if (row.state !== "open") return;
      if (!activity) throw new FilesError("activity_scope_missing", 500);
      if (
        state === "committed" &&
        (!result ||
          result.root !== row.root ||
          result.directory ||
          result.size !== row.size ||
          (row.write_options?.onConflict === "rename" || (!row.write_options && row.share_id)
            ? result.path.split("/").slice(0, -1).join("/") !== activity.path_after.split("/").slice(0, -1).join("/")
            : result.path !== activity.path_after))
      )
        throw new FilesError("upload_changed", 409);
      await finishActivity(tx, activity.id, state === "committed" ? "done" : "not_done", async () => {
        await tx`UPDATE filesv2.uploads SET state=${state},result=${result},error_code=NULL,updated_at=now() WHERE id=${id} AND state='open'`;
        return { itemAfterId: result?.id, pathAfter: result?.path, size: result?.size, revisionAfter: result?.revision };
      });
    });
  },
};
