import { AsyncLocalStorage } from "node:async_hooks";
import type { AccessSubject, RequestActor } from "@k2b/cloud/server";
import { logger } from "@k2b/cloud/services";
import { FilegateError } from "@k2b/filegate";
import { sql, type TransactionSQL } from "bun";
import { filegateErrorCode } from "../api/filegate-error";
import type { readConfiguration } from "./configuration";
import { FilesError } from "./errors";
import type { FilesFilegate } from "./filegate-facade";

export type Via = "web" | "app" | "api" | "cli" | "office" | "agent" | "link" | "system" | "observed" | `app:${string}`;
export type FilesCall =
  | {
      kind: "user";
      actor: RequestActor;
      accessSubject: AccessSubject;
      via: Via;
      requestId: string | null;
      invocationId: string | null;
      callingApp: string | null;
      origin: string | null;
    }
  | { kind: "visitor"; shareId: string; requestId: string | null }
  | { kind: "system"; job: string };
export type UserFilesCall = Extract<FilesCall, { kind: "user" }>;
export type ActivityAction = "folder.create";
export type Intent = {
  action: ActivityAction;
  serverUrl: string;
  root: string;
  rootAfter?: string | null;
  baseId: string | null;
  baseAfterId?: string | null;
  itemId?: string | null;
  itemAfterId?: string | null;
  directory: boolean;
  name: string;
  pathBefore?: string | null;
  pathAfter?: string | null;
  size?: number | null;
  revisionBefore?: string | null;
  versionId?: string | null;
  batchId?: string | null;
  detail?: Record<string, unknown>;
};
export type Finished = {
  itemAfterId?: string | null;
  size?: number | null;
  revisionAfter?: string | null;
  pathAfter?: string | null;
  detail?: Record<string, unknown>;
} | void;

// May only shrink; the freeze test fails if this list grows.
export const PENDING_MIGRATION = [
  "files.upload_session",
  "files.write_bytes",
  "files.rename",
  "files.move",
  "files.copy",
  "files.ensure_trash",
  "files.version_comment",
  "files.version_restore",
  "files.version_restore_copy",
  "files.version_delete",
  "trash.transfer",
  "sharing.inbox_session",
  "lifecycle.operation",
  "lifecycle.admin_delete_version",
] as const;
export type PendingMigrationKey = (typeof PENDING_MIGRATION)[number];
export type GuardScope =
  | { kind: "activity"; id: string; intent: Intent; closed: boolean; sent: number; refused: unknown }
  | { kind: "pending"; key: PendingMigrationKey }
  | { kind: "exception"; name: "lifecycle.probe" };
const scopes = new AsyncLocalStorage<GuardScope>();
export const currentScope = (): GuardScope | undefined => scopes.getStore();
export function pendingMigration<T>(key: PendingMigrationKey, run: () => Promise<T>): Promise<T> {
  return scopes.run({ kind: "pending", key }, run);
}
export function filegateException<T>(name: "lifecycle.probe", run: () => Promise<T>): Promise<T> {
  return scopes.run({ kind: "exception", name }, run);
}
export const systemCall = (job: string): FilesCall => ({ kind: "system", job });
export const visitorCall = (shareId: string, requestId: string | null): FilesCall => ({ kind: "visitor", shareId, requestId });
const log = logger("filesv2:activity");

function certainNoChange(scope: Extract<GuardScope, { kind: "activity" }>, error: unknown): boolean {
  if (scope.sent === 0) return (error instanceof FilesError || error instanceof FilegateError) && [403, 404].includes(error.status);
  return (
    scope.sent === 1 &&
    error === scope.refused &&
    error instanceof FilegateError &&
    ([403, 404].includes(error.status) || (error.status === 409 && filegateErrorCode(error) === "path_conflict"))
  );
}

