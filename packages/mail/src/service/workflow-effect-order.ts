import type { WorkflowActionResult, WorkflowJsonValue } from "@k2b/cloud/workflows";
import type { sql } from "bun";
import { mailWorkflowDependencyDeadline } from "./workflow-dependencies";

type SqlClient = typeof sql;
export type MailWorkflowExclusiveEffect = "assignment" | "placement" | "status";
export type MailWorkflowEffectTurn =
  | { state: "ready"; ordered: boolean }
  | { state: "waiting"; dependency: { kind: "mail.workflow_effect_order"; key: string; deadline: string } }
  | { state: "skip"; reason: "upper_rule"; workflowId: string; name: string }
  | { state: "skip"; reason: "order_expired" };

type Participant = {
  event_id: string;
  mailbox_id: string;
  remote_message_ref_id: string;
  workflow_id: string;
  position: number;
  workflow_name: string;
};

/** Freeze the mailbox priority/UUID order in the same transaction as the pinned ingress events. */
export const captureMailWorkflowEffectOrder = async (
  db: SqlClient,
  input: {
    eventId: string;
    mailboxId: string;
    remoteMessageRefId: string;
    workflowId: string;
    position: number;
    name: string;
  },
): Promise<void> => {
  await db`
    INSERT INTO mail.workflow_effect_order (
      event_id, mailbox_id, remote_message_ref_id, workflow_id, position, workflow_name
    ) VALUES (
      ${input.eventId}::uuid, ${input.mailboxId}::uuid, ${input.remoteMessageRefId}::uuid,
      ${input.workflowId}::uuid, ${input.position}, ${input.name}
    ) ON CONFLICT DO NOTHING
  `;
};

const loadParticipant = async (db: SqlClient, runId: string): Promise<Participant | undefined> => {
  const [self] = await db<Participant[]>`
    SELECT ordering.event_id::text, ordering.mailbox_id::text, ordering.remote_message_ref_id::text, ordering.workflow_id::text,
           ordering.position, ordering.workflow_name
    FROM workflows.run run
    JOIN mail.workflow_effect_order ordering ON ordering.event_id = run.event_id
    WHERE run.id = ${runId}::uuid AND run.mode = 'execute'
  `;
  return self;
};

/**
 * Call only in an effect transaction. The lock must cover both the turn check and effect/claim.
 * No run locks are acquired here: command creation already fences its own run, and locking upper
 * runs would invert that order. A terminal/expired upper is durably closed under this same lock.
 */
export const resolveMailWorkflowEffectTurn = async (
  db: SqlClient,
  input: { runId: string; effectClass: MailWorkflowExclusiveEffect },
): Promise<MailWorkflowEffectTurn> => {
  const self = await loadParticipant(db, input.runId);
  // Manual, schedule and pre-upgrade events retain their existing behavior.
  if (!self) return { state: "ready", ordered: false };
  await db`SELECT pg_advisory_xact_lock(hashtextextended(${`mail:workflow-effect-order:${self.mailbox_id}:${self.remote_message_ref_id}`}, 0))`;

  // A claim made atomically with an effect still wins if its run later fails or expires.
  const [claim] = await db<{ run_id: string; workflow_id: string; workflow_name: string }[]>`
    SELECT claim.run_id::text, winner.workflow_id::text, winner.workflow_name
    FROM mail.workflow_effect_claim claim
    JOIN mail.workflow_effect_order winner ON winner.event_id = claim.event_id
    WHERE claim.remote_message_ref_id = ${self.remote_message_ref_id}::uuid
      AND claim.effect_class = ${input.effectClass}
  `;

  // Persist the fence before allowing lower work. A deferred delivery without a run is pending,
  // never evidence that the upper rule decided nobody. Dispatch failure is a terminal no-effect.
  // Expiry retires only predecessors: all siblings share the ingress deadline, and expiring the
  // current waiter too would prevent any lower rule from ever taking over. Once overtaken, the
  // closed_at fence prevents an upper from applying late effects, even after a worker restart.
  await db`
    UPDATE mail.workflow_effect_order ordering SET closed_at = now()
    WHERE ordering.remote_message_ref_id = ${self.remote_message_ref_id}::uuid
      AND ordering.closed_at IS NULL
      AND (
        (ordering.position < ${self.position} AND ordering.expires_at <= now())
        OR EXISTS (SELECT 1 FROM workflows.event event
                   WHERE event.id = ordering.event_id AND (
                     event.dispatch_failed_at IS NOT NULL OR event.matched_count = 0
                   ))
        OR (
          EXISTS (SELECT 1 FROM workflows.run run WHERE run.event_id = ordering.event_id)
          AND NOT EXISTS (
            SELECT 1 FROM workflows.run run WHERE run.event_id = ordering.event_id
              AND run.state NOT IN ('succeeded', 'failed', 'canceled', 'needs_attention')
          )
        )
      )
  `;
  const [closed] = await db<{ closed: boolean }[]>`
    SELECT closed_at IS NOT NULL AS closed FROM mail.workflow_effect_order WHERE event_id = ${self.event_id}::uuid
  `;
  if (closed?.closed) return { state: "skip", reason: "order_expired" };
  if (claim && claim.run_id !== input.runId) {
    return { state: "skip", reason: "upper_rule", workflowId: claim.workflow_id, name: claim.workflow_name };
  }
  if (claim) return { state: "ready", ordered: true };

  const [upper] = await db<{ event_id: string }[]>`
    SELECT event_id::text FROM mail.workflow_effect_order
    WHERE remote_message_ref_id = ${self.remote_message_ref_id}::uuid
      AND position < ${self.position} AND closed_at IS NULL
    ORDER BY position LIMIT 1
  `;
  return upper
    ? {
        state: "waiting",
        dependency: { kind: "mail.workflow_effect_order", key: upper.event_id, deadline: mailWorkflowDependencyDeadline() },
      }
    : { state: "ready", ordered: true };
};

/** Must follow a ready turn and the actual effect, on the same transaction/connection. */
export const claimMailWorkflowEffect = async (
  db: SqlClient,
  input: { runId: string; effectClass: MailWorkflowExclusiveEffect },
): Promise<void> => {
  const self = await loadParticipant(db, input.runId);
  if (!self) return;
  await db`
    INSERT INTO mail.workflow_effect_claim (remote_message_ref_id, effect_class, event_id, run_id)
    VALUES (${self.remote_message_ref_id}::uuid, ${input.effectClass}, ${self.event_id}::uuid, ${input.runId}::uuid)
    ON CONFLICT DO NOTHING
  `;
};

export const mailWorkflowEffectTurnOutcome = (
  turn: Exclude<MailWorkflowEffectTurn, { state: "ready" }>,
  output: Record<string, WorkflowJsonValue>,
): WorkflowActionResult<WorkflowJsonValue> =>
  turn.state === "waiting"
    ? turn
    : {
        state: "succeeded",
        output: {
          ...output,
          applied: false,
          skipped: turn.reason,
          ...(turn.reason === "upper_rule" ? { workflowId: turn.workflowId, name: turn.name } : {}),
        },
      };
