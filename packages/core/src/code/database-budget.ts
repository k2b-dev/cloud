import { CodeBridgeRefusal } from "@k2b/cloud/api";
import type { SQL } from "bun";

/** SQL uses the exact immutable owner identity, never the caller or a display label. */
export async function codeDatabaseOwnerCapacity(db: SQL, codeId: string): Promise<number> {
  const [row] = await db<{ bytes: string }[]>`SELECT COALESCE(sum(d.reserved_bytes),0)::text AS bytes
    FROM code.codes owner JOIN code.codes c ON c.owner_kind=owner.owner_kind AND
      ((c.owner_kind='person' AND c.owner_user_id=owner.owner_user_id) OR
       (c.owner_kind='resource' AND c.owner_type=owner.owner_type AND c.owner_id=owner.owner_id) OR
       (c.owner_kind='app' AND c.owner_app_id=owner.owner_app_id))
    JOIN code.databases d ON d.code_id=c.id WHERE owner.id=${codeId}`;
  return Number(row?.bytes ?? 0);
}

/** Reserve the entire server-enforced ceiling before a remote create or quota increase can happen.
 * Reservations survive ambiguous writes, outages and restarts; no Core connection is held during SQL execution.
 */
export async function reserveCodeDatabaseCapacity(db: SQL, codeId: string, bytes: number, limit: number, grow: boolean) {
  const [existing] = await db<{ reserved_bytes: string }[]>`
    SELECT reserved_bytes::text FROM code.databases WHERE code_id=${codeId}`;
  const reserved = Number(existing?.reserved_bytes ?? 0);
  // Existing ceilings remain usable after an owner limit is lowered. Reads never need a quota increase.
  if (reserved && (bytes <= reserved || !grow)) return reserved;
  const [owner] = await db<
    { key: string }[]
  >`SELECT jsonb_build_array(owner_kind,owner_user_id,owner_type,owner_id,owner_app_id)::text AS key
    FROM code.codes WHERE id=${codeId}`;
  if (!owner) throw new CodeBridgeRefusal("code_not_active");
  // Only reservations serialize across an owner; ordinary calls never contend on this lock.
  await db`SELECT pg_advisory_xact_lock(hashtextextended(${`core.code.database-owner:${owner.key}`},0))`;
  const [mapping] = await db<{ reserved_bytes: string }[]>`
    SELECT reserved_bytes::text FROM code.databases WHERE code_id=${codeId} FOR UPDATE`;
  const current = Number(mapping?.reserved_bytes ?? 0);
  if (bytes <= current) return current;
  const total = await codeDatabaseOwnerCapacity(db, codeId);
  if (total + bytes - current > limit) throw new CodeBridgeRefusal("code_db_owner_full");
  return bytes;
}
