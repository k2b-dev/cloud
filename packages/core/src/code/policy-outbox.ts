import { sql } from "@k2b/cloud";
import { audit } from "@k2b/cloud/services";
import { createPgOutbox, type OutboxRow } from "@k2b/cloud/services/outbox";
import { codePolicyCandidates, codePolicyImpact, readCodePolicySnapshot } from "./policy";
import { StoredCodePolicyDefinitionSchema } from "./policy-contracts";

type PauseRow = OutboxRow & { revision: number; previous: unknown; cursor: string | null };
/** One transaction evaluates at most 50 active versions; continuation and visible pauses commit together.
 * Re-read current policy, coverage and the locked active version: superseded jobs cannot pause a newly allowed Code.
 */
export async function processCodePolicyPauseBatch(row: PauseRow): Promise<void> {
  await sql.begin(async (tx) => {
    // A previous lease holder that finishes after delivery sees no row and cannot recreate work.
    const claimed = await tx`SELECT id FROM code.policy_pause_outbox WHERE id=${row.id}::uuid FOR UPDATE`;
    if (!claimed.length) return;
    // Serialize with policy updates, and take this lock before Code rows (activation uses the same order).
    await tx`SELECT singleton FROM code.policy WHERE singleton FOR SHARE`;
    const current = await readCodePolicySnapshot(tx);
    const before = StoredCodePolicyDefinitionSchema.parse(row.previous);
    const candidates = await codePolicyCandidates(tx, row.cursor, 50, true);
    let pausedCount = 0;
    for (const candidate of candidates) {
      const impact = await codePolicyImpact(candidate, before, current.definition, tx);
      if (!impact) continue;
      pausedCount++;
      await tx`UPDATE code.codes SET state='paused',pause_reason=${impact.reason},pause_rows=${impact.rows}::text[],
        pause_policy_revision=${current.revision} WHERE id=${candidate.id} AND state='active' AND active_version_id IS NOT DISTINCT FROM ${candidate.active_version_id}::uuid`;
    }
    if (pausedCount)
      await audit.record(
        {
          action: "core.code.policy.pauses_applied",
          outcome: "allowed",
          actor: { uid: "core-code-policy", provider: "system" },
          target: { type: "code.policy", id: "default" },
          metadata: { revision: current.revision, jobRevision: row.revision, cursor: row.cursor, pausedCount },
        },
        tx,
      );
    if (candidates.length === 50)
      await tx`INSERT INTO code.policy_pause_outbox(revision,previous,cursor) VALUES(${row.revision},${JSON.stringify(before)}::text::jsonb,${candidates.at(-1)!.id}) ON CONFLICT DO NOTHING`;
  });
}
/** Durable Postgres outbox. Failed batches remain visible with attempts/last_error and retry with bounded backoff. */
export const codePolicyPauseOutbox = createPgOutbox<PauseRow>({
  table: "code.policy_pause_outbox",
  name: "core:code-policy",
  orderBy: "revision",
  sequence: "sequence",
  batchSize: 1,
  reconcileIntervalMs: 5000,
  publish: processCodePolicyPauseBatch,
});
