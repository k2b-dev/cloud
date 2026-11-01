import { sql } from "@k2b/cloud";
import { CloudResourceRefSchema, cloudResourceRefAppId } from "@k2b/cloud/contracts";
import { audit } from "@k2b/cloud/services";
import { createPgOutbox, type OutboxRow } from "@k2b/cloud/services/outbox";
import type { SQL } from "bun";
import type { z } from "zod";
import type { CodeContext } from "./access";
import { targetApp } from "./activation-plan";
import { type CodeActivationTransport, CodeActivationTransportError, codeActivationTransport } from "./activation-transport";
import { type CodeCleanupJob, codeLifecycleContracts } from "./lifecycle-contracts";
import { requireCodePolicyAdmin } from "./policy";

type OwnerDeletedRow = OutboxRow & { app_id: string; ordering_key: string; payload: unknown };
type CleanupRow = OutboxRow & {
  code_id: string;
  kind: CodeCleanupJob["kind"];
  grant_id: string | null;
  target: CodeCleanupJob["target"];
};

/** Lock/revoke and persist all compensations atomically, before any network request.
 * Resource deletion is explicit. A missing app/reader never enters this path.
 */
export async function processCodeOwnerDeleted(row: OwnerDeletedRow): Promise<void> {
  const ref = CloudResourceRefSchema.parse(row.payload);
  if (cloudResourceRefAppId(ref) !== row.app_id) throw new Error("code_owner_source_invalid");
  await sql.begin(async (tx) => {
    // A stale delivery cannot recreate work after its report was acknowledged.
    const [report] = await tx`SELECT id FROM events.outbox WHERE id=${row.id}::uuid FOR UPDATE`;
    if (!report) return;
    const codes = await tx<{ id: string; service_account_id: string | null }[]>`
      SELECT id,service_account_id FROM code.codes WHERE state<>'deleting'
      AND created_at<=(SELECT created_at FROM events.outbox WHERE id=${row.id}::uuid) AND
      ((owner_kind='resource' AND owner_type=${ref.type} AND owner_id=${ref.id}) OR
       (owner_kind='person' AND ${ref.type === "core.user"} AND owner_user_id::text=${ref.id}
         AND NOT EXISTS(SELECT 1 FROM auth.users WHERE id::text=${ref.id})))
      ORDER BY id LIMIT 50 FOR UPDATE`;
    for (const code of codes) await lockDeletedCode(tx, code.id, code.service_account_id, row.id);
    // Continue through a fresh durable page, without treating bounded progress
    // as an outage or holding one transaction for all of a person's Code.
    if (codes.length === 50)
      await tx`INSERT INTO events.outbox(id,app_id,kind,ordering_key,payload,created_at)
        SELECT gen_random_uuid(),app_id,kind,ordering_key,payload,created_at FROM events.outbox WHERE id=${row.id}::uuid`;
  });
}

async function lockDeletedCode(db: SQL, codeId: string, principal: string | null, requestId: string): Promise<void> {
  await db`UPDATE code.codes SET state='deleting',pause_reason='owner_deleted',pause_rows='{}',pause_policy_revision=NULL WHERE id=${codeId}`;
  // Core owns both the workload and its mandate lifecycle. One statement fences every version immediately.
  const revoked = await db`UPDATE auth.mandates m SET state='revoked',revision=revision+1,updated_at=now(),revoked_at=now(),
    revoked_by_user_id=NULL,revoked_by_app_id='core',revoke_reason='Code owner deleted'
    WHERE m.owner_app_id='core' AND m.workload_type='code.version' AND m.state<>'revoked'
      AND EXISTS(SELECT 1 FROM code.versions v WHERE v.code_id=${codeId} AND v.id::text=m.workload_id)`;
  if (principal) await db`UPDATE auth.service_accounts SET status='disabled' WHERE id=${principal}::uuid AND kind='code'`;
  await db`UPDATE code.runs SET state='cancelled',outcome='owner_deleted',generation=generation+1,
    lease_expires_at=NULL,ended_at=clock_timestamp() WHERE code_id=${codeId} AND state IN ('queued','running')`;
  await db`UPDATE code.activations SET cancel_requested=TRUE,state='cancelled',authority=NULL,updated_at=now()
    WHERE code_id=${codeId} AND state NOT IN ('active','failed','cancelled')`;
  // Include planned IDs: a request issued just before deletion may still reach a target.
  // C3a rm creates a tombstone even when it wins that race against the first set.
  await db`INSERT INTO code.cleanup_jobs(code_id,kind,grant_id,target)
    SELECT code_id,'code.access.rm',grant_id,target FROM code.target_grants WHERE code_id=${codeId}
    ON CONFLICT(grant_id) DO NOTHING`;
  await db`INSERT INTO code.cleanup_jobs(code_id,kind) VALUES(${codeId},'code.delete') ON CONFLICT DO NOTHING`;
  await audit.record(
    {
      action: "core.code.owner_deleted",
      outcome: "allowed",
      actor: null,
      target: { type: "code", id: codeId },
      requestId,
      metadata: { revokedMandates: revoked.count },
    },
    db,
  );
}

