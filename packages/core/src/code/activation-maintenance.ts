import { sql } from "@k2b/cloud";
import { mandates } from "@k2b/cloud/services/mandates";
import { createPgOutbox, type OutboxRow } from "@k2b/cloud/services/outbox";
import { processCodeActivation } from "./activation";
import { findCode } from "./store";

/** Cleanup waits for queued/running runs of superseded versions, then revokes drained version entries. */
export async function cleanupCodeActivation(codeId: string): Promise<void> {
  const lock = await sql.reserve();
  let acquired = false;
  try {
    const [held] = await lock<
      { acquired: boolean }[]
    >`SELECT pg_try_advisory_lock(hashtextextended(${`core.code.activation:${codeId}`},0)) AS acquired`;
    if (!held?.acquired) throw new Error("Code activation is busy; cleanup will retry");
    acquired = true;
    const code = await findCode(codeId);
    if (!code || code.state === "deleting") return;
    const drained = await sql<
      { id: string; revision: number; owner_app_id: string }[]
    >`SELECT m.id,m.revision,m.owner_app_id FROM auth.mandates m JOIN code.versions v ON v.id::text=m.workload_id
      WHERE v.code_id=${codeId} AND m.owner_app_id IN ('core','runner') AND m.workload_type='code.version' AND m.state IN ('active','paused')
        AND v.id IS DISTINCT FROM ${code.activeVersionId}::uuid
        AND NOT EXISTS(SELECT 1 FROM code.runs r WHERE r.version_id=v.id AND r.state IN ('queued','running')) ORDER BY m.id LIMIT 50`;
    for (const mandate of drained) {
      const revoked = await mandates.revoke({
        mandateId: mandate.id,
        expectedRevision: Number(mandate.revision),
        authority: { kind: "workload", ownerAppId: mandate.owner_app_id },
        reason: "Code version drained",
      });
      if (!revoked.ok) throw new Error("Code version mandate cleanup must retry");
    }
    const [remaining] = await sql<{ pending: boolean }[]>`SELECT EXISTS(
      SELECT 1 FROM code.runs WHERE code_id=${codeId} AND version_id IS DISTINCT FROM ${code.activeVersionId}::uuid
      AND state IN ('queued','running')) AS pending`;
    if (remaining?.pending || drained.length === 50) throw new Error("Superseded Code versions are draining; cleanup will retry");
  } finally {
    try {
      if (acquired) await lock`SELECT pg_advisory_unlock(hashtextextended(${`core.code.activation:${codeId}`},0))`;
    } finally {
      lock.release();
    }
  }
}
type ActivationOutboxRow = OutboxRow & { code_id: string; activation_id: string | null };
/** Separate ordered streams: a draining old run never blocks a subsequent activation. Both use the same Code lock. */
export const codeActivationOutbox = createPgOutbox<ActivationOutboxRow>({
  table: "code.activation_outbox",
  name: "core:code-activation",
  where: { kind: "activation" },
  orderBy: "code_id",
  sequence: "sequence",
  batchSize: 1,
  reconcileIntervalMs: 5000,
  publish: async (row) => {
    if (row.activation_id) await processCodeActivation(row.activation_id);
  },
});
export const codeActivationCleanupOutbox = createPgOutbox<ActivationOutboxRow>({
  table: "code.activation_outbox",
  name: "core:code-version-drain",
  where: { kind: "cleanup" },
  orderBy: "code_id",
  sequence: "sequence",
  batchSize: 1,
  reconcileIntervalMs: 5000,
  publish: async (row) => cleanupCodeActivation(row.code_id),
});
