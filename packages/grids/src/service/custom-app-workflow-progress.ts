import { sql } from "bun";

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
