import { AsyncLocalStorage } from "node:async_hooks";
import type { AccessSubject, RequestActor } from "@k2b/cloud/server";
import { logger } from "@k2b/cloud/services";
import { FilegateError, type WriteOptions } from "@k2b/filegate";
import { sql, type TransactionSQL } from "bun";
import { filegateErrorCode } from "../api/filegate-error";
import { finishActivity, insertActivity } from "../data/activity";
import { sameUploadExecution, sameUploadOptions, type Upload, uploadSessionId, uploads } from "../data/uploads";
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
export type ActivityAction =
  | "folder.create"
  | "item.rename"
  | "item.move"
  | "item.copy"
  | "file.upload"
  | "file.overwrite"
  | "file.create"
  | "file.edit";
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
  writeOptions?: WriteOptions;
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
  "files.ensure_trash",
  "files.version_comment",
  "files.version_restore",
  "files.version_restore_copy",
  "files.version_delete",
  "trash.transfer",
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
  "files.ensure_trash": ["mkdir"],
  "files.version_comment": ["updateVersion"],
  "files.version_restore": ["restore"],
  "files.version_restore_copy": ["copyVersion"],
  "files.version_delete": ["deleteVersion"],
  "trash.transfer": ["transfer"],
  "lifecycle.operation": ["mkdir", "transfer", "remove"],
  "lifecycle.admin_delete_version": ["deleteVersion"],
});
for (const methods of Object.values(PENDING_MIGRATION_METHODS)) Object.freeze(methods);
type GuardScope =
  | { kind: "activity"; id: string; intent: Intent; upload?: Upload; closed: boolean; sent: number; refused: unknown }
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
  write?: { size: number; options: WriteOptions; key?: string },
): Promise<T> {
  const scope = scopes.getStore();
  if (!scope || (scope.kind === "activity" && scope.closed)) throw new FilesError("activity_scope_missing", 500);
  if (scope.kind === "pending" && !PENDING_MIGRATION_METHODS[scope.key].includes(method))
    throw new FilesError("activity_scope_mismatch", 500);
  if (scope.kind === "exception" && !(["mkdir", "remove"].includes(method) && path.split("/").at(-1)?.startsWith(".filesv2-owner-")))
    throw new FilesError("activity_scope_mismatch", 500);
  if (scope.kind === "activity") {
    const intent = scope.intent;
    const upload = scope.upload;
    const matches = upload
      ? scope.sent === 0 &&
        (intent.action === "file.upload" || intent.action === "file.overwrite") &&
        (method === "createSession"
          ? path === intent.pathAfter &&
            write?.size === upload.size &&
            write.key === upload.id &&
            sameUploadOptions(write.options, upload.write_options)
          : (method === "commitSession" || method === "abortSession") && !!uploadSessionId(upload) && path === uploadSessionId(upload))
      : intent.action === "folder.create"
        ? method === "mkdir" && !!intent.pathAfter && (path === intent.pathAfter || intent.pathAfter.startsWith(`${path}/`))
        : intent.action === "file.create" || intent.action === "file.edit"
          ? scope.sent === 0 &&
            method === "put" &&
            path === intent.pathAfter &&
            !!write &&
            !!intent.writeOptions &&
            sameUploadOptions(write.options, {
              ...intent.writeOptions,
              metadata: { ...intent.writeOptions.metadata, activity: scope.id },
            }) &&
            write.size === intent.size &&
            (write.options.onConflict ?? "error") === (intent.action === "file.edit" ? "overwrite" : "error")
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
    ([403, 404].includes(error.status) ||
      (error.status === 412 && ["file.create", "file.edit"].includes(scope.intent.action)) ||
      (error.status === 409 && filegateErrorCode(error) === "path_conflict"))
  );
}

async function runScope<T>(scope: Extract<GuardScope, { kind: "activity" }>, effect: () => Promise<T>, heartbeatMs = 10_000): Promise<T> {
  const timer = setInterval(() => {
    void sql`UPDATE filesv2.activity SET heartbeat_at=now() WHERE id=${scope.id}::uuid AND state IN ('pending','unclear')`.catch(
      (error: unknown) => log.error("Activity heartbeat failed", { id: scope.id, error }),
    );
  }, heartbeatMs);
  timer.unref();
  try {
    return await scopes.run(scope, effect);
  } finally {
    scope.closed = true;
    clearInterval(timer);
  }
}

