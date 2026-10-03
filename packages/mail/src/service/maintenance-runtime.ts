import { lazySync } from "@k2b/cloud";
import { createRuntimeTaskTracker, stopRuntimeJobs } from "@k2b/cloud/services";
import { toPgTextArray } from "@k2b/cloud/services/postgres";
import type { JobContext, Worker } from "@k2b/sync";
import { expBackoff } from "@k2b/sync/retry";
import { sql } from "bun";
import { z } from "zod";
import { type CommandState, type MaintenanceCommandInput, maintenanceCommandInputSchema } from "../contracts";
import { commandStillAuthorized, type StoredCommandAuthorization } from "./command-authorization";
import { resolveMailExecution } from "./execution";
import { withLeaseHeartbeat } from "./lease-heartbeat";
import { executeOperatorAction, OPERATOR_MAINTENANCE_KINDS } from "./operator-actions";
import { providerBusyRetryAfterMs } from "./provider-operation-lock";
import {
  enqueueFolderSync,
  enqueueMailboxHydration,
  enqueueMailboxSync,
  executeBindingRediscovery,
  FOLDER_SYNC_REQUEST_MS,
  requestedSyncProgress,
} from "./sync-runtime";

const MAINTENANCE_JOB_LEASE_MS = 6 * 60_000;
const STALE_EXECUTION_MINUTES = 10;
// A sync command that asks to wait stays `executing` after it queued its folder syncs. One checker
// per mailbox ends the mailbox's waiting sync commands; it looks this often, as often as `cld mail
// sync --wait` polls. A command waits as long as the sync runtime keeps a request
// (`FOLDER_SYNC_REQUEST_MS`).
const SYNC_CHECK_INTERVAL_MS = 1_000;
const maintenanceTasks = createRuntimeTaskTracker();

type JsonRecord = Record<string, unknown>;
type MaintenanceKind = MaintenanceCommandInput["kind"];
type DbMaintenanceCommand = StoredCommandAuthorization & {
  id: string;
  kind: MaintenanceKind;
  state: CommandState;
  target: JsonRecord | string;
  payload: JsonRecord | string;
  attempt: number;
};

const MAINTENANCE_KINDS: MaintenanceKind[] = [...OPERATOR_MAINTENANCE_KINDS];

const parseRecord = (value: JsonRecord | string): JsonRecord => (typeof value === "string" ? (JSON.parse(value) as JsonRecord) : value);

const errorCode = (error: unknown): string => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Z0-9_]{1,80}$/.test(code) ? code : "MAIL_MAINTENANCE_FAILED";
};

const errorMessage = (error: unknown): string =>
  (error instanceof Error ? error.message : "Mail maintenance command failed").slice(0, 1_000);

const claimMaintenanceCommand = async (commandId: string): Promise<DbMaintenanceCommand | null> =>
  sql.begin(async (tx) => {
    const [current] = await tx<DbMaintenanceCommand[]>`
      SELECT
        id, mailbox_id, kind, state, actor_kind, actor_id, initiator_actor_kind, initiator_actor_id, access_subject_kind,
        access_subject_id, credential_scopes, credential_id, credential_expires_at, target, payload, attempt
      FROM mail.commands
      WHERE id = ${commandId}::uuid
      FOR UPDATE
    `;
    if (!current || !MAINTENANCE_KINDS.includes(current.kind) || current.state !== "queued") return null;
    const [claimed] = await tx<DbMaintenanceCommand[]>`
      UPDATE mail.commands
      SET
        state = 'executing',
        attempt = attempt + 1,
        started_at = now(),
        worker_heartbeat_at = now(),
        finished_at = NULL,
        -- A new attempt has no result yet; a waiting sync command's result says it queued its folders.
        result = '{}'::jsonb,
        last_error_code = NULL,
        last_error_message = NULL,
        updated_at = now()
      WHERE id = ${commandId}::uuid
      RETURNING
        id, mailbox_id, kind, state, actor_kind, actor_id, initiator_actor_kind, initiator_actor_id, access_subject_kind,
        access_subject_id, credential_scopes, credential_id, credential_expires_at, target, payload, attempt
    `;
    return claimed ?? null;
  });

