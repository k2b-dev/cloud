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
export type ActivityAction = "folder.create" | "item.rename" | "item.move" | "item.copy";
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
  onConflict?: "error" | "rename";
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
export const PENDING_MIGRATION = Object.freeze([
  "files.upload_session",
  "files.write_bytes",
  "files.ensure_trash",
  "files.version_comment",
  "files.version_restore",
  "files.version_restore_copy",
  "files.version_delete",
  "trash.transfer",
  "sharing.inbox_session",
  "lifecycle.operation",
  "lifecycle.admin_delete_version",
] as const);
export type PendingMigrationKey = (typeof PENDING_MIGRATION)[number];
export type Mutation =
  | "mkdir"
  | "put"
  | "createSession"
  | "commitSession"
  | "abortSession"
  | "transfer"
  | "restore"
  | "copyVersion"
  | "updateVersion"
  | "deleteVersion"
  | "remove";
export const PENDING_MIGRATION_METHODS: Readonly<Record<PendingMigrationKey, readonly Mutation[]>> = Object.freeze({
  "files.upload_session": ["createSession", "commitSession", "abortSession"],
  "files.write_bytes": ["put"],
  "files.ensure_trash": ["mkdir"],
  "files.version_comment": ["updateVersion"],
  "files.version_restore": ["restore"],
  "files.version_restore_copy": ["copyVersion"],
  "files.version_delete": ["deleteVersion"],
  "trash.transfer": ["transfer"],
  "sharing.inbox_session": ["createSession", "commitSession", "abortSession"],
  "lifecycle.operation": ["mkdir", "transfer", "remove"],
  "lifecycle.admin_delete_version": ["deleteVersion"],
});
for (const methods of Object.values(PENDING_MIGRATION_METHODS)) Object.freeze(methods);
type GuardScope =
  | { kind: "activity"; id: string; intent: Intent; closed: boolean; sent: number; refused: unknown }
  | { kind: "pending"; key: PendingMigrationKey }
  | { kind: "exception"; name: "lifecycle.probe" };
const scopes = new AsyncLocalStorage<GuardScope>();
export const currentActivityId = (): string | null => {
  const scope = scopes.getStore();
  return scope?.kind === "activity" ? scope.id : null;
};

/** Check and account for a write without exposing the mutable authorization state. */
export async function filegateMutation<T>(
  serverUrl: string,
  root: string,
  method: Mutation,
  path: string,
  run: () => Promise<T>,
  transfer?: { root: string; path: string; move: boolean; onConflict: string },
): Promise<T> {
  const scope = scopes.getStore();
  if (!scope || (scope.kind === "activity" && scope.closed)) throw new FilesError("activity_scope_missing", 500);
  if (scope.kind === "pending" && !PENDING_MIGRATION_METHODS[scope.key].includes(method))
    throw new FilesError("activity_scope_mismatch", 500);
  if (scope.kind === "exception" && !(["mkdir", "remove"].includes(method) && path.split("/").at(-1)?.startsWith(".filesv2-owner-")))
    throw new FilesError("activity_scope_mismatch", 500);
  if (scope.kind === "activity") {
    const intent = scope.intent;
    const matches =
      intent.action === "folder.create"
        ? method === "mkdir" && !!intent.pathAfter && (path === intent.pathAfter || intent.pathAfter.startsWith(`${path}/`))
        : (intent.action === "item.rename" || intent.action === "item.move" || intent.action === "item.copy") &&
          scope.sent === 0 &&
          method === "transfer" &&
          !!transfer &&
          path === intent.pathBefore &&
          transfer.root === (intent.rootAfter ?? intent.root) &&
          transfer.path === intent.pathAfter &&
          transfer.move === (intent.action !== "item.copy") &&
          transfer.onConflict === (intent.onConflict ?? "error");
    if (intent.serverUrl !== serverUrl || intent.root !== root || !matches) throw new FilesError("activity_scope_mismatch", 500);
    scope.sent++;
  }
  try {
    return await run();
  } catch (error) {
    if (scope.kind === "activity" && error instanceof FilegateError) scope.refused = error;
    throw error;
  }
}
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
    // Tree copies may prepare ancestors before refusing publication; no receipt proves rollback.
    scope.intent.action !== "item.copy" &&
    scope.sent === 1 &&
    error === scope.refused &&
    error instanceof FilegateError &&
    ([403, 404].includes(error.status) || (error.status === 409 && filegateErrorCode(error) === "path_conflict"))
  );
}