/** One persisted job, one account-bound platform rm. Lost replies and duplicate deliveries are safe. */
export async function processCodeCleanupJob(
  row: CleanupRow,
  transport: Pick<CodeActivationTransport, "remove"> = codeActivationTransport,
): Promise<void> {
  try {
    await runCodeCleanupJob(row, transport);
  } catch (error) {
    const stable = [
      "code_activation_draining",
      "code_owner_reports_pending",
      "code_access_cleanup_pending",
      "code_cleanup_not_deleting",
      "code_cleanup_binding_invalid",
      "target_unavailable",
      "target_response_invalid",
      "target_cleanup_refused",
    ];
    throw new Error(
      error instanceof Error && (stable.includes(error.message) || /^target_http_[1-5]\d\d$/.test(error.message))
        ? error.message
        : "code_cleanup_failed",
    );
  }
}

async function runCodeCleanupJob(row: CleanupRow, transport: Pick<CodeActivationTransport, "remove">): Promise<void> {
  const [code] = await sql<{ state: string; service_account_id: string | null }[]>`
    SELECT c.state,c.service_account_id FROM code.codes c JOIN code.cleanup_jobs j ON j.code_id=c.id
    WHERE j.id=${row.id}::uuid AND c.id=${row.code_id}`;
  if (!code) return;
  if (code.state !== "deleting") throw new Error("code_cleanup_not_deleting");
  if (row.kind === "code.access.rm") {
    if (!row.target || !row.grant_id || !code.service_account_id) throw new Error("code_cleanup_binding_invalid");
    try {
      await transport.remove(targetApp(row.target), code.service_account_id, row.grant_id);
    } catch (error) {
      // Provider payloads, credentials and infrastructure addresses never enter the admin read model or logs.
      throw new Error(error instanceof CodeActivationTransportError ? error.code : "target_unavailable");
    }
    await sql`UPDATE code.target_grants SET state='released' WHERE code_id=${row.code_id} AND grant_id=${row.grant_id}::uuid`;
    return;
  }
  // Activation may be in a network checkpoint. Its session lock must drain before the journal is deleted.
  const lock = await sql.reserve();
  let acquired = false;
  try {
    const [held] = await lock<
      { acquired: boolean }[]
    >`SELECT pg_try_advisory_lock(hashtextextended(${`core.code.activation:${row.code_id}`},0)) AS acquired`;
    if (!held?.acquired) throw new Error("code_activation_draining");
    acquired = true;
    await sql.begin(async (tx) => {
      const [current] = await tx<
        { owner_kind: string; owner_type: string | null; owner_id: string | null; owner_user_id: string | null }[]
      >`
        SELECT owner_kind,owner_type,owner_id,owner_user_id FROM code.codes
        WHERE id=${row.code_id} AND state='deleting' FOR UPDATE`;
      if (!current) return;
      // Drain duplicate reports before releasing the unique owner identity for
      // fresh Code (for example after restoring a soft-deleted owner).
      const ownerType = current.owner_kind === "person" ? "core.user" : current.owner_type;
      const ownerId = current.owner_kind === "person" ? current.owner_user_id : current.owner_id;
      if (
        (
          await tx`SELECT id FROM events.outbox WHERE kind='code_owner_deleted'
        AND payload->>'type'=${ownerType} AND payload->>'id'=${ownerId} LIMIT 1`
        ).length
      )
        throw new Error("code_owner_reports_pending");
      if ((await tx`SELECT id FROM code.cleanup_jobs WHERE code_id=${row.code_id} AND kind='code.access.rm' LIMIT 1`).length)
        throw new Error("code_access_cleanup_pending");
      // Version/run/share cascades and the Code-owned account trigger are the C6 authority.
      // Per-Code databases are introduced in Phase 2; no database can be provisioned in Phase 1.
      await tx`DELETE FROM code.codes WHERE id=${row.code_id}`;
      await audit.record(
        { action: "core.code.deleted", outcome: "allowed", actor: null, target: { type: "code", id: row.code_id }, requestId: row.id },
        tx,
      );
    });
  } finally {
    try {
      if (acquired) await lock`SELECT pg_advisory_unlock(hashtextextended(${`core.code.activation:${row.code_id}`},0))`;
    } finally {
      lock.release();
    }
  }
}

