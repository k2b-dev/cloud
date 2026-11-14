import type { sql } from "@k2b/cloud";
import { workflowEffectKey } from "@k2b/cloud/shared";
import { z } from "zod";

// The old rule path stays intact until its commands have drained. Ordinary command
// payloads and provider preconditions live in command-message-state, outside this bridge.
export { workflowEffectKey } from "@k2b/cloud/shared";
export { invalidateAutomationEffects } from "./automation-effect-state";
export { publishMailWorkflowDependency } from "./workflow-dependencies";
export { loadIncomingAutomationSiblingTransitions } from "./workflow-message-preconditions";
export { authorizeMailWorkflowSend } from "./workflow-send-policy";

/**
 * Whether the workflow run that issued a command still wants its effect.
 *
 * A command belongs to the step whose kernel effect key is its idempotency
 * key. The command is wanted while its run is live and that step still runs or
 * waits for it. A waiting step runs again on every dependency recheck, under a
 * newer execution generation, and adopts the command it already issued, so a
 * generation change alone does not make the command stale. A canceled or ended
 * run, a changed workflow version, or a step that settled without the command
 * does. Stale workers are fenced where the command is created: only the step
 * that runs under the run's current generation and lease may create or adopt it.
 *
 * Locks the run, so a cancel request or a new claim cannot interleave. Call it
 * before locking the command: a step that adopts its command and mailbox
 * deletion take the run first, too. The step row is not locked: a step that
 * settles while the check runs counts as settling just after it. The action
 * adopts an existing command before it could settle without it.
 */
export const workflowCommandStillWanted = async (
  tx: typeof sql,
  command: { id: string; correlation_id: string | null },
): Promise<boolean> => {
  const runId = z.uuid().safeParse(command.correlation_id);
  if (!runId.success) return false;
  const [run] = await tx<{ id: string }[]>`
    SELECT run.id
    FROM mail.commands command
    JOIN workflows.run run ON run.id = ${runId.data}::uuid
    JOIN workflows.step_outcome step
      ON step.run_id = run.id
     AND command.idempotency_key = ${workflowEffectKey(runId.data, "")} || step.step_key
    WHERE command.id = ${command.id}::uuid
      AND command.correlation_id = run.id::text
      AND run.workflow_version_id = command.actor_id
      AND run.state IN ('queued', 'running', 'waiting')
      AND run.cancel_requested_at IS NULL
      AND step.state IN ('running', 'waiting')
    FOR UPDATE OF run
  `;
  return Boolean(run);
};
