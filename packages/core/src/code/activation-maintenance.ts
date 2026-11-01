import { type CodeAccessGrant, sql } from "@k2b/cloud";
import { notifications } from "@k2b/cloud/services";
import { mandates } from "@k2b/cloud/services/mandates";
import { createPgOutbox, type OutboxRow } from "@k2b/cloud/services/outbox";
import type { z } from "zod";
import { app } from "../config";
import { type CodeContext, CodeDataError, requireCodePermission } from "./access";
import { processCodeActivation } from "./activation";
import type { CodeTargetAccess, codeActivationContracts } from "./activation-contracts";
import { targetApp, targetKey } from "./activation-plan";
import { type CodeActivationTransport, codeActivationTransport } from "./activation-transport";
import { findCode } from "./store";

type TargetRow = {
  grant_id: string;
  target: { type: string; id: string };
  operations: string[];
  activating_person: string | null;
  activated_at: Date | null;
  activation_version_id: string;
};
/** Reconciliation only lists. Missing grants remain removed until someone explicitly starts another activation. */
export async function reconcileCodeAccess(
  input: z.infer<typeof codeActivationContracts.access.input>,
  context: CodeContext,
  transport: CodeActivationTransport = codeActivationTransport,
): Promise<CodeTargetAccess[]> {
  const code = await findCode(input.codeId);
  if (!code) throw new CodeDataError("NOT_FOUND", "Code not found.");
  await requireCodePermission(code, context);
  if (!code.serviceAccountId) return [];
  // The activation that created a grant names who confirmed it at the target and when it became active.
  const rows = await sql<
    TargetRow[]
  >`SELECT g.*,a.activating_person,a.version_id AS activation_version_id,CASE WHEN a.state='active' THEN a.updated_at END AS activated_at
    FROM code.target_grants g JOIN code.activations a ON a.id=g.activation_id
    WHERE g.code_id=${code.id} AND g.state IN ('granted','removed')
    AND EXISTS(SELECT 1 FROM code.version_grants vg WHERE vg.grant_id=g.grant_id AND vg.version_id=${code.activeVersionId}::uuid) ORDER BY g.grant_id`;
  const byApp = new Map<string, CodeAccessGrant[] | null>();
  for (const appId of new Set(rows.map((row) => targetApp(row.target)))) {
    try {
      byApp.set(appId, await transport.list(appId, code.serviceAccountId));
    } catch {
      byApp.set(appId, null);
    }
  }
  const states = rows.map((row): CodeTargetAccess => {
    const live = byApp.get(targetApp(row.target));
    return {
      grantId: row.grant_id,
      target: row.target,
      operations: row.operations,
      activatedBy: row.activating_person,
      activatedAt: row.activated_at ? row.activated_at.toISOString() : null,
      activatedVersionId: row.activation_version_id,
      state:
        live === null
          ? "unavailable"
          : live?.some(
                (entry) =>
                  entry.grantId === row.grant_id &&
                  entry.principal === code.serviceAccountId &&
                  targetKey(entry.target) === targetKey(row.target),
              )
            ? "present"
            : "removed",
      removedBy: null,
      removedAt: null,
    };
  });
  return withRemovals(states, code.serviceAccountId);
}
/**
 * Who removed a grant and when. The platform's generated `code.access.rm` writes its audit event in the same transaction
 * as the target's tombstone; the newest allowed event for this grant, Code account, target and its app answers it.
 */
