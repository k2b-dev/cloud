import { AsyncLocalStorage } from "node:async_hooks";
import type { AccessSubject, RequestActor } from "@k2b/cloud/server";
import { logger } from "@k2b/cloud/services";
import { FilegateError } from "@k2b/filegate";
import { deepEquals, sql, type TransactionSQL } from "bun";
import { filegateErrorCode } from "../api/filegate-error";
import { finishActivity, insertActivity } from "../data/activity";
import { trash } from "../data/trash";
import type { readConfiguration } from "./configuration";
import { FilesError } from "./errors";
import type { FilesFilegate, FilesRoot } from "./filegate-facade";
import { sameTrashNode } from "./trash-evidence";

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
  | "version.comment"
  | "version.restore"
  | "version.restore_copy"
  | "version.delete"
  | "item.trash"
  | "item.restore"
  | "item.purge";
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
  trashId?: string | null;
  operationId?: string | null;
  trashDirectory?: string;
  onConflict?: "error" | "rename";
  detail?: Record<string, unknown>;
  versionOptions?: Parameters<FilesRoot["updateVersion"]>[2];
  copyOptions?: Parameters<FilesRoot["copyVersion"]>[4];
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
  "sharing.inbox_session",
  "lifecycle.operation",
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
  "sharing.inbox_session": ["createSession", "commitSession", "abortSession"],
  "lifecycle.operation": ["mkdir", "transfer"],
});
for (const methods of Object.values(PENDING_MIGRATION_METHODS)) Object.freeze(methods);
type GuardScope =
  | {
      kind: "activity";
      id: string;
      intent: Intent;
      closed: boolean;
      sent: number;
      refused: unknown;
      effectSent?: boolean;
      trashPrepared?: boolean;
    }
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
  binding?:
    | { kind: "transfer"; root: string; path: string; move: boolean; onConflict: string }
    | { kind: "version"; id: string; target?: { root: string; path: string }; options?: unknown }
    | { kind: "remove"; recursive: boolean },
): Promise<T> {
  const scope = scopes.getStore();
  if (!scope || (scope.kind === "activity" && scope.closed)) throw new FilesError("activity_scope_missing", 500);
  if (scope.kind === "pending" && !PENDING_MIGRATION_METHODS[scope.key].includes(method))
    throw new FilesError("activity_scope_mismatch", 500);
  if (scope.kind === "exception" && !(["mkdir", "remove"].includes(method) && path.split("/").at(-1)?.startsWith(".filesv2-owner-")))
    throw new FilesError("activity_scope_mismatch", 500);
  if (scope.kind === "activity") {
    const intent = scope.intent;
    const versionMatches =
      scope.sent === 0 &&
      binding?.kind === "version" &&
      binding.id === intent.versionId &&
      path === intent.pathBefore &&
      ((intent.action === "version.comment" &&
        method === "updateVersion" &&
        !!intent.versionOptions &&
        deepEquals(binding.options, {
          ...intent.versionOptions,
          metadata: { ...intent.versionOptions.metadata, comment_activity: scope.id },
        })) ||
        (intent.action === "version.restore" && method === "restore") ||
        (intent.action === "version.delete" && method === "deleteVersion") ||
        (intent.action === "version.restore_copy" &&
          method === "copyVersion" &&
          binding.target?.root === (intent.rootAfter ?? intent.root) &&
          binding.target.path === intent.pathAfter &&
          deepEquals(binding.options, intent.copyOptions)));
    const journalMatches =
      ((intent.action === "item.trash" || intent.action === "item.restore") &&
        ((intent.action === "item.trash" &&
          method === "mkdir" &&
          !scope.trashPrepared &&
          !scope.effectSent &&
          path === intent.trashDirectory) ||
          (method === "transfer" &&
            !scope.effectSent &&
            binding?.kind === "transfer" &&
            path === intent.pathBefore &&
            binding.root === intent.root &&
            binding.path === intent.pathAfter &&
            binding.move &&
            binding.onConflict === "error"))) ||
      (intent.action === "item.purge" &&
        method === "remove" &&
        !scope.effectSent &&
        path === intent.pathBefore &&
        binding?.kind === "remove" &&
        binding.recursive);
    const matches =
      versionMatches ||
      journalMatches ||
      (intent.action === "folder.create"
        ? method === "mkdir" && !!intent.pathAfter && (path === intent.pathAfter || intent.pathAfter.startsWith(`${path}/`))
        : (intent.action === "item.rename" || intent.action === "item.move" || intent.action === "item.copy") &&
          scope.sent === 0 &&
          method === "transfer" &&
          binding?.kind === "transfer" &&
          path === intent.pathBefore &&
          binding.root === (intent.rootAfter ?? intent.root) &&
          binding.path === intent.pathAfter &&
          binding.move === (intent.action !== "item.copy") &&
          binding.onConflict === (intent.onConflict ?? "error"));
    if (intent.serverUrl !== serverUrl || intent.root !== root || !matches) throw new FilesError("activity_scope_mismatch", 500);
    scope.sent++;
    if (journalMatches) {
      if (method === "mkdir") scope.trashPrepared = true;
      else scope.effectSent = true;
    }
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
    scope.intent.action !== "version.restore_copy" &&
    scope.sent === 1 &&
    error === scope.refused &&
    error instanceof FilegateError &&
    ([403, 404].includes(error.status) || (error.status === 409 && filegateErrorCode(error) === "path_conflict"))
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

/** A durable journal resumes only the scope already committed with its original caller. */
export async function journalAction<T>(id: string, effect: () => Promise<T>): Promise<T> {
  const [row] = await sql<
    {
      id: string;
      action: ActivityAction;
      server_url: string;
      root: string;
      root_after: string | null;
      base_id: string | null;
      base_after_id: string | null;
      name: string;
      directory: boolean;
      path_before: string | null;
      path_after: string | null;
      detail: { trash_directory?: string };
    }[]
  >`UPDATE filesv2.activity SET heartbeat_at=now() WHERE id=${id}::uuid AND state IN ('pending','unclear') RETURNING *`;
  if (!row) throw new FilesError("activity_scope_missing", 500);
  const intent: Intent = {
    action: row.action,
    serverUrl: row.server_url,
    root: row.root,
    rootAfter: row.root_after,
    baseId: row.base_id,
    baseAfterId: row.base_after_id,
    name: row.name,
    directory: row.directory,
    pathBefore: row.path_before,
    pathAfter: row.path_after,
    trashDirectory: row.detail.trash_directory,
  };
  return runScope({ kind: "activity", id, intent, closed: false, sent: 0, refused: undefined }, effect);
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
  version_id: string | null;
  trash_id: string | null;
  base_id: string | null;
  item_id: string | null;
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
    if (
      row.action === "version.comment" &&
      row.version_id &&
      row.path_before &&
      input.config &&
      !input.config.unreadable &&
      input.config.url === row.server_url
    ) {
      try {
        const root = input.connect(input.config).root(row.root);
        const node = await root.stat(row.path_before);
        if (!row.item_id || node.id === row.item_id) {
          const version = (await root.versions(row.path_before)).find((version) => version.id === row.version_id);
          if (version?.metadata?.comment_activity === row.id) {
            await sql`UPDATE filesv2.activity SET state='done',finished_at=now(),error_code=NULL WHERE id=${row.id}::uuid AND state IN ('pending','unclear')`;
            checked++;
            continue;
          }
        }
      } catch (error) {
        log.warn("Version history receipt unavailable", { id: row.id, error });
      }
    }
    if (
      row.action === "item.trash" &&
      row.trash_id &&
      row.base_id &&
      row.path_before &&
      row.path_after &&
      input.config &&
      !input.config.unreadable &&
      input.config.url === row.server_url
    ) {
      try {
        const journal = await trash.get(row.trash_id, row.base_id);
        if (
          journal?.state === "pending" &&
          journal.server_url === row.server_url &&
          journal.root === row.root &&
          journal.trashed === `trash/${journal.id}` &&
          row.path_after.endsWith(`/${journal.trashed}`)
        ) {
          const root = input.connect(input.config).root(row.root);
          let sourceExists = true;
          try {
            await root.stat(row.path_before);
          } catch (error) {
            if (error instanceof FilegateError && error.status === 404) sourceExists = false;
            else throw error;
          }
          const target = await root.stat(row.path_after);
          if (!sourceExists && sameTrashNode(journal.snapshot, target)) {
            await trash.finish(journal.id, "trashed", target);
            checked++;
            continue;
          }
        }
      } catch (error) {
        log.warn("Trash history receipt unavailable", { id: row.id, error });
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
  // Pending entries never expire here; each later PR adds its own journal predicate.
  const rows = await sql<{ id: string }[]>`DELETE FROM filesv2.activity WHERE id IN
    (SELECT id FROM filesv2.activity WHERE started_at<coalesce(${input.now ?? null}::timestamptz, now())-${input.retentionDays}*interval '1 day' AND state<>'pending' AND NOT EXISTS (SELECT 1 FROM filesv2.operations o WHERE o.id=activity.operation_id AND o.state='pending') AND NOT EXISTS (SELECT 1 FROM filesv2.trash t WHERE t.id=activity.trash_id AND t.state IN ('pending','restoring')) ORDER BY started_at LIMIT 10000) RETURNING id`;
  return { purged: rows.length };
}
