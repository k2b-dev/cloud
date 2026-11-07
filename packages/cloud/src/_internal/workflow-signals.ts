/** Existing workflow-table and wake-topic protocol, shared by the engine and AI workers.
 * Keep this independent of the engine: any shared AI worker can finish a run-owned task.
 */
import type { SQL } from "bun";
import { logger } from "../services/logging";
import { lazySync } from "./process-sync";
import { withTransaction } from "./sql-transaction";
import { workWakeOrigin } from "./work-wake";

const log = logger("workflows:worker");
export const workflowWakeTopic = lazySync((sync) =>
  sync.topic<{ origin: string } | null>({
    id: "cloud:workflow-wake",
    owner: "cloud",
    retention: { maxAgeMs: 120_000, maxBytes: 1_048_576 },
    maxPayloadBytes: 2000,
  }),
);
export const localWorkflowWorkers = new Map<string, Set<() => void>>();

/** Call after the application's transaction commits. Postgres remains the work queue. */
export const notifyWorkflowWorker = (appId: string): void => {
  for (const wake of localWorkflowWorkers.get(appId) ?? []) wake();
  // Hints are best effort. Neither broker latency nor failure delays an accepted request.
  void Promise.resolve()
    .then(() => workflowWakeTopic().publish({ tenantId: appId, data: { origin: workWakeOrigin } }))
    .catch((error) => {
      log.warn("Workflow wake notification failed", { appId, error: String(error) });
    });
};

/** Re-queues every run parked on a dependency that has now been satisfied. */
export const wakeWorkflowRunsWaitingOn = async (
  dependency: { appId: string; kind: string; key: string },
  options: { db?: SQL } = {},
): Promise<string[]> => {
  return withTransaction(options.db, async (tx) => {
    await tx`
      INSERT INTO workflows.dependency_signal (app_id, kind, key)
      VALUES (${dependency.appId}, ${dependency.kind}, ${dependency.key})
      ON CONFLICT (app_id, kind, key) DO UPDATE
      SET updated_at = now()
    `;
    const rows = await tx<{ id: string }[]>`
      UPDATE workflows.run AS r
      SET state = 'queued', wake_at = NULL, updated_at = now()
      FROM workflows.step_outcome AS s
      WHERE s.run_id = r.id
        AND s.state = 'waiting'
        AND s.dependency ->> 'kind' = ${dependency.kind}
        AND s.dependency ->> 'key' = ${dependency.key}
        AND r.app_id = ${dependency.appId}
        AND r.state = 'waiting'
      RETURNING r.id
    `;
    return rows.map((row) => row.id).sort();
  });
};
