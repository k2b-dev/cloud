import type { MailAutomationStep } from "../contracts";
import { incomingAutomationActions } from "./incoming-automation-definition";
import type { SqlClient } from "./workflow-data";

/**
 * Whether an incoming automation may still decide where a message sits.
 *
 * Every matching incoming automation is dispatched as its own kernel run from
 * the same ingest transaction, so without a turn order two automations freeze
 * the same source folder and the loser orders a move out of a folder the
 * message has already left. The order is the mailbox's automation order —
 * oldest first — and only one automation moves one message: an automation an
 * older one has already overtaken skips its placement step instead of failing.
 * Only incoming automations yield; other workflows reach the action's target
 * lookup and fail if the message has left its folder.
 */
export type IncomingAutomationPlacementTurn = { state: "ready" } | { state: "skip"; reason: "message_moved" | "earlier_automation" };

const parseSteps = (value: MailAutomationStep[] | string): MailAutomationStep[] =>
  typeof value === "string" ? (JSON.parse(value) as MailAutomationStep[]) : value;

const changesPlacement = (steps: MailAutomationStep[]): boolean =>
  incomingAutomationActions(steps).some((action) => action.kind === "junk" || action.kind === "trash" || action.kind === "move_to_folder");

type IncomingAutomationMessageTurnParams = {
  db: SqlClient;
  runId: string;
  mailboxId: string;
  messageId: string;
  folderId: string;
};

type MessagePlacementParams = Pick<IncomingAutomationMessageTurnParams, "db" | "messageId" | "folderId">;

const loadIncomingAutomationMessagePlacement = async (params: MessagePlacementParams) => {
  const [placement] = await params.db<{ id: string; first_seen_at: string }[]>`
    SELECT remote_ref.id, remote_ref.first_seen_at::text
    FROM mail.remote_message_refs remote_ref
    JOIN mail.message_placements placement
      ON placement.remote_message_ref_id = remote_ref.id
     AND placement.deleted_at IS NULL
    WHERE remote_ref.message_id = ${params.messageId}::uuid
      AND remote_ref.folder_id = ${params.folderId}::uuid
      AND remote_ref.stale_at IS NULL
    LIMIT 1
  `;
  return placement;
};

const incomingAutomationOfRun = async (db: SqlClient, runId: string): Promise<string | null> => {
  const [self] = await db<{ id: string }[]>`
    SELECT automation.id
    FROM workflows.run run
    JOIN mail.incoming_automations automation ON automation.workflow_id = run.workflow_id
    WHERE run.id = ${runId}::uuid
  `;
  return self?.id ?? null;
};

/** Exported so tests can inspect its plan. */
export const pendingMoveClaimQuery = (db: SqlClient, params: { mailboxId: string; refId: string; firstSeenAt: string; runId: string }) =>
  db<{ id: string }[]>`
    SELECT id
    FROM mail.commands
    WHERE mailbox_id = ${params.mailboxId}::uuid
      AND created_at >= ${params.firstSeenAt}::timestamptz
      AND kind = 'move'
      -- The predicate lets Postgres use commands_message_target_idx.
      AND target ? 'remoteMessageRefId'
      AND target ->> 'remoteMessageRefId' = ${params.refId}
      AND state NOT IN ('failed', 'cancelled')
      AND correlation_id IS DISTINCT FROM ${params.runId}
    LIMIT 1
  `;

/** Incoming automation message checks: it still sits in the frozen folder, and no other run is moving it. */
const resolveMessageTurn = async (params: IncomingAutomationMessageTurnParams): Promise<IncomingAutomationPlacementTurn> => {
  const placement = await loadIncomingAutomationMessagePlacement(params);
  if (!placement) return { state: "skip", reason: "message_moved" };

  // A move another run already ordered has not reached the provider yet, so
  // the placement above still looks untouched.
  const [claimed] = await pendingMoveClaimQuery(params.db, {
    mailboxId: params.mailboxId,
    refId: placement.id,
    firstSeenAt: placement.first_seen_at,
    runId: params.runId,
  });
  return claimed ? { state: "skip", reason: "earlier_automation" } : { state: "ready" };
};

/**
 * Whether an incoming automation's flag or keyword step still changes the message.
 *
 * Once the message left the frozen folder, or another run is moving it, the
 * step skips instead of failing. It does not wait for older automations: a
 * flag change may go before an older automation's move. Other workflows keep
 * failing loudly, so a hand-written workflow never continues without a change
 * it asked for.
 */
export const resolveIncomingAutomationMessageStateTurn = async (
  params: IncomingAutomationMessageTurnParams,
): Promise<IncomingAutomationPlacementTurn> =>
  (await incomingAutomationOfRun(params.db, params.runId)) ? resolveMessageTurn(params) : { state: "ready" };

/** Whether an incoming automation's message has left the frozen folder, for example moved by another automation. */
export const incomingAutomationMessageLeft = async (params: Omit<IncomingAutomationMessageTurnParams, "mailboxId">): Promise<boolean> =>
  Boolean(await incomingAutomationOfRun(params.db, params.runId)) && !(await loadIncomingAutomationMessagePlacement(params));

/**
 * Only incoming automations yield to a moved message, a pending move, or an
 * older automation. Other workflows reach the target lookup in actions.ts
 * and fail there if the message has left its frozen folder. Ordered ingress
 * already uses frozen priority/UUID precedence; only older unordered events
 * retain the legacy creation-age check. Both paths still validate the source
 * placement and pending provider moves.
 */
export const resolveIncomingAutomationPlacementTurn = async (
  params: IncomingAutomationMessageTurnParams & { ordered?: boolean },
): Promise<IncomingAutomationPlacementTurn> => {
  const self = await incomingAutomationOfRun(params.db, params.runId);
  if (!self) return { state: "ready" };

  const turn = await resolveMessageTurn(params);
  if (turn.state === "skip" || params.ordered) return turn;

  const older = await params.db<{ steps: MailAutomationStep[] | string }[]>`
    SELECT older.steps
    FROM workflows.run run
    JOIN mail.incoming_automations older ON older.workflow_id = run.workflow_id
    JOIN mail.incoming_automations self ON self.id = ${self}::uuid
    WHERE run.app_id = 'mail'
      AND run.scope_id = ${params.mailboxId}
      AND run.mode = 'execute'
      AND run.state IN ('queued', 'running', 'waiting')
      AND run.id <> ${params.runId}::uuid
      AND run.context #>> '{preconditions,message,id}' = ${params.messageId}
      -- Compared in Postgres: created_at has microseconds, a JavaScript Date only milliseconds.
      AND (older.created_at, older.id) < (self.created_at, self.id)
  `;
  return older.some((row) => changesPlacement(parseSteps(row.steps)))
    ? { state: "skip", reason: "earlier_automation" }
    : { state: "ready" };
};
