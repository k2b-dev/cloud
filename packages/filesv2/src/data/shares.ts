import { createHash } from "node:crypto";
import { type SQL, sql, type TransactionSQL } from "bun";

export const shareTokenHash = (token: string) => createHash("sha256").update(token).digest("hex");
export type ShareTarget = { path: string; directory: boolean; itemId: string | null };
export type ShareRow = {
  id: string;
  token_hash: string;
  password_hash: string | null;
  kind: "download" | "inbox";
  base_id: string;
  root: string;
  base_path: string;
  /** Original location, independent of activity retention and current binding/access. Null for legacy shares. */
  server_url: string | null;
  target_snapshots: ShareTarget[] | null;
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
  target_snapshots: typeof row.target_snapshots === "string" ? (JSON.parse(row.target_snapshots) as ShareTarget[]) : row.target_snapshots,
  items: typeof row.items === "string" ? (JSON.parse(row.items) as string[]) : row.items,
});
/** Current item identity resolved by the service, never accepted from a browser or historical snapshot. */
export type ShareItemFilter = {
  bindingId: string;
  serverUrl: string;
  root: string;
  basePath: string;
  path: string;
  target: string;
  directory: boolean;
  itemId: string | null;
};
export const shares = {
  async create(
    input: Omit<ShareRow, "id" | "created_at" | "revoked_at" | "revoked_by" | "access_count" | "last_accessed_at">,
    db: SQL | TransactionSQL = sql,
  ): Promise<ShareRow> {
    const [row] = await db<
      ShareRow[]
    >`INSERT INTO filesv2.shares(token_hash,password_hash,kind,base_id,root,base_path,scope,items,title,note,public_note,owner_uid,owner_gid,created_by,created_by_name,expires_at,max_file_size,max_total_size,show_upload_names,server_url,target_snapshots)
      VALUES(${input.token_hash},${input.password_hash},${input.kind},${input.base_id}::uuid,${input.root},${input.base_path},${input.scope},${input.items},${input.title},${input.note},${input.public_note},${input.owner_uid},${input.owner_gid},${input.created_by}::uuid,${input.created_by_name},${input.expires_at},${input.max_file_size},${input.max_total_size},${input.show_upload_names},${input.server_url},${input.target_snapshots === null ? null : JSON.stringify(input.target_snapshots)}::jsonb) RETURNING *`;
    return normalize(row!);
  },
  /** An owner's unscoped management list never depends on retaining access to the old storage.
   * Item matching uses PR5's retained server_url/target_snapshots, independently of activity retention.
   * Filtering happens before the bounded keyset page; it never walks an owner's/all administrators' pages.
   */
  async list(input: {
    ownerId?: string;
    after?: string;
    limit?: number;
    item?: ShareItemFilter;
  }): Promise<{ items: ShareRow[]; next: string | null }> {
    const limit = input.limit ?? 50;
    const item = input.item;
    // JSON null is legacy absence; CASE keeps scalars out of array expansion even if SQL reorders predicates.
    const rows = item
      ? await sql<ShareRow[]>`SELECT * FROM filesv2.shares
      WHERE (${input.ownerId ?? null}::uuid IS NULL OR created_by=${input.ownerId ?? null}::uuid)
      AND base_id=${item.bindingId}::uuid AND root=${item.root} AND base_path=${item.basePath}
        AND (server_url IS NULL OR server_url=${item.serverUrl})
        AND (
          (EXISTS (
            SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(target_snapshots)='array'
              THEN target_snapshots ELSE '[]'::jsonb END) AS target
            WHERE (kind='download' OR ${item.directory})
            AND (target->>'directory')::boolean=${item.directory}
            AND CASE WHEN ${item.itemId}::text IS NOT NULL AND target->>'itemId' IS NOT NULL
              THEN target->>'itemId'=${item.itemId}
              ELSE target->>'path'=${item.target} END
          ))
          OR ((target_snapshots IS NULL OR target_snapshots='null'::jsonb) AND (
            (kind='download' AND items @> ${JSON.stringify([item.path])}::jsonb)
            OR (kind='inbox' AND ${item.directory} AND scope=${item.path})
          ))
        )
      AND (${input.after ?? null}::uuid IS NULL OR (created_at,id)<(SELECT created_at,id FROM filesv2.shares WHERE id=${input.after ?? null}::uuid))
      ORDER BY created_at DESC,id DESC LIMIT ${limit + 1}`
      : await sql<ShareRow[]>`SELECT * FROM filesv2.shares
      WHERE (${input.ownerId ?? null}::uuid IS NULL OR created_by=${input.ownerId ?? null}::uuid)
      AND (${input.after ?? null}::uuid IS NULL OR (created_at,id)<(SELECT created_at,id FROM filesv2.shares WHERE id=${input.after ?? null}::uuid))
      ORDER BY created_at DESC,id DESC LIMIT ${limit + 1}`;
    return { items: rows.slice(0, limit).map(normalize), next: rows.length > limit ? rows[limit - 1]!.id : null };
  },
  async get(id: string, db: SQL | TransactionSQL = sql): Promise<ShareRow | null> {
    const row = (await db<ShareRow[]>`SELECT * FROM filesv2.shares WHERE id=${id}::uuid`)[0];
    return row ? normalize(row) : null;
  },
  async byToken(token: string): Promise<ShareRow | null> {
    const row = (await sql<ShareRow[]>`SELECT * FROM filesv2.shares WHERE token_hash=${shareTokenHash(token)}`)[0];
    return row ? normalize(row) : null;
  },
  async revoke(id: string, userId: string, db: SQL | TransactionSQL = sql): Promise<ShareRow | null> {
    // The conditional update serializes concurrent revokes; only its winner writes history/audit.
    const [row] = await db<ShareRow[]>`UPDATE filesv2.shares SET revoked_at=now(), revoked_by=${userId}::uuid
      WHERE id=${id}::uuid AND revoked_at IS NULL RETURNING *`;
    return row ? normalize(row) : null;
  },
  /** The items of every active public download share in one storage binding. */
  async activeDownloadItems(baseId: string): Promise<string[][]> {
    const rows = await sql<Pick<ShareRow, "items">[]>`SELECT items FROM filesv2.shares
      WHERE base_id=${baseId}::uuid AND kind='download' AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`;
    return rows.map((row) => (typeof row.items === "string" ? (JSON.parse(row.items) as string[]) : row.items));
  },
  async touch(id: string): Promise<void> {
    await sql`UPDATE filesv2.shares SET access_count=access_count+1, last_accessed_at=now() WHERE id=${id}::uuid`;
  },
};
