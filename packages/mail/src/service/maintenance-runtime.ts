import type { Worker } from "@k2b/sync";
import { expBackoff } from "@k2b/sync/retry";
import { lazySync } from "@valentinkolb/cloud";
import { createRuntimeTaskTracker, stopRuntimeJobs } from "@valentinkolb/cloud/services";
import { toPgTextArray } from "@valentinkolb/cloud/services/postgres";
import { sql } from "bun";
import { z } from "zod";
import { type CommandState, type MaintenanceCommandInput, maintenanceCommandInputSchema } from "../contracts";
import { commandStillAuthorized, type StoredCommandAuthorization } from "./command-authorization";
import { withLeaseHeartbeat } from "./lease-heartbeat";
import { executeOperatorAction, OPERATOR_MAINTENANCE_KINDS } from "./operator-actions";
import { enqueueFolderSync, enqueueMailboxSync, enqueueMessageHydration, executeBindingRediscovery } from "./sync-runtime";

const MAINTENANCE_JOB_LEASE_MS = 6 * 60_000;
const STALE_EXECUTION_MINUTES = 10;
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
  command: DbMaintenanceCommand;
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
  if (enqueueWork) {
    for (const message of queued) await enqueueMessageHydration(message.id);
  }
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

export const executeMaintenanceCommand = async (
  commandId: string,
  jobHeartbeat: () => Promise<void> = async () => undefined,
  options: { enqueueWork?: boolean } = {},
): Promise<CommandState | null> => {
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
    await finishMaintenanceCommand({ command, state: "confirmed", result });
    return "confirmed";
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
      return "queued";
    }
    await finishMaintenanceCommand({ command, state: "failed", error });
    return "failed";
  }
};

const maintenanceJob = lazySync((sync) =>
  sync.job<{ commandId: string; continuationAttempt?: number }>({
    id: "mail:execute-maintenance-command",
    delivery: { ackWaitMs: MAINTENANCE_JOB_LEASE_MS, maxAttempts: 1, backoffMs: [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000] },
  }),
);
let maintenanceJobWorker: Worker | undefined;

const startMaintenanceJob = async (): Promise<void> => {
  maintenanceJobWorker = await maintenanceJob().process({}, async (ctx) => {
    const state = await executeMaintenanceCommand(ctx.input.commandId, () => ctx.heartbeat());
    if (state === "queued") {
      const attempt = (ctx.input.continuationAttempt ?? 0) + ctx.attempt;
      ctx.resubmit({
        delayMs: expBackoff(attempt, { baseMs: 2_000, maxMs: 60_000 }),
        input: { ...ctx.input, continuationAttempt: attempt },
      });
    }
  });
};

export const enqueueMaintenanceCommand = async (commandId: string): Promise<void> => {
  await (maintenanceTasks.run(() => maintenanceJob().submit({ coalesce: true, key: `maintenance:${commandId}`, input: { commandId } })) ??
    Promise.resolve());
};

export const submitDueMaintenanceCommands = async (): Promise<{ queued: number; recovered: number }> => {
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
    RETURNING id
  `;
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