/** A reservation outlives a request. Reload its persisted scope; opening a session never finishes the activity. */
export async function uploadAction<T>(id: string, effect: () => Promise<T>): Promise<T> {
  const { upload, activity } = await uploads.history(id);
  if (!activity || upload.state !== "open" || !["pending", "unclear"].includes(activity.state)) throw new FilesError("upload_closed", 409);
  const intent: Intent = {
    action: activity.action,
    serverUrl: activity.server_url,
    root: activity.root,
    baseId: activity.base_id,
    directory: false,
    name: activity.name,
    pathAfter: activity.path_after,
    size: Number(activity.size),
  };
  const rows =
    await sql`UPDATE filesv2.activity SET heartbeat_at=now() WHERE id=${activity.id}::uuid AND state IN ('pending','unclear') RETURNING id`;
  if (!rows.length) throw new FilesError("upload_closed", 409);
  return runScope({ kind: "activity", id: activity.id, intent, upload, closed: false, sent: 0, refused: undefined }, effect);
}

export async function fileAction<T>(
  call: FilesCall,
  input: Intent,
  effect: () => Promise<T>,
  finish: (tx: TransactionSQL, result: T) => Promise<Finished>,
  options?: { heartbeatMs?: number },
): Promise<T> {
  // The guard must authorize the values committed below, even if the caller later changes its object.
  const intent = structuredClone(input);
  const id = await insertActivity(call, intent);
  const scope: Extract<GuardScope, { kind: "activity" }> = { kind: "activity", id, intent, closed: false, sent: 0, refused: undefined };
  let result: T;
  try {
    result = await runScope(scope, effect, options?.heartbeatMs);
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
  await sql.begin((tx) => finishActivity(tx, id, "done", () => finish(tx, result)));
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
  upload_id: string | null;
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
    if (row.upload_id && input.config && !input.config.unreadable && input.config.url === row.server_url) {
      try {
        const { upload, activity } = await uploads.history(row.upload_id);
        if (!activity || ["done", "failed", "not_done"].includes(activity.state)) {
          checked++;
          continue;
        }
        const id = uploadSessionId(upload);
        if (id && upload.server_url === row.server_url && upload.root === row.root) {
          const root = input.connect(input.config).root(upload.root);
          const session = await (upload.execution ? root.as(upload.execution) : root).session(id);
          if (
            session.id !== id ||
            session.root !== upload.root ||
            session.path !== activity.path_after ||
            session.size !== upload.size ||
            (upload.write_options !== null && !sameUploadOptions(session.options, upload.write_options)) ||
            !sameUploadExecution(session.execution ?? null, upload.execution)
          )
            throw new FilesError("upload_changed", 409);
          if (session.state === "committed" && session.result) {
            await uploads.finish(upload.id, "committed", session.result);
            checked++;
            continue;
          }
          if (session.state === "aborted" || session.state === "expired") {
            await uploads.finish(upload.id, session.state, null);
            checked++;
            continue;
          }
          // An open receipt remains executable, even when the original reservation is older than seven days.
          if (session.state === "open") {
            checked++;
            continue;
          }
        }
      } catch (error) {
        log.warn("Upload history receipt unavailable", { id: row.id, error });
      }
    }
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
  // An unresolved reservation still owns its history, including a final unclear entry.
  const rows = await sql<{ id: string }[]>`DELETE FROM filesv2.activity WHERE id IN
    (SELECT id FROM filesv2.activity WHERE started_at<coalesce(${input.now ?? null}::timestamptz, now())-${input.retentionDays}*interval '1 day' AND state<>'pending' AND NOT EXISTS (SELECT 1 FROM filesv2.uploads u WHERE u.id=activity.upload_id AND u.state='open') ORDER BY started_at LIMIT 10000) RETURNING id`;
  return { purged: rows.length };
}