const heartbeatCommand = async (command: Pick<DbMaintenanceCommand, "id" | "attempt">): Promise<void> => {
  const [updated] = await sql<{ id: string }[]>`
    UPDATE mail.commands
    SET worker_heartbeat_at = now(), updated_at = now()
    WHERE id = ${command.id}::uuid AND attempt = ${command.attempt} AND state = 'executing'
    RETURNING id
  `;
  if (!updated) throw Object.assign(new Error("Mail maintenance command lease was lost"), { code: "COMMAND_LEASE_LOST" });
};

const finishMaintenanceCommand = async (params: {
  command: Pick<DbMaintenanceCommand, "id" | "attempt">;
  state: "confirmed" | "failed";
  result?: JsonRecord;
  error?: unknown;
}): Promise<void> => {
  const code = params.error ? errorCode(params.error) : null;
  const message = params.error ? errorMessage(params.error) : null;
  await sql.begin(async (tx) => {
    const [updated] = await tx<{ mailbox_id: string; actor_kind: string; actor_id: string | null }[]>`
      UPDATE mail.commands
      SET
        state = ${params.state},
        result = ${params.result ?? {}}::jsonb,
        finished_at = now(),
        worker_heartbeat_at = NULL,
        last_error_code = ${code},
        last_error_message = ${message},
        updated_at = now()
      WHERE id = ${params.command.id}::uuid
        AND attempt = ${params.command.attempt}
        AND state = 'executing'
      RETURNING mailbox_id, actor_kind, actor_id
    `;
    if (!updated) return;
    await tx`
      INSERT INTO mail.activity_events (
        mailbox_id, command_id, actor_kind, actor_id, action, outcome, target_type, target_id, metadata
      )
      VALUES (
        ${updated.mailbox_id}::uuid,
        ${params.command.id}::uuid,
        ${updated.actor_kind},
        ${updated.actor_id}::uuid,
        'command.execute',
        ${params.state === "confirmed" ? "confirmed" : "failed"},
        'command',
        ${params.command.id}::uuid,
        ${{ state: params.state, code, result: params.result ?? {} }}::jsonb
      )
    `;
  });
};

const folderTargetSchema = z.object({ folderId: z.string().uuid() });
const bindingTargetSchema = z.object({ bindingId: z.string().uuid().nullable() });

const syncTargetFolderId = (command: Pick<DbMaintenanceCommand, "kind" | "target">): string | null =>
  command.kind === "sync_folder" ? folderTargetSchema.parse(parseRecord(command.target)).folderId : null;

/** Why the mailbox, or the one folder, cannot synchronize now; null when it can. */
const syncUnavailable = async (mailboxId: string, folderId: string | null): Promise<string | null> => {
  // The sync job resolves the same execution first.
  const execution = await resolveMailExecution({
    mailboxId,
    operation: "backgroundSync",
    folderRequirements: folderId ? [{ folderId, rights: ["read"] }] : [],
  });
  return execution.ok ? null : execution.error.message;
};

const executeFolderRebuild = async (command: DbMaintenanceCommand, folderId: string, enqueueWork: boolean): Promise<JsonRecord> => {
  const result = await sql.begin(async (tx) => {
    const [folder] = await tx<{ id: string; remote_resource_id: string }[]>`
      SELECT folder.id, folder.remote_resource_id
      FROM mail.folders folder
      JOIN mail.remote_resources resource ON resource.id = folder.remote_resource_id
      WHERE folder.id = ${folderId}::uuid
        AND resource.mailbox_id = ${command.mailbox_id}::uuid
        AND folder.discovery_state = 'active'
      FOR UPDATE OF folder, resource
    `;
    if (!folder) throw Object.assign(new Error("Active mail folder was not found"), { code: "FOLDER_UNAVAILABLE" });
    const staleRefs = await tx<{ id: string }[]>`
      UPDATE mail.remote_message_refs
      SET stale_at = COALESCE(stale_at, now())
      WHERE folder_id = ${folderId}::uuid AND stale_at IS NULL
      RETURNING id
    `;
    if (staleRefs.length > 0) {
      await tx`
        UPDATE mail.message_placements
        SET deleted_at = COALESCE(deleted_at, now()), updated_at = now()
        WHERE remote_message_ref_id IN (
          SELECT value::uuid FROM jsonb_array_elements_text(${staleRefs.map((row) => row.id)}::jsonb)
        )
      `;
    }
    await tx`
      UPDATE mail.folders
      SET
        envelope_cursor = '{}'::jsonb,
        body_cursor = '{}'::jsonb,
        attachment_cursor = '{}'::jsonb,
        sync_status = 'rebuilding'
      WHERE id = ${folderId}::uuid
    `;
    await tx`
      UPDATE mail.remote_resources
      SET sync_generation = sync_generation + 1
      WHERE id = ${folder.remote_resource_id}::uuid
    `;
    return { folderId, staleRemoteMessages: staleRefs.length };
  });
  if (enqueueWork) await enqueueFolderSync(folderId);
  return { ...result, queued: enqueueWork };
};

