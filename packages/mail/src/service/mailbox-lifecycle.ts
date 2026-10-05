import { sql } from "bun";
import { cancelPendingAutomaticRepliesInTransaction } from "./automatic-reply";

type SqlClient = typeof sql;

type MailboxExecutionPauseSummary = {
  resources: number;
  syncRuns: number;
  commandsCancelled: number;
  commandsNeedAttention: number;
  outboxCancelled: number;
  outboxNeedAttention: number;
  workflowsDisabled: number;
  workflowRunsCancellationRequested: number;
};

const affectedRows = (result: { count: number }): number => Number(result.count);

export const pauseMailboxTransport = async (params: {
  mailboxId: string;
  code: "MAILBOX_DELETED" | "MAILBOX_RESTORED_PAUSED";
  message: string;
  db?: SqlClient;
}): Promise<number> => {
  const db = params.db ?? sql;
  const resources = await db`
    UPDATE mail.remote_resources
    SET
      status = 'paused',
      sync_generation = sync_generation + 1,
      current_fence_token = current_fence_token + 1,
      last_error_code = ${params.code},
      last_error_message = ${params.message},
      updated_at = now()
    WHERE mailbox_id = ${params.mailboxId}::uuid
  `;
  return affectedRows(resources);
};

export const pauseDeletedMailboxExecution = async (mailboxId: string, db: SqlClient = sql): Promise<MailboxExecutionPauseSummary> => {
  const code = "MAILBOX_DELETED";
  const message = "Mailbox was deleted; execution remains paused after restore until an administrator resumes it";
  const resources = await pauseMailboxTransport({ mailboxId, code, message, db });
  const syncRuns = await db`
    UPDATE mail.sync_runs run
    SET state = 'cancelled', error_code = ${code}, error_message = ${message}, finished_at = now()
    FROM mail.remote_resources resource
    WHERE run.remote_resource_id = resource.id
      AND resource.mailbox_id = ${mailboxId}::uuid
      AND run.state = 'running'
  `;
  const [outbox] = await db<{ cancelled: number; needs_attention: number }[]>`
    WITH changed AS (
      UPDATE mail.outbox_submissions submission
      SET
        state = CASE
          WHEN submission.state IN ('scheduled', 'undo_window') THEN 'cancelled'
          ELSE 'needs_attention'
        END,
        last_error_code = ${code},
        last_error_message = ${message},
        updated_at = now()
      WHERE submission.mailbox_id = ${mailboxId}::uuid
        AND submission.state IN ('scheduled', 'undo_window', 'sending', 'accepted', 'sent_sync_pending', 'unknown')
      RETURNING submission.draft_id, submission.state
    ), stopped_copy_retries AS (
      -- A partly accepted send keeps its outcome; only the retry of its Sent copy stops, like any other.
      UPDATE mail.outbox_submissions submission
      SET sent_copy_pending = false, updated_at = now()
      WHERE submission.mailbox_id = ${mailboxId}::uuid AND submission.state = 'needs_attention' AND submission.sent_copy_pending
    ), reset_drafts AS (
      UPDATE mail.drafts draft
      SET state = 'draft', updated_at = now()
      WHERE draft.id IN (SELECT draft_id FROM changed WHERE state = 'cancelled')
        AND draft.state IN ('scheduled', 'sending')
    )
    SELECT
      COUNT(*) FILTER (WHERE state = 'cancelled')::int AS cancelled,
      COUNT(*) FILTER (WHERE state = 'needs_attention')::int AS needs_attention
    FROM changed
  `;
  const [commands] = await db<{ cancelled: number; needs_attention: number }[]>`
    WITH changed AS (
      UPDATE mail.commands command
      SET
        state = CASE
          WHEN command.state = 'ambiguous'
            OR command.provider_effect_started_at IS NOT NULL
            OR EXISTS (
              SELECT 1
              FROM mail.outbox_submissions submission
              WHERE submission.command_id = command.id AND submission.state = 'needs_attention'
            )
          THEN 'needs_attention'
          ELSE 'cancelled'
        END,
        finished_at = now(),
        worker_heartbeat_at = NULL,
        last_error_code = ${code},
        last_error_message = ${message},
        updated_at = now()
      WHERE command.mailbox_id = ${mailboxId}::uuid
        AND command.state IN ('queued', 'executing', 'ambiguous')
      RETURNING command.state
    )
    SELECT
      COUNT(*) FILTER (WHERE state = 'cancelled')::int AS cancelled,
      COUNT(*) FILTER (WHERE state = 'needs_attention')::int AS needs_attention
    FROM changed
  `;
  const workflowsDisabled = await db`
    UPDATE mail.workflow_profile
    SET enabled = false, updated_at = now()
    WHERE mailbox_id = ${mailboxId}::uuid AND enabled
  `;
  await db`
    UPDATE workflows.activation activation
    SET enabled = false, updated_at = now()
    WHERE activation.workflow_id IN (
      SELECT id FROM mail.workflow_profile WHERE mailbox_id = ${mailboxId}::uuid
    )
      AND activation.enabled
  `;
  const workflowRuns = await db`
    UPDATE workflows.run run
    SET
      cancel_requested_at = COALESCE(run.cancel_requested_at, now()),
      execution_generation = run.execution_generation + 1,
      lease_owner = NULL,
      lease_expires_at = NULL,
      updated_at = now()
    FROM mail.workflow_profile profile
    WHERE run.workflow_id = profile.id
      AND profile.mailbox_id = ${mailboxId}::uuid
      AND run.state IN ('queued', 'running', 'waiting')
      AND run.cancel_requested_at IS NULL
  `;
  await cancelPendingAutomaticRepliesInTransaction({ db, mailboxId, code, message });

  return {
    resources,
    syncRuns: affectedRows(syncRuns),
    commandsCancelled: commands?.cancelled ?? 0,
    commandsNeedAttention: commands?.needs_attention ?? 0,
    outboxCancelled: outbox?.cancelled ?? 0,
    outboxNeedAttention: outbox?.needs_attention ?? 0,
    workflowsDisabled: affectedRows(workflowsDisabled),
    workflowRunsCancellationRequested: affectedRows(workflowRuns),
  };
};
