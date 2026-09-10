import type { MailAutomationStep } from "../contracts";
import { incomingAutomationActions } from "./incoming-automation-definition";
import type { SqlClient } from "./workflow-data";

/**
 * Whether this run may still decide where a message sits.
 *
 * Every matching incoming automation is dispatched as its own kernel run from
 * the same ingest transaction, so without a turn order two automations freeze
 * the same source folder and the loser orders a move out of a folder the
 * message has already left. The order is the mailbox's automation order —
 * oldest first — and only one automation moves one message: an automation an
 * older one has already overtaken skips its placement step instead of failing.
 */
export type IncomingAutomationPlacementTurn = { state: "ready" } | { state: "skip"; reason: "message_moved" | "earlier_automation" };

const parseSteps = (value: MailAutomationStep[] | string): MailAutomationStep[] =>
  typeof value === "string" ? (JSON.parse(value) as MailAutomationStep[]) : value;

const changesPlacement = (steps: MailAutomationStep[]): boolean =>
  incomingAutomationActions(steps).some((action) => action.kind === "junk" || action.kind === "trash" || action.kind === "move_to_folder");

export const resolveIncomingAutomationPlacementTurn = async (params: {
  db: SqlClient;
  runId: string;
  mailboxId: string;
  messageId: string;
  folderId: string;
}): Promise<IncomingAutomationPlacementTurn> => {
  const [placement] = await params.db<{ id: string }[]>`
    SELECT remote_ref.id
    FROM mail.remote_message_refs remote_ref
    JOIN mail.message_placements placement
      ON placement.remote_message_ref_id = remote_ref.id
     AND placement.deleted_at IS NULL
    WHERE remote_ref.message_id = ${params.messageId}::uuid
      AND remote_ref.folder_id = ${params.folderId}::uuid
      AND remote_ref.stale_at IS NULL
    LIMIT 1
  `;
  if (!placement) return { state: "skip", reason: "message_moved" };

  // A move another run already ordered has not reached the provider yet, so
  // the placement above still looks untouched.
  const [claimed] = await params.db<{ id: string }[]>`
    SELECT id
    FROM mail.commands
    WHERE mailbox_id = ${params.mailboxId}::uuid
      AND kind = 'move'
      AND target ->> 'remoteMessageRefId' = ${placement.id}
      AND state NOT IN ('failed', 'cancelled')
      AND correlation_id IS DISTINCT FROM ${params.runId}
    LIMIT 1
  `;
  if (claimed) return { state: "skip", reason: "earlier_automation" };

  // A workflow that is not an incoming automation has no place in that order.
  const [self] = await params.db<{ created_at: Date | string; id: string }[]>`
    SELECT automation.created_at, automation.id
    FROM workflows.run run
    JOIN mail.incoming_automations automation ON automation.workflow_id = run.workflow_id
    WHERE run.id = ${params.runId}::uuid
  `;
  if (!self) return { state: "ready" };

  const older = await params.db<{ steps: MailAutomationStep[] | string }[]>`
    SELECT older.steps
    FROM workflows.run run
    JOIN mail.incoming_automations older ON older.workflow_id = run.workflow_id
    WHERE run.app_id = 'mail'
      AND run.scope_id = ${params.mailboxId}
      AND run.mode = 'execute'
      AND run.state IN ('queued', 'running', 'waiting')
      AND run.id <> ${params.runId}::uuid
      AND run.context #>> '{preconditions,message,id}' = ${params.messageId}
      AND (older.created_at, older.id) < (${self.created_at}::timestamptz, ${self.id}::uuid)
  `;
  return older.some((row) => changesPlacement(parseSteps(row.steps)))
    ? { state: "skip", reason: "earlier_automation" }
    : { state: "ready" };
};
