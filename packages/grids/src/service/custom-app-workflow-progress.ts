import { sql } from "bun";
import { liveWorkflowRunEvents } from "./workflow-run-events";

/** Caller must authorize the run first. Return no step names, payloads or record IDs. */
export const workflowCommittedChanges = async (runId: string): Promise<number> => {
  const [row] = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM workflows.step_outcome
    WHERE run_id = ${runId}::uuid AND mode = 'execute' AND effect_state = 'succeeded'
      AND action IN ('atomicRecords', 'closeRecord', 'createCorrectionDraft', 'deleteRecord',
        'finalizeRecord', 'updateRecord', 'createRecord', 'createDocumentLink')
  `;
  return row?.count ?? 0;
};

/** Events only wake a fresh permission-checked read; their payload never reaches the client. */
export const waitForCustomAppWorkflowChange = async (
  input: { baseId: string; workflowId: string; runId: string; after: string; signal: AbortSignal },
  events = liveWorkflowRunEvents,
): Promise<boolean> => {
  const controller = new AbortController();
  // Preserve the existing two-second status refresh bound when a hint is lost.
  const timeout = setTimeout(() => controller.abort(), 2_000);
  const signal = AbortSignal.any([input.signal, controller.signal]);
  try {
    for await (const event of events({ ...input, signal })) {
      if (event.data.run.id !== input.runId) continue;
      if (event.data.run.status !== "running" || event.data.steps.some((step) => step.status !== "running")) return true;
    }
    return true;
  } catch {
    return signal.aborted;
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
};