export async function fileAction<T>(
  call: FilesCall,
  intent: Intent,
  effect: () => Promise<T>,
  finish: (tx: TransactionSQL, result: T) => Promise<Finished>,
  options?: { heartbeatMs?: number },
): Promise<T> {
  const id = Bun.randomUUIDv7();
  const userId = call.kind === "user" ? (call.actor.kind === "user" ? call.actor.user.id : (call.actor.delegatedUser?.id ?? null)) : null;
  const detail = { ...intent.detail, ...(call.kind === "system" ? { job: call.job } : {}) };
  // An independently committed intent is the prerequisite for every external effect.
  await sql`INSERT INTO filesv2.activity(id,state,action,server_url,root,root_after,base_id,base_after_id,item_id,item_after_id,directory,name,path_before,path_after,size,revision_before,version_id,actor_kind,actor_user_id,via,calling_app,origin,invocation_id,request_id,batch_id,share_id,detail)
    VALUES(${id}::uuid,'pending',${intent.action},${intent.serverUrl},${intent.root},${intent.rootAfter ?? null},${intent.baseId}::uuid,${intent.baseAfterId ?? null}::uuid,${intent.itemId ?? null},${intent.itemAfterId ?? null},${intent.directory},${intent.name},${intent.pathBefore ?? null},${intent.pathAfter ?? null},${intent.size ?? null},${intent.revisionBefore ?? null},${intent.versionId ?? null},${call.kind},${userId}::uuid,${call.kind === "user" ? call.via : call.kind === "visitor" ? "link" : "system"},${call.kind === "user" ? call.callingApp : null},${call.kind === "user" ? call.origin : null},${call.kind === "user" ? call.invocationId : null},${call.kind !== "system" ? call.requestId : null},${intent.batchId ?? null}::uuid,${call.kind === "visitor" ? call.shareId : null}::uuid,${detail}::jsonb)`;
  const scope: Extract<GuardScope, { kind: "activity" }> = { kind: "activity", id, intent, closed: false, sent: 0, refused: undefined };
  const timer = setInterval(() => {
    void sql`UPDATE filesv2.activity SET heartbeat_at=now() WHERE id=${id}::uuid AND state IN ('pending','unclear')`.catch(
      (error: unknown) => log.error("Activity heartbeat failed", { id, error }),
    );
  }, options?.heartbeatMs ?? 10_000);
  timer.unref();
  let result: T;
  try {
    try {
      result = await scopes.run(scope, effect);
    } finally {
      scope.closed = true;
      clearInterval(timer);
    }
  } catch (error) {
    if (certainNoChange(scope, error)) {
      try {
        await sql`UPDATE filesv2.activity SET state='failed',finished_at=now(),error_code=${error instanceof FilesError ? error.code : error instanceof FilegateError ? filegateErrorCode(error) : "operation_unresolved"} WHERE id=${id}::uuid AND state='pending'`;
      } catch (failure) {
        log.error("Activity failure could not be recorded", { id, error: failure });
      }
    }
    throw error;
  }
  await sql.begin(async (tx) => {
    const [row] = await tx<{ state: string }[]>`SELECT state FROM filesv2.activity WHERE id=${id}::uuid FOR UPDATE`;
    if (!row) throw new FilesError("activity_scope_missing", 500);
    if (["done", "failed", "not_done"].includes(row.state)) return;
    const finished = await finish(tx, result);
    await tx`UPDATE filesv2.activity SET state='done',finished_at=now(),error_code=NULL,
      item_after_id=coalesce(${finished?.itemAfterId ?? null},item_after_id),size=coalesce(${finished?.size ?? null},size),
      revision_after=${finished?.revisionAfter ?? null},path_after=coalesce(${finished?.pathAfter ?? null},path_after),
      detail=detail || ${finished?.detail ?? {}}::jsonb WHERE id=${id}::uuid`;
  });
  return result;
}

type Config = Awaited<ReturnType<typeof readConfiguration>>;
type RecoveryRow = {
  id: string;
  action: ActivityAction;
  state: "pending" | "unclear";
  server_url: string;
  root: string;
  path_after: string | null;
  started_at: Date;
};
export async function recoverActivity(input: {
  now: Date;
  connect: (config: Config) => FilesFilegate;
  config: Config | null;
  signal?: AbortSignal;
  heartbeat?: () => Promise<void>;
}): Promise<{ checked: number }> {
  input.signal?.throwIfAborted();
  const rows = await sql<
    RecoveryRow[]
  >`UPDATE filesv2.activity SET next_check_at=${input.now}::timestamptz + CASE checks WHEN 0 THEN interval '1 minute' WHEN 1 THEN interval '5 minutes' WHEN 2 THEN interval '30 minutes' ELSE interval '6 hours' END,checks=checks+1
    WHERE id IN (SELECT id FROM filesv2.activity WHERE state IN ('pending','unclear') AND next_check_at<=${input.now} AND heartbeat_at<${input.now}::timestamptz-interval '60 seconds' ORDER BY next_check_at LIMIT 50 FOR UPDATE SKIP LOCKED) RETURNING *`;
  let checked = 0;
  for (const row of rows) {
    input.signal?.throwIfAborted();
    await input.heartbeat?.();
    input.signal?.throwIfAborted();
    let observed: Record<string, unknown> = { state: "unavailable" };
    if (input.config && !input.config.unreadable && input.config.url === row.server_url && row.path_after !== null) {
      try {
        const node = await input.connect(input.config).root(row.root).stat(row.path_after);
        observed = { exists: true, directory: node.directory, ...(node.id ? { id: node.id } : {}) };
      } catch (error) {
        if (error instanceof FilegateError && error.status === 404) observed = { exists: false, directory: false };
      }
    }
    // folder.create: only its response proves completion. Appearance may come from another writer.
    const final = row.started_at.getTime() <= input.now.getTime() - 7 * 86_400_000;
    await sql`UPDATE filesv2.activity SET state='unclear',
      next_check_at=CASE WHEN ${final} THEN 'infinity'::timestamptz ELSE next_check_at END,
      detail=detail || ${{ observed_after: observed, ...(final ? { final: true } : {}) }}::jsonb
      WHERE id=${row.id}::uuid AND state=${row.state}`;
    checked++;
  }
  return { checked };
}

export async function purgeActivity(input: { now: Date; retentionDays: number }): Promise<{ purged: number }> {
  // Pending entries never expire here; each later PR adds its own journal predicate.
  const rows = await sql<{ id: string }[]>`DELETE FROM filesv2.activity WHERE id IN
    (SELECT id FROM filesv2.activity WHERE started_at<${input.now}::timestamptz-${input.retentionDays}*interval '1 day' AND state<>'pending' ORDER BY started_at LIMIT 10000) RETURNING id`;
  return { purged: rows.length };
}
