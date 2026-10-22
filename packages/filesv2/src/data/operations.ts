import { lazySync } from "@k2b/cloud";
import { audit, logger } from "@k2b/cloud/services";
import type { Node } from "@k2b/filegate";
import { sql, type TransactionSQL } from "bun";
import type { Area, BaseKind } from "../contracts";
import type { FilesCall, LifecycleMkdir } from "../service/activity";
import { FilesError } from "../service/errors";
import { finishActivity, insertActivity } from "./activity";

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
  activity_recorded: boolean;
  effect_started: boolean;
  receipt: Node | { deleted: true } | null;
};
/** `wait` can shorten the wait (a shared request budget, a client abort) but never extend it past ROOT_LOCK_WAIT_MS. */
export const withRootLock = <T>(root: string, run: () => Promise<T>, wait?: AbortSignal) =>
  wait && !wait.aborted
    ? withFilesLock(rootLocks(), `root:${root}`, run, AbortSignal.any([wait, rootLockWait()]))
    : withFilesLock(filesLocks(), `root:${root}`, run);
/**
 * One wait budget per request. A caller that locks several entries creates one
 * signal and passes it to every acquisition, waiting at most one budget in total.
 */
export const rootLockWait = () => AbortSignal.timeout(ROOT_LOCK_WAIT_MS);
// Slow transfers must not occupy the domain query pool: reject overload before
// the body is consumed instead of queueing unbounded request bodies.
let activeUploads = 0;
export async function withUploadLock<T>(id: string, run: () => Promise<T>): Promise<T> {
  if (activeUploads >= 4) throw new Error("operation_busy");
  activeUploads++;
  try {
    return await withFilesLock(filesLocks(), `upload:${id}`, run);
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
 * Acquisition defaults to a single attempt. User-facing publications opt into
 * one shared bounded wait per request; background and listing paths do not wait.
 * A longer holder (such as a large commit) still answers busy; browser and CLI
 * upload queues retry busy with backoff.
 * Capability upload locks deliberately do not wait: reject overload before
 * consuming the request body.
 */
export const FILES_LOCK_TTL_MS = 30_000;
export const ROOT_LOCK_WAIT_MS = 5_000;
const filesLocks = lazySync((sync) => sync.mutex({ id: "filesv2:operations", ttlMs: FILES_LOCK_TTL_MS, retry: { maxAttempts: 1 } }));
const rootLocks = lazySync((sync) =>
  sync.mutex({
    id: "filesv2:operations",
    ttlMs: FILES_LOCK_TTL_MS,
    retry: { maxAttempts: Number.MAX_SAFE_INTEGER, delayMs: 100 },
  }),
);
async function withFilesLock<T>(
  mutex: ReturnType<typeof filesLocks>,
  resource: string,
  run: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const lock = await mutex.acquire({ resource, signal });
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
export type NewOperation = Omit<
  Operation,
  "state" | "error_code" | "created_at" | "updated_at" | "activity_recorded" | "effect_started" | "receipt"
>;
type OperationActivity = { id: string; state: string; request_id: string | null; mkdirs: LifecycleMkdir[] | null };
async function operationHistory(
  tx: TransactionSQL,
  op: Operation,
  call?: FilesCall,
  mkdirs?: LifecycleMkdir[],
): Promise<OperationActivity | null> {
  const [existing] = await tx<
    OperationActivity[]
  >`SELECT id,state,request_id,detail->'lifecycle_mkdirs' AS mkdirs FROM filesv2.activity WHERE operation_id=${op.id}::uuid`;
  if (existing) return existing;
  if (op.activity_recorded) return null;
  const id = await insertActivity(
    call ?? { kind: "system", job: "legacy-lifecycle" },
    {
      action:
        op.action === "delete"
          ? "item.purge"
          : op.action === "create"
            ? "place.provision"
            : op.action === "archive"
              ? "place.archive"
              : "place.restore",
      serverUrl: op.server_url,
      root: op.root,
      baseId: op.base_id,
      operationId: op.id,
      directory: op.snapshot?.directory ?? true,
      name: op.action === "delete" ? op.source.split("/").at(-1)! : op.name,
      pathBefore: op.action === "create" ? null : op.source,
      pathAfter: op.action === "create" ? op.source : op.target,
      lifecycleMkdirs: mkdirs,
      itemId: op.snapshot?.id,
      size: op.snapshot?.size,
      revisionBefore: op.snapshot?.revision,
      detail: call ? undefined : { adopted: true },
    },
    tx,
  );
  if (!call)
    await tx`UPDATE filesv2.activity SET actor_kind=CASE WHEN ${op.actor_id}::uuid IS NULL THEN 'system' ELSE 'user' END,
    actor_user_id=(SELECT id FROM auth.users WHERE id=${op.actor_id}::uuid),via='unknown',started_at=${op.created_at},heartbeat_at=${op.updated_at},detail=detail-'job' WHERE id=${id}::uuid`;
  await tx`UPDATE filesv2.operations SET activity_recorded=true WHERE id=${op.id}::uuid`;
  if (op.state !== "pending") {
    await finishActivity(tx, id, "done", async () => {});
    await tx`UPDATE filesv2.activity SET finished_at=${op.updated_at} WHERE id=${id}::uuid`;
  }
  return (
    await tx<
      OperationActivity[]
    >`SELECT id,state,request_id,detail->'lifecycle_mkdirs' AS mkdirs FROM filesv2.activity WHERE id=${id}::uuid`
  )[0]!;
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
  async insert(value: NewOperation, call: FilesCall, mkdirs: LifecycleMkdir[] = []): Promise<Operation> {
    return sql.begin(async (tx) => {
      const [row] = await tx<
        Operation[]
      >`INSERT INTO filesv2.operations(id,area,kind,root,server_url,name,action,source,target,base_id,archive_id,actor_id,actor_name,snapshot)
        VALUES(${value.id}::uuid,${value.area},${value.kind},${value.root},${value.server_url},${value.name},${value.action},${value.source},${value.target},${value.base_id}::uuid,${value.archive_id}::uuid,${value.actor_id}::uuid,${value.actor_name},${value.snapshot}::jsonb) RETURNING *`;
      await operationHistory(tx, row!, call, mkdirs);
      return { ...row!, activity_recorded: true };
    });
  },
  async history(id: string, mkdirs?: LifecycleMkdir[]): Promise<OperationActivity | null> {
    return sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${id}))`;
      const [op] = await tx<Operation[]>`SELECT * FROM filesv2.operations WHERE id=${id}::uuid`;
      if (!op) throw new FilesError("operation_unresolved", 409);
      const activity = await operationHistory(tx, op, undefined, mkdirs);
      if (!activity && op.state === "pending") throw new FilesError("activity_scope_missing", 500);
      return activity;
    });
  },
  async finish(input: { id: string }): Promise<void> {
    await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${input.id}))`;
      const [operation] = await tx<Operation[]>`SELECT * FROM filesv2.operations WHERE id=${input.id}::uuid`;
      if (!operation) throw new FilesError("operation_unresolved", 409);
      const finish = async () => {
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
      };
      const activity = await operationHistory(tx, operation);
      if (operation.state !== "pending") return;
      if (!activity) throw new FilesError("activity_scope_missing", 500);
      await finishActivity(tx, activity.id, "done", async () => {
        if (operation.receipt === null) throw new FilesError("operation_unresolved", 409);
        await finish();
        if (operation.action === "delete")
          await tx`UPDATE filesv2.trash t SET state='gone',updated_at=now() FROM filesv2.bases b
          WHERE t.state='trashed' AND b.id=t.base_id AND t.root=${operation.root} AND t.server_url=${operation.server_url}
          AND (b.path||'/'||t.trashed=${operation.source} OR starts_with(b.path||'/'||t.trashed,${operation.source}||'/'))`;
        await audit.record(
          {
            action: `filesv2.${operation.action}`,
            outcome: "allowed",
            actor: { userId: operation.actor_id, uid: operation.actor_name },
            target: { type: "filesv2.directory", id: operation.id, label: operation.source },
            requestId: activity.request_id,
            metadata: { area: operation.area, root: operation.root, target: operation.target, historyId: activity.id },
          },
          tx,
        );
        return operation.receipt && !("deleted" in operation.receipt)
          ? { itemAfterId: operation.receipt.id, revisionAfter: operation.receipt.revision, size: operation.receipt.size }
          : undefined;
      });
    });
  },
  async beginEffect(id: string): Promise<void> {
    const rows = await sql`UPDATE filesv2.operations SET effect_started=true,updated_at=now()
      WHERE id=${id}::uuid AND state='pending' AND effect_started=false RETURNING id`;
    if (!rows.length) throw new FilesError("operation_unresolved", 409);
  },
  /** Only a definite refusal of an atomic publication permits another send. Recursive removal is never eligible. */
  async refusedEffect(id: string): Promise<void> {
    await sql`UPDATE filesv2.operations SET effect_started=false,updated_at=now()
      WHERE id=${id}::uuid AND state='pending' AND receipt IS NULL AND action IN ('create','archive','restore')`;
  },
  async recordReceipt(id: string, receipt: NonNullable<Operation["receipt"]>): Promise<void> {
    await sql`UPDATE filesv2.operations SET receipt=${receipt}::jsonb,updated_at=now()
      WHERE id=${id}::uuid AND state='pending' AND receipt IS NULL`;
  },
};