async function withRemovals(rows: CodeTargetAccess[], principal: string): Promise<CodeTargetAccess[]> {
  const removed = rows.filter((row) => row.state === "removed");
  if (!removed.length) return rows;
  // Each grant is matched with its own target and owning app before the newest event is chosen.
  const events = await sql<{ grant_id: string; actor_user_id: string | null; created_at: Date }[]>`
    SELECT DISTINCT ON (r.grant_id) r.grant_id, e.actor_user_id, e.created_at
    FROM unnest(${removed.map((row) => row.grantId)}::text[], ${removed.map((row) => row.target.type)}::text[],
      ${removed.map((row) => row.target.id)}::text[], ${removed.map((row) => targetApp(row.target))}::text[])
      AS r(grant_id, target_type, target_id, app_id)
    JOIN audit.events e ON e.target_type = r.target_type AND e.target_id = r.target_id
    WHERE e.action = 'code.access.rm' AND e.outcome = 'allowed'
      AND e.metadata->>'grantId' = r.grant_id AND e.metadata->>'appId' = r.app_id AND e.metadata->>'principal' = ${principal}
    ORDER BY r.grant_id, e.created_at DESC`;
  const byGrant = new Map(events.map((event) => [event.grant_id, event]));
  return rows.map((row) => {
    const event = row.state === "removed" ? byGrant.get(row.grantId) : undefined;
    return event ? { ...row, removedBy: event.actor_user_id, removedAt: event.created_at.toISOString() } : row;
  });
}
/** Cleanup waits for queued/running runs of every superseded version, then removes only unused explicit grants and revokes drained mandates. */
export async function cleanupCodeActivation(
  codeId: string,
  transport: CodeActivationTransport = codeActivationTransport,
  notify: (input: {
    activationId: string;
    target: { type: string; id: string };
    userId: string;
    title: string;
    locale: string;
  }) => Promise<void> = sendNotice,
): Promise<void> {
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
    const notices = await sql<{ activation_id: string; target: { type: string; id: string }; user_id: string; locale: string }[]>`
      SELECT n.*,a.locale FROM code.activation_notices n JOIN code.activations a ON a.id=n.activation_id
      WHERE a.code_id=${codeId} AND NOT n.sent ORDER BY n.activation_id,n.target_key,n.user_id LIMIT 50`;
    for (const notice of notices) {
      await notify({
        activationId: notice.activation_id,
        target: notice.target,
        userId: notice.user_id,
        title: code.title,
        locale: notice.locale,
      });
      await sql`UPDATE code.activation_notices SET sent=TRUE WHERE activation_id=${notice.activation_id}::uuid AND target_key=${targetKey(notice.target)} AND user_id=${notice.user_id}::uuid`;
    }
    if (notices.length === 50) throw new Error("Code activation notices have another batch");
    const obsolete = await sql<
      TargetRow[]
    >`SELECT g.* FROM code.target_grants g WHERE g.code_id=${codeId} AND g.state IN ('granted','removed')
      AND EXISTS(SELECT 1 FROM code.activations a WHERE a.id=g.activation_id AND a.state IN ('active','failed','cancelled'))
      AND NOT EXISTS(SELECT 1 FROM code.version_grants vg WHERE vg.grant_id=g.grant_id AND
        (vg.version_id=${code.activeVersionId}::uuid OR EXISTS(SELECT 1 FROM code.runs r WHERE r.version_id=vg.version_id AND r.state IN ('queued','running'))))
      ORDER BY g.grant_id LIMIT 50`;
    for (const grant of obsolete) {
      if (code.serviceAccountId) await transport.remove(targetApp(grant.target), code.serviceAccountId, grant.grant_id);
      await sql`UPDATE code.target_grants SET state='released' WHERE grant_id=${grant.grant_id}::uuid`;
    }
    const drained = await sql<
      { id: string; revision: number }[]
    >`SELECT m.id,m.revision FROM auth.mandates m JOIN code.versions v ON v.id::text=m.workload_id
      WHERE v.code_id=${codeId} AND m.owner_app_id='core' AND m.workload_type='code.version' AND m.state IN ('active','paused')
        AND v.id IS DISTINCT FROM ${code.activeVersionId}::uuid
        AND NOT EXISTS(SELECT 1 FROM code.runs r WHERE r.version_id=v.id AND r.state IN ('queued','running')) ORDER BY m.id LIMIT 50`;
    for (const mandate of drained) {
      const revoked = await mandates.revoke({
        mandateId: mandate.id,
        expectedRevision: Number(mandate.revision),
        authority: { kind: "workload", ownerAppId: "core" },
        reason: "Code version drained",
      });
      if (!revoked.ok) throw new Error("Code version mandate cleanup must retry");
    }
    const [remaining] = await sql<{ pending: boolean }[]>`SELECT (
      EXISTS(SELECT 1 FROM code.target_grants g WHERE g.code_id=${codeId} AND g.state IN ('granted','removed')
        AND EXISTS(SELECT 1 FROM code.activations a WHERE a.id=g.activation_id AND a.state IN ('active','failed','cancelled')) AND NOT EXISTS
        (SELECT 1 FROM code.version_grants vg WHERE vg.grant_id=g.grant_id AND vg.version_id=${code.activeVersionId}::uuid))
      OR EXISTS(SELECT 1 FROM code.runs r WHERE r.code_id=${codeId} AND r.version_id IS DISTINCT FROM ${code.activeVersionId}::uuid AND r.state IN ('queued','running'))
    ) AS pending`;
    if (remaining?.pending || obsolete.length === 50 || drained.length === 50)
      throw new Error("Superseded Code versions are draining; cleanup will retry");
  } finally {
    try {
      if (acquired) await lock`SELECT pg_advisory_unlock(hashtextextended(${`core.code.activation:${codeId}`},0))`;
    } finally {
      lock.release();
    }
  }
}
async function sendNotice(input: {
  activationId: string;
  target: { type: string; id: string };
  userId: string;
  title: string;
  locale: string;
}): Promise<void> {
  const result = await notifications.send(app.notifications.codeAccessEnabled, {
    recipient: { userId: input.userId },
    data: { title: input.title, target: input.target },
    locale: input.locale,
    idempotencyKey: JSON.stringify([input.activationId, targetKey(input.target), input.userId]),
  });
  if (result.status === "error") throw new Error("Code activation notification could not be queued");
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
  name: "core:code-access-cleanup",
  where: { kind: "cleanup" },
  orderBy: "code_id",
  sequence: "sequence",
  batchSize: 1,
  reconcileIntervalMs: 5000,
  publish: async (row) => cleanupCodeActivation(row.code_id),
});
