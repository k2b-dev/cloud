import type { ExecutionIdentity, Node, WriteOptions } from "@k2b/filegate";
import { sql } from "bun";
import { FilesError } from "../service/errors";

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
  created_at: Date;
  updated_at: Date;
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
  write_options: WriteOptions;
  execution: ExecutionIdentity | null;
};
function verifyReservation(row: Upload, input: Reservation & { share_id?: string | null }) {
  if (
    row.base_id !== input.base_id ||
    row.user_id !== input.user_id ||
    row.root !== input.root ||
    row.path !== input.path ||
    row.size !== input.size ||
    row.server_url !== input.server_url ||
    row.share_id !== (input.share_id ?? null) ||
    !sameUploadOptions(row.write_options, input.write_options) ||
    !sameUploadExecution(row.execution, input.execution)
  )
    throw new FilesError("upload_changed", 409);
  return row;
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
  async reservePrivate(input: Reservation): Promise<Upload> {
    return sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${input.id}))`;
      const [existing] = await tx<Upload[]>`SELECT * FROM filesv2.uploads WHERE id=${input.id}`;
      if (existing) return verifyReservation(normalize(existing), input);
      const [row] = await tx<
        Upload[]
      >`INSERT INTO filesv2.uploads(id,base_id,user_id,root,path,size,error_code,server_url,write_options,execution)
        VALUES(${input.id},${input.base_id}::uuid,${input.user_id}::uuid,${input.root},${input.path},${input.size},'opening',${input.server_url},${input.write_options},${normalizeExecution(input.execution)}) RETURNING *`;
      return normalize(row!);
    });
  },
  /** Serialize quota decisions on the share row; committed bytes count for the link's entire lifetime. */
  async reserve(input: Reservation & { share_id: string }): Promise<Upload> {
    return sql.begin(async (tx) => {
      const [share] = await tx<
        { max_file_size: string; max_total_size: string; revoked_at: Date | null; expires_at: Date | null }[]
      >`SELECT max_file_size,max_total_size,revoked_at,expires_at FROM filesv2.shares WHERE id=${input.share_id}::uuid FOR UPDATE`;
      if (!share || share.revoked_at || (share.expires_at && share.expires_at.getTime() <= Date.now()))
        throw new FilesError("not_found", 404);
      await tx`SELECT pg_advisory_xact_lock(hashtext(${input.id}))`;
      const [existing] = await tx<Upload[]>`SELECT * FROM filesv2.uploads WHERE id=${input.id}`;
      if (existing) return verifyReservation(normalize(existing), input);
      if (!Number.isSafeInteger(input.size) || input.size < 0 || input.size > Number(share.max_file_size))
        throw new FilesError("inbox_file_limit", 409);
      const [usage] = await tx<
        { bytes: string; opened: number }[]
      >`SELECT COALESCE(sum(size) FILTER (WHERE state IN ('open','committed')),0)::text AS bytes,count(*) FILTER (WHERE state='open')::int AS opened FROM filesv2.uploads WHERE share_id=${input.share_id}::uuid`;
      if (BigInt(usage?.bytes ?? "0") + BigInt(input.size) > BigInt(share.max_total_size)) throw new FilesError("inbox_total_limit", 409);
      if ((usage?.opened ?? 0) >= 20) throw new FilesError("inbox_busy", 409);
      const [row] = await tx<
        Upload[]
      >`INSERT INTO filesv2.uploads(id,base_id,user_id,root,path,size,share_id,error_code,server_url,write_options,execution)
        VALUES(${input.id},${input.base_id}::uuid,${input.user_id}::uuid,${input.root},${input.path},${input.size},${input.share_id}::uuid,'opening',${input.server_url},${input.write_options},${normalizeExecution(input.execution)}) RETURNING *`;
      return normalize(row!);
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
  async finish(id: string, state: "committed" | "aborted" | "expired", result: Node | null): Promise<void> {
    // Terminal receipts are monotonic. An abort racing a successful commit cannot erase the committed budget.
    await sql`UPDATE filesv2.uploads SET state=${state},result=${result},error_code=NULL,updated_at=now() WHERE id=${id} AND state='open'`;
  },
};