const executeHydrationRetry = async (mailboxId: string, enqueueWork: boolean): Promise<JsonRecord> => {
  const reset = await sql<{ id: string }[]>`
    UPDATE mail.message_contents
    SET
      hydration_status = CASE WHEN plain_text IS NOT NULL OR sanitized_html IS NOT NULL THEN 'body' ELSE 'envelope' END,
      hydration_attempt = 0,
      hydration_claim_id = NULL,
      hydration_claimed_at = NULL
    WHERE mailbox_id = ${mailboxId}::uuid
      AND hydration_status = 'failed'
    RETURNING id
  `;
  const queued = await sql<{ id: string }[]>`
    SELECT id
    FROM mail.message_contents
    WHERE mailbox_id = ${mailboxId}::uuid
      AND hydration_status IN ('envelope', 'headers', 'body')
    ORDER BY internal_date DESC, id DESC
    LIMIT 500
  `;
  if (enqueueWork && queued.length > 0) await enqueueMailboxHydration(mailboxId);
  return { reset: reset.length, queued: enqueueWork ? queued.length : 0 };
};

const executeMaintenanceWork = async (
  command: DbMaintenanceCommand,
  heartbeat: () => Promise<void>,
  enqueueWork: boolean,
): Promise<JsonRecord> => {
  if (!(await commandStillAuthorized(command, "admin"))) {
    throw Object.assign(new Error("Mailbox administration access was revoked before execution"), { code: "ACCESS_REVOKED" });
  }
  const target = parseRecord(command.target);
  if (command.kind === "sync_mailbox" || command.kind === "sync_folder") {
    const folderId = syncTargetFolderId(command);
    // Report the prerequisite instead of queueing work that cannot run and would overwrite the
    // mailbox's recorded reason with a generic failure.
    const reason = await syncUnavailable(command.mailbox_id, folderId);
    if (reason) return folderId ? { folderId, queued: false, reason } : { queuedFolders: 0, reason };
  }
  if (command.kind === "sync_mailbox") {
    if (enqueueWork) return { queuedFolders: await enqueueMailboxSync(command.mailbox_id) };
    const [folders] = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count
      FROM mail.folders folder
      JOIN mail.remote_resources resource ON resource.id = folder.remote_resource_id
      JOIN mail.mailboxes mailbox ON mailbox.id = resource.mailbox_id
      WHERE resource.mailbox_id = ${command.mailbox_id}::uuid
        AND folder.selected_for_sync = true
        AND folder.discovery_state = 'active'
        AND folder.sync_status <> 'excluded'
        AND mailbox.sync_enabled = true
        AND mailbox.deleted_at IS NULL
    `;
    return { queuedFolders: Number(folders?.count ?? 0) };
  }
  if (command.kind === "sync_folder") {
    const { folderId } = folderTargetSchema.parse(target);
    if (enqueueWork) await enqueueFolderSync(folderId);
    return { folderId, queued: enqueueWork };
  }
  if (command.kind === "rebuild_folder") {
    const { folderId } = folderTargetSchema.parse(target);
    return executeFolderRebuild(command, folderId, enqueueWork);
  }
  if (command.kind === "hydrate_missing") return executeHydrationRetry(command.mailbox_id, enqueueWork);
  if (["rebuild_search", "rebuild_threads", "reconcile_effect", "retry_command", "cancel_command"].includes(command.kind)) {
    return executeOperatorAction({
      commandId: command.id,
      mailboxId: command.mailbox_id,
      input: maintenanceCommandInputSchema.parse({ kind: command.kind, ...target, idempotencyKey: `execute:${command.id}` }),
    });
  }

  const { bindingId } = bindingTargetSchema.parse(target);
  const bindingIds = bindingId
    ? [bindingId]
    : (
        await sql<{ id: string }[]>`
          SELECT binding.id
          FROM mail.provider_bindings binding
          JOIN mail.remote_resources resource ON resource.id = binding.remote_resource_id
          WHERE resource.mailbox_id = ${command.mailbox_id}::uuid
            AND binding.state IN ('active', 'degraded')
          ORDER BY binding.id
        `
      ).map((binding) => binding.id);
  if (bindingIds.length === 0)
    throw Object.assign(new Error("Mailbox has no binding available for rediscovery"), { code: "BINDING_UNAVAILABLE" });
  const discoveries = [];
  for (const currentBindingId of bindingIds) {
    discoveries.push(await executeBindingRediscovery(currentBindingId, command.kind === "verify_binding", heartbeat));
  }
  return { bindings: discoveries };
};

/**
 * A run's state, and how soon a run that found the provider lease busy should try again. A sync
 * command that asks to wait stays `executing` after it queued its folder syncs.
 */
type MaintenanceRun = { state: CommandState; busyRetryAfterMs: number | null };

const waitsForSync = (command: Pick<DbMaintenanceCommand, "kind" | "payload">, result: JsonRecord): boolean =>
  parseRecord(command.payload).wait === true &&
  ((command.kind === "sync_mailbox" && Number(result.queuedFolders) > 0) || (command.kind === "sync_folder" && result.queued === true));

const syncCommandFailure = (code: string, message: string): Error => Object.assign(new Error(message), { code });

type WaitingSyncCommand = Pick<DbMaintenanceCommand, "id" | "kind" | "target" | "attempt"> & {
  result: JsonRecord | string;
  started_at: Date;
  expired: boolean;
};

/**
 * One turn of a mailbox's sync checker. Each sync command of the mailbox that waits for the folder
 * syncs it queued ends once each of its folders synced after its request, a folder's sync gave up,
 * the mailbox stopped synchronizing, or its request ran out. Returns whether a command still waits.
 */
const checkRequestedSyncs = async (mailboxId: string): Promise<boolean> => {
  // The same commands `waitsForSync` keeps executing.
  const commands = await sql<WaitingSyncCommand[]>`
    UPDATE mail.commands
    SET worker_heartbeat_at = now(), updated_at = now()
    WHERE mailbox_id = ${mailboxId}::uuid
      AND state = 'executing'
      AND kind IN ('sync_mailbox', 'sync_folder')
      AND payload ->> 'wait' = 'true'
      AND (result ->> 'queued' = 'true' OR (result ->> 'queuedFolders')::int > 0)
    RETURNING
      id, kind, target, attempt, result, started_at,
      started_at < now() - (${FOLDER_SYNC_REQUEST_MS}::int * interval '1 millisecond') AS expired
  `;
  // The mailbox stopped synchronizing, for example because it was paused. A request ends with the
  // reason, as one that finds the mailbox so before it queues anything.
  const reasons = new Map<string | null, Promise<string | null>>();
  const unavailable = (folderId: string | null): Promise<string | null> => {
    const reason = reasons.get(folderId) ?? syncUnavailable(mailboxId, folderId);
    reasons.set(folderId, reason);
    return reason;
  };
  const open: WaitingSyncCommand[] = [];
  for (const command of commands) {
    const reason = await unavailable(syncTargetFolderId(command));
    if (reason) await finishMaintenanceCommand({ command, state: "confirmed", result: { ...parseRecord(command.result), reason } });
    else open.push(command);
  }
  if (open.length === 0) return false;
  // Mail delivered before a request is in once each folder synced after it. A request counts from
  // the command's attempt, which queued the folder syncs: a retried command does not settle on runs
  // of its earlier attempt.
  const progress = await requestedSyncProgress({
    mailboxId,
    requests: open.map((command) => ({ id: command.id, folderId: syncTargetFolderId(command), since: command.started_at })),
  });
  let waiting = false;
  for (const command of open) {
    const result = parseRecord(command.result);
    const { folders, synced, failed } = progress.get(command.id) ?? { folders: 0, synced: 0, failed: 0 };
    if (synced === folders) {
      await finishMaintenanceCommand({ command, state: "confirmed", result });
      continue;
    }
    // A folder whose sync gave up ends the wait at once; the other folders go on syncing.
    const error =
      failed > 0
        ? syncCommandFailure("SYNC_FAILED", `Synchronization failed in ${failed} of ${folders} requested folders`)
        : command.expired
          ? syncCommandFailure(
              "SYNC_TIMEOUT",
              `Synchronization did not finish within ${FOLDER_SYNC_REQUEST_MS / 60_000} minutes in ${folders - synced} of ${folders} requested folders; it continues in the background`,
            )
          : null;
    if (error) await finishMaintenanceCommand({ command, state: "failed", result, error });
    else waiting = true;
  }
  return waiting;
};

const runMaintenanceCommand = async (
  commandId: string,
  jobHeartbeat: () => Promise<void>,
  options: { enqueueWork?: boolean },
): Promise<MaintenanceRun | null> => {
  const command = await claimMaintenanceCommand(commandId);
  if (!command) return null;
  try {
    const result = await withLeaseHeartbeat({
      intervalMs: 30_000,
      heartbeat: async () => {
        await jobHeartbeat();
        await heartbeatCommand(command);
      },
      work: () =>
        executeMaintenanceWork(
          command,
          async () => {
            await jobHeartbeat();
            await heartbeatCommand(command);
          },
          options.enqueueWork !== false,
        ),
    });
    if (options.enqueueWork !== false && waitsForSync(command, result)) {
      await sql`
        UPDATE mail.commands
        SET result = ${result}::jsonb, worker_heartbeat_at = now(), updated_at = now()
        WHERE id = ${command.id}::uuid AND attempt = ${command.attempt} AND state = 'executing'
      `;
      // The folder syncs are queued; when the checker cannot be submitted now, the commands-due
      // schedule submits it within a minute.
      await submitSyncCheck(command.mailbox_id).catch(() => undefined);
      return { state: "executing", busyRetryAfterMs: null };
    }
    await finishMaintenanceCommand({ command, state: "confirmed", result });
    return { state: "confirmed", busyRetryAfterMs: null };
  } catch (error) {
    const code = errorCode(error);
    if (code === "SYNC_BUSY" || code === "MAIL_RATE_LIMITED") {
      await sql`
        UPDATE mail.commands
        SET
          state = 'queued',
          worker_heartbeat_at = NULL,
          last_error_code = ${code},
          last_error_message = ${
            code === "SYNC_BUSY"
              ? "Mail remote resource is busy; the command will retry"
              : "Mail provider work is rate limited; the command will retry"
          },
          updated_at = now()
        WHERE id = ${command.id}::uuid AND attempt = ${command.attempt} AND state = 'executing'
      `;
      return { state: "queued", busyRetryAfterMs: code === "SYNC_BUSY" ? providerBusyRetryAfterMs(error) : null };
    }
    await finishMaintenanceCommand({ command, state: "failed", error });
    return { state: "failed", busyRetryAfterMs: null };
  }
};

export const executeMaintenanceCommand = async (
  commandId: string,
  jobHeartbeat: () => Promise<void> = async () => undefined,
  options: { enqueueWork?: boolean } = {},
): Promise<CommandState | null> => (await runMaintenanceCommand(commandId, jobHeartbeat, options))?.state ?? null;

/** A job runs one maintenance command, or with `mailboxId` one turn of the mailbox's sync checker. */
type MaintenanceJobInput = { commandId: string; continuationAttempt?: number } | { mailboxId: string };

const maintenanceJob = lazySync((sync) =>
  sync.job<MaintenanceJobInput>({
    id: "mail:execute-maintenance-command",
    delivery: { ackWaitMs: MAINTENANCE_JOB_LEASE_MS, maxAttempts: 1 },
  }),
);
let maintenanceJobWorker: Worker | undefined;

/** Runs one `mail:execute-maintenance-command` attempt; exported so tests can drive its retries. */
export const runMaintenanceJob = async (
  ctx: Pick<JobContext<MaintenanceJobInput>, "input" | "attempt" | "heartbeat" | "resubmit">,
): Promise<void> => {
  const { input } = ctx;
  if ("mailboxId" in input) {
    if (await checkRequestedSyncs(input.mailboxId)) ctx.resubmit({ delayMs: SYNC_CHECK_INTERVAL_MS });
    return;
  }
  // A job of an earlier release that waited for one sync command finds it executing and ends. That
  // command did not ask to wait: the commands-due schedule runs it again once its heartbeat is
  // stale, and it is confirmed once its folder syncs are queued.
  const run = await runMaintenanceCommand(input.commandId, () => ctx.heartbeat(), {});
  if (run?.state !== "queued") return;
  // A busy provider lease is routine: the lease line says when to try again, and waiting does
  // not count as a failed attempt. A rate limit backs off.
  if (run.busyRetryAfterMs !== null) {
    ctx.resubmit({ delayMs: run.busyRetryAfterMs });
    return;
  }
  const attempt = (input.continuationAttempt ?? 0) + ctx.attempt;
  ctx.resubmit({
    delayMs: expBackoff(attempt, { baseMs: 2_000, maxMs: 60_000 }),
    input: { ...input, continuationAttempt: attempt },
  });
};

const startMaintenanceJob = async (): Promise<void> => {
  maintenanceJobWorker = await maintenanceJob().process({}, runMaintenanceJob);
};

export const enqueueMaintenanceCommand = async (commandId: string): Promise<void> => {
  await (maintenanceTasks.run(() => maintenanceJob().submit({ coalesce: true, key: `maintenance:${commandId}`, input: { commandId } })) ??
    Promise.resolve());
};

// A sync command that waits joins its mailbox's checker, so a mailbox has at most one, however
// many sync requests wait. Only a command that starts to wait in the moment the checker's last
// turn finds none left joins the finishing checker; the commands-due schedule starts it again.
const submitSyncCheck = async (mailboxId: string): Promise<void> => {
  await (maintenanceTasks.run(() =>
    maintenanceJob().submit({ coalesce: true, key: `sync-check:${mailboxId}`, input: { mailboxId }, delayMs: SYNC_CHECK_INTERVAL_MS }),
  ) ?? Promise.resolve());
};

export const submitDueMaintenanceCommands = async (): Promise<{ queued: number; recovered: number }> => {
  // A sync command that waits for its folder syncs is its mailbox checker's to end, at the latest
  // when its request runs out, also after the workers were away. Running it anew would wait again.
  const recovered = await sql<{ id: string }[]>`
    UPDATE mail.commands
    SET
      state = 'queued',
      worker_heartbeat_at = NULL,
      last_error_code = 'WORKER_LEASE_EXPIRED',
      last_error_message = 'Maintenance worker stopped before completion; the command will retry',
      updated_at = now()
    WHERE state = 'executing'
      AND kind = ANY(${toPgTextArray(MAINTENANCE_KINDS)}::text[])
      AND COALESCE(worker_heartbeat_at, started_at) < now() - (${STALE_EXECUTION_MINUTES}::text || ' minutes')::interval
      AND (
        kind IN ('sync_mailbox', 'sync_folder')
        AND payload ->> 'wait' = 'true'
        AND (result ->> 'queued' = 'true' OR (result ->> 'queuedFolders')::int > 0)
      ) IS NOT TRUE
    RETURNING id
  `;
  // A running checker refreshes its commands' heartbeats every second, so the mailboxes whose
  // checker is missing come first.
  const waiting = await sql<{ mailbox_id: string }[]>`
    SELECT mailbox_id
    FROM mail.commands
    WHERE state = 'executing'
      AND kind IN ('sync_mailbox', 'sync_folder')
      AND payload ->> 'wait' = 'true'
      AND (result ->> 'queued' = 'true' OR (result ->> 'queuedFolders')::int > 0)
    GROUP BY mailbox_id
    ORDER BY min(COALESCE(worker_heartbeat_at, started_at)), mailbox_id
    LIMIT 500
  `;
  for (const command of waiting) await submitSyncCheck(command.mailbox_id);
  const queued = await sql<{ id: string }[]>`
    SELECT id
    FROM mail.commands
    WHERE state = 'queued' AND kind = ANY(${toPgTextArray(MAINTENANCE_KINDS)}::text[])
    ORDER BY created_at, id
    LIMIT 500
  `;
  for (const command of queued) await enqueueMaintenanceCommand(command.id);
  return { queued: queued.length, recovered: recovered.length };
};

export const startMaintenanceRuntime = async (): Promise<void> => {
  maintenanceTasks.open();
  await startMaintenanceJob();
};

export const stopMaintenanceRuntime = async (): Promise<void> => {
  await stopRuntimeJobs(
    maintenanceTasks,
    [maintenanceJobWorker].filter((worker): worker is Worker => worker !== undefined),
  );
  maintenanceJobWorker = undefined;
};
