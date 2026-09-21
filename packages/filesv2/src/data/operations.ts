import { lazySync } from "@k2b/cloud";
import { logger } from "@k2b/cloud/services";
import type { Node } from "@k2b/filegate";
import { sql } from "bun";
import type { Area, BaseKind } from "../contracts";

const log = logger("filesv2:operations");
export type Operation = {
  id: string;
  area: Area;
  kind: BaseKind;
  root: string;
  server_url: string;
  name: string;
  action: "create" | "archive" | "restore" | "delete";
  source: string;
  target: string | null;
  base_id: string | null;
  archive_id: string | null;
  state: "pending" | "complete" | "restored" | "deleted";
  actor_id: string | null;
  actor_name: string | null;
  snapshot: Node | null;
  error_code: string | null;
  created_at: Date;
  updated_at: Date;
};
export const withRootLock = <T>(root: string, run: () => Promise<T>) => withFilesLock(`root:${root}`, run);
// Slow transfers must not occupy the domain query pool: reject overload before
// the body is consumed instead of queueing unbounded request bodies.
let activeUploads = 0;
export async function withUploadLock<T>(id: string, run: () => Promise<T>): Promise<T> {
  if (activeUploads >= 4) throw new Error("operation_busy");
  activeUploads++;
  try {
    return await withFilesLock(`upload:${id}`, run);
  } finally {
    activeUploads--;
  }
}
/**
 * Root and upload operations are leases on the shared broker, not Postgres
 * session locks: `DATABASE_URL` may run through a transaction pooler, which
 * does not pin a backend between statements. A live holder extends its lease
 * every third of the TTL, so the operation itself (Filegate calls of up to ten
 * minutes, streamed uploads of any size) is not bounded by the TTL; only a
 * crashed holder keeps the root or file busy, and for at most the TTL.
 */
export const FILES_LOCK_TTL_MS = 30_000;
const filesLocks = lazySync((sync) => sync.mutex({ id: "filesv2:operations", ttlMs: FILES_LOCK_TTL_MS, retry: { maxAttempts: 1 } }));
async function withFilesLock<T>(resource: string, run: () => Promise<T>): Promise<T> {
  const mutex = filesLocks();
  const lock = await mutex.acquire({ resource });
  if (!lock) throw new Error("operation_busy");
  // A lost lease cannot abort `run` safely; Filegate preconditions and the
  // pending-operation rows are the second line of defense, so the loss is
  // reported and the extension stops.
  let held = true;
  let finished = false;
  const extend = async () => {
    const extended = await mutex.extend(lock).catch(() => false);
    if (extended || finished || !held) return;
    held = false;
    clearInterval(timer);
    log.warn("Operation lease was lost before the operation finished", { resource });
  };
  const timer = setInterval(() => void extend(), Math.floor(FILES_LOCK_TTL_MS / 3));
  timer.unref?.();
  try {
    return await run();
  } finally {
    finished = true;
    clearInterval(timer);
    if (held) await mutex.release(lock).catch(() => undefined);
  }
}
export const operations = {
  async get(id: string): Promise<Operation | null> {
    return (await sql<Operation[]>`SELECT * FROM filesv2.operations WHERE id=${id}::uuid`)[0] ?? null;
  },
  async pending(root: string, source: string): Promise<Operation | null> {
    return (
      (await sql<Operation[]>`SELECT * FROM filesv2.operations WHERE root=${root} AND source=${source} AND state='pending'`)[0] ?? null
    );
  },
  async pendingWithin(root: string, path: string): Promise<Operation | null> {
    return (
      (
        await sql<
          Operation[]
        >`SELECT * FROM filesv2.operations WHERE root=${root} AND state='pending' AND (source=${path} OR starts_with(source,${path}||'/')) ORDER BY created_at,id LIMIT 1`
      )[0] ?? null
    );
  },
  async retiredPath(root: string, path: string): Promise<boolean> {
    const [row] =
      await sql`SELECT 1 FROM filesv2.operations WHERE root=${root} AND source=${path} AND ((action='archive' AND state IN ('complete','deleted')) OR (action='delete' AND state='complete' AND snapshot->>'directory'='true')) LIMIT 1`;
    return Boolean(row);
  },
  async insert(value: Omit<Operation, "state" | "error_code" | "created_at" | "updated_at">): Promise<Operation> {
    const [row] = await sql<
      Operation[]
    >`INSERT INTO filesv2.operations(id,area,kind,root,server_url,name,action,source,target,base_id,archive_id,actor_id,actor_name,snapshot)
    VALUES(${value.id}::uuid,${value.area},${value.kind},${value.root},${value.server_url},${value.name},${value.action},${value.source},${value.target},${value.base_id}::uuid,${value.archive_id}::uuid,${value.actor_id}::uuid,${value.actor_name},${value.snapshot}::jsonb) RETURNING *`;
    return row!;
  },
  async finish(operation: Operation): Promise<void> {
    await sql.begin(async (tx) => {
      await tx`UPDATE filesv2.operations SET state='complete',error_code=NULL,updated_at=now() WHERE id=${operation.id}::uuid`;
      if (operation.base_id && (operation.action === "create" || operation.action === "restore"))
        await tx`UPDATE filesv2.bases SET lifecycle='active' WHERE id=${operation.base_id}::uuid`;
      if (operation.base_id && operation.action === "archive")
        await tx`UPDATE filesv2.bases SET lifecycle='archived' WHERE id=${operation.base_id}::uuid`;
      if (operation.base_id && operation.action === "delete") {
        await tx`UPDATE filesv2.bases SET lifecycle='deleted' WHERE id=${operation.base_id}::uuid AND (path=${operation.source} OR EXISTS (SELECT 1 FROM filesv2.operations a WHERE a.id=${operation.archive_id}::uuid AND a.target=${operation.source}))`;
      }
      if (operation.archive_id && operation.action === "restore")
        await tx`UPDATE filesv2.operations SET state='restored',updated_at=now() WHERE id=${operation.archive_id}::uuid`;
      if (operation.archive_id && operation.action === "delete")
        await tx`UPDATE filesv2.operations SET state='deleted',updated_at=now() WHERE id=${operation.archive_id}::uuid AND target=${operation.source}`;
    });
  },
};