/** Permission-aware C22 read model. Rows persist through outages and show automatic retry state. */
export async function listCodeCleanupJobs(raw: z.input<typeof codeLifecycleContracts.cleanup.input>, context: CodeContext) {
  requireCodePolicyAdmin(context);
  const input = codeLifecycleContracts.cleanup.input.parse(raw);
  const rows = await sql<
    (CleanupRow & { title: string; created_at: Date; next_attempt_at: Date; last_error: string | null; running: boolean })[]
  >`
    SELECT j.*,c.title,(j.claimed_until>clock_timestamp()) IS TRUE AS running
    FROM code.cleanup_jobs j JOIN code.codes c ON c.id=j.code_id
    WHERE (${input.codeId ?? null}::text IS NULL OR j.code_id=${input.codeId ?? null})
      AND (${input.cursor ?? null}::uuid IS NULL OR j.id>${input.cursor ?? null}::uuid)
    ORDER BY j.id LIMIT ${input.limit + 1}`;
  return codeLifecycleContracts.cleanup.data.parse({
    items: rows.slice(0, input.limit).map(
      (row): CodeCleanupJob => ({
        id: row.id,
        codeId: row.code_id,
        title: row.title,
        kind: row.kind,
        grantId: row.grant_id,
        target: row.target,
        state: row.running ? "running" : row.attempts ? "waiting" : "pending",
        attempts: row.attempts,
        lastError: row.last_error,
        nextAttemptAt: row.next_attempt_at.toISOString(),
        createdAt: row.created_at.toISOString(),
      }),
    ),
    nextCursor: rows.length > input.limit ? rows[input.limit - 1]!.id : null,
  });
}

/** Core directly drains the existing platform outbox; no finite-retention transport can lose a deletion. */
export const codeOwnerDeletedOutbox = createPgOutbox<OwnerDeletedRow>({
  table: "events.outbox",
  name: "core:code-owner-deleted",
  where: { kind: "code_owner_deleted" },
  orderBy: "ordering_key",
  sequence: "seq",
  batchSize: 1,
  reconcileIntervalMs: 1000,
  publish: processCodeOwnerDeleted,
});
/** Independent grant keys keep an unreachable target from holding back another grant. */
export const codeAccessCleanupOutbox = createPgOutbox<CleanupRow>({
  table: "code.cleanup_jobs",
  name: "core:code-access-removal",
  where: { kind: "code.access.rm" },
  orderBy: "id",
  sequence: "sequence",
  batchSize: 1,
  claimMs: 90_000,
  reconcileIntervalMs: 1000,
  publish: processCodeCleanupJob,
});
export const codeDeletionOutbox = createPgOutbox<CleanupRow>({
  table: "code.cleanup_jobs",
  name: "core:code-deletion",
  where: { kind: "code.delete" },
  orderBy: "id",
  sequence: "sequence",
  batchSize: 1,
  reconcileIntervalMs: 1000,
  publish: processCodeCleanupJob,
});