export async function fileAction<T>(
  call: FilesCall,
  input: Intent,
  effect: () => Promise<T>,
  finish: (tx: TransactionSQL, result: T) => Promise<Finished>,
  options?: { heartbeatMs?: number },
): Promise<T> {
  // The guard must authorize the values committed below, even if the caller later changes its object.
  const intent = { ...input };
  const id = Bun.randomUUIDv7();
  const userId = call.kind === "user" ? (call.actor.kind === "user" ? call.actor.user.id : (call.actor.delegatedUser?.id ?? null)) : null;
  const detail = {
    ...intent.detail,
    ...(intent.onConflict ? { on_conflict: intent.onConflict } : {}),
    ...(call.kind === "system" ? { job: call.job } : {}),
  };
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
        await sql`UPDATE filesv2.activity SET state='failed',finished_at=now(),error_code=${error instanceof FilesError ? error.code : error instanceof FilegateError ? filegateErrorCode(error) : "operation_unresolved"} WHERE id=${id}::uuid AND state IN ('pending','unclear')`;
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
  root_after: string | null;
  path_before: string | null;
  path_after: string | null;
  final: boolean;
};
export async function recoverActivity(input: {
  now?: Date;
  connect: (config: Config) => FilesFilegate;
  config: Config | null;
  signal?: AbortSignal;
  heartbeat?: () => Promise<void>;
}): Promise<{ checked: number }> {
  input.signal?.throwIfAborted();
  const rows = await sql<
    RecoveryRow[]
  >`UPDATE filesv2.activity SET next_check_at=coalesce(${input.now ?? null}::timestamptz, now()) + CASE checks WHEN 0 THEN interval '1 minute' WHEN 1 THEN interval '5 minutes' WHEN 2 THEN interval '30 minutes' ELSE interval '6 hours' END,checks=checks+1
    WHERE id IN (SELECT id FROM filesv2.activity WHERE state IN ('pending','unclear') AND next_check_at<=coalesce(${input.now ?? null}::timestamptz, now()) AND heartbeat_at<coalesce(${input.now ?? null}::timestamptz, now())-interval '60 seconds' ORDER BY next_check_at LIMIT 50 FOR UPDATE SKIP LOCKED)
    RETURNING *, started_at <= coalesce(${input.now ?? null}::timestamptz, now()) - interval '7 days' AS final`;
  let checked = 0;
  for (const row of rows) {
    input.signal?.throwIfAborted();
    await input.heartbeat?.();
    input.signal?.throwIfAborted();
    const observe = async (root: string, path: string): Promise<Record<string, unknown>> => {
      if (input.config && !input.config.unreadable && input.config.url === row.server_url) {
        try {
          const node = await input.connect(input.config).root(root).stat(path);
          return { exists: true, directory: node.directory, ...(node.id ? { id: node.id } : {}) };
        } catch (error) {
          if (error instanceof FilegateError && error.status === 404) return { exists: false, directory: false };
        }
      }
      return { state: "unavailable" };
    };
    const observations = {
      ...(row.path_before !== null ? { observed_before: await observe(row.root, row.path_before) } : {}),
      ...(row.path_after !== null ? { observed_after: await observe(row.root_after ?? row.root, row.path_after) } : {}),
    };
    // Folder creation, same-root moves and copies have no retained operation receipt.
    // Appearance alone never proves completion, even when the source has disappeared.
    await sql`UPDATE filesv2.activity SET state='unclear',
      next_check_at=CASE WHEN ${row.final} THEN 'infinity'::timestamptz ELSE next_check_at END,
      detail=detail || ${{ ...observations, ...(row.final ? { final: true } : {}) }}::jsonb
      WHERE id=${row.id}::uuid AND state=${row.state}`;
    checked++;
  }
  return { checked };
}

export async function purgeActivity(input: { now?: Date; retentionDays: number }): Promise<{ purged: number }> {
  // Pending entries never expire here; each later PR adds its own journal predicate.
  const rows = await sql<{ id: string }[]>`DELETE FROM filesv2.activity WHERE id IN
    (SELECT id FROM filesv2.activity WHERE started_at<coalesce(${input.now ?? null}::timestamptz, now())-${input.retentionDays}*interval '1 day' AND state<>'pending' ORDER BY started_at LIMIT 10000) RETURNING id`;
  return { purged: rows.length };
}
