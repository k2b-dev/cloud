import type { SQL } from "bun";
import { capabilityCallDigest, capabilityValueDigest, normalizeCapabilityCall } from "../capabilities/calls";
import { type NormalizedCapabilityCall, NormalizedCapabilityCallSchema } from "../contracts/capabilities";
import { sql } from "../runtime/clients";
import { audit } from "../services/audit";
import { legacyTargetOperation, migrateLegacyCapabilityCall } from "../services/mandates/target-migration";
import { parsePgJsonValue } from "../services/postgres";

export const CAPABILITY_TARGET_REASK_HINT = "Bitte neu anfragen";

/** Each pending question is upgraded once, before Core starts AI workers. */
export const migrateAiCapabilityTargets = async (db: SQL = sql): Promise<void> => {
  // Existing rows start at zero; rows created by the upgraded code need no legacy conversion.
  await db.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('ai.capability-targets-v1'))`;
    await tx`ALTER TABLE ai.pending_actions ADD COLUMN IF NOT EXISTS capability_target_version INTEGER NOT NULL DEFAULT 0`;
    await tx`ALTER TABLE ai.pending_actions ALTER COLUMN capability_target_version SET DEFAULT 1`;
    // Each checkpoint removes one entry; later rows never require rescanning completed history.
    await tx`CREATE INDEX IF NOT EXISTS idx_ai_pending_actions_capability_target_upgrade
      ON ai.pending_actions(id) WHERE capability_target_version = 0 AND status = 'pending'`;
  });
  while (await db.begin(migrateApproval)) {
    /* Bounded rows; no payload-sized batches in memory. */
  }
};

type LegacyApprovalRow = {
  id: string;
  approval_id: string | null;
  turn_id: string;
  call_id: string;
  tool_name: string;
  args: unknown;
  status: string;
  kind: string;
};

const migrateApproval = async (tx: SQL): Promise<boolean> => {
  await tx`SELECT pg_advisory_xact_lock(hashtext('ai.capability-targets-v1'))`;
  const [pending] = await tx<LegacyApprovalRow[]>`SELECT id, approval_id, turn_id, call_id, tool_name, args, status, kind
    FROM ai.pending_actions WHERE capability_target_version = 0 AND status = 'pending' ORDER BY id LIMIT 1 FOR UPDATE`;
  // A decision can commit just before shutdown, with execution still queued. Completed receipts stay untouched.
  const [row] = pending
    ? [pending]
    : await tx<LegacyApprovalRow[]>`
    SELECT action.id, action.approval_id, action.turn_id, action.call_id, action.tool_name, action.args, action.status, action.kind
    FROM ai.turns turn JOIN ai.pending_actions action ON action.turn_id = turn.id
      JOIN approvals.requests request ON request.id = action.approval_id
    WHERE turn.status IN ('queued', 'running', 'waiting_for_action') AND action.status = 'resolved'
      AND action.capability_target_version = 0 AND request.status = 'approved'
    ORDER BY action.id LIMIT 1 FOR UPDATE OF action`;
  if (!row) return false;
  await tx`UPDATE ai.pending_actions SET capability_target_version = 1 WHERE id = ${row.id}::uuid`;
  if (row.kind === "client_tool") return true;
  const operation = legacyTargetOperation(row.tool_name, "action");
  // Built-in and nested tool approvals have no changed capability contract.
  if (!operation && !row.tool_name.includes(".") && !row.tool_name.includes("__action__")) return true;
  const storedArgs = parsePgJsonValue(row.args);
  let call: NormalizedCapabilityCall | undefined;
  try {
    if (!operation) throw new Error("Unknown capability proposal");
    const normalized = NormalizedCapabilityCallSchema.safeParse(storedArgs);
    if (normalized.success && normalized.data.capability === `${operation.appId}.${operation.capabilityId}`) {
      call = normalized.data;
    } else {
      // Model-only wording was never part of the approved domain input.
      const args =
        typeof storedArgs === "object" && storedArgs !== null && !Array.isArray(storedArgs)
          ? Object.fromEntries(Object.entries(storedArgs).filter(([key]) => key !== "approvalReason" || operation.fields?.includes(key)))
          : storedArgs;
      call = migrateLegacyCapabilityCall(operation, args);
    }
    call = normalizeCapabilityCall(
      operation.appId,
      {
        localId: operation.capabilityId,
        target: operation.target,
        refs: Object.fromEntries(Object.entries(operation.refs ?? {}).map(([key, ref]) => [key, ref.type])),
      },
      { input: call.input, target: call.target ?? undefined, refs: call.refs },
    );
    if (
      operation.fields &&
      (typeof call.input !== "object" ||
        call.input === null ||
        Array.isArray(call.input) ||
        Object.keys(call.input).some((key) => !operation.fields!.includes(key)))
    )
      throw new Error("Legacy proposal retains unsupported input fields");
  } catch {
    // Conversion failures are expected. Database failures must escape and roll back.
    call = undefined;
  }
  if (call && row.approval_id) {
    const updated = await tx`UPDATE approvals.requests SET args_digest = ${capabilityCallDigest(call)}
      WHERE id = ${row.approval_id}::uuid AND status IN ('pending', 'approved') AND requester_kind = 'assistant_turn'
        AND requester_ref = ${`${row.turn_id}/${row.call_id}`}
        AND app_id = ${operation!.appId} AND action = ${operation!.capabilityId}
        AND args_digest IN (${capabilityValueDigest(storedArgs)}, ${capabilityCallDigest(call)}) RETURNING id`;
    if (!updated.length) call = undefined;
  }
  if (!call) {
    const aborted = await tx<{ id: string; approval_id: string | null; call_id: string; tool_name: string }[]>`
      UPDATE ai.pending_actions SET status = 'aborted', message = ${CAPABILITY_TARGET_REASK_HINT}, resolved_at = now(), capability_target_version = 1
      WHERE turn_id = ${row.turn_id}::uuid AND (status = 'pending' OR
        (status = 'resolved' AND approval_id IN (SELECT id FROM approvals.requests WHERE status = 'approved')))
      RETURNING id, approval_id, call_id, tool_name`;
    for (const action of aborted) {
      if (action.approval_id)
        await tx`UPDATE approvals.requests SET status = 'cancelled'
        WHERE id = ${action.approval_id}::uuid AND status IN ('pending', 'approved') AND requester_kind = 'assistant_turn'
          AND requester_ref = ${`${row.turn_id}/${action.call_id}`}`;
      await audit.record(
        {
          action: "ai.approval.targets.migrate",
          outcome: "allowed",
          target: { type: "ai_pending_action", id: action.id },
          metadata: { version: 1, state: "aborted", capability: action.tool_name },
        },
        tx,
      );
    }
    // A durable turn error and block make the recovery visible without rewriting any historical message.
    await tx`UPDATE ai.turns SET status = 'aborted', error = ${CAPABILITY_TARGET_REASK_HINT}, completed_at = now(),
      lease_owner = NULL, lease_expires_at = NULL,
      live_blocks = COALESCE((SELECT jsonb_agg(CASE
        WHEN block->>'kind' = 'tool' AND block->>'status' IN ('running', 'awaiting_approval', 'awaiting_client')
          THEN (block - 'approval' - 'progress') || jsonb_build_object('status', 'failed', 'isError', true,
            'approved', false, 'result', jsonb_build_object('error', ${CAPABILITY_TARGET_REASK_HINT}::text))
        ELSE block END ORDER BY ord)
        FROM jsonb_array_elements(CASE WHEN jsonb_typeof(live_blocks) = 'array' THEN live_blocks ELSE '[]'::jsonb END)
          WITH ORDINALITY AS blocks(block, ord)), '[]'::jsonb) || jsonb_build_array(jsonb_build_object('id', 'capability-target-migration', 'kind', 'text', 'text', ${CAPABILITY_TARGET_REASK_HINT}::text)),
      live_seq = live_seq + 1 WHERE id = ${row.turn_id}::uuid AND status IN ('queued', 'running', 'waiting_for_action')`;
    await tx`UPDATE ai.turn_steers SET status = 'discarded', consumed_at = COALESCE(consumed_at, now())
      WHERE turn_id = ${row.turn_id}::uuid AND status = 'pending'`;
    return true;
  }
  await tx`UPDATE ai.pending_actions SET args = ${JSON.stringify(call)}::text::jsonb WHERE id = ${row.id}::uuid`;
  await audit.record(
    {
      action: "ai.approval.targets.migrate",
      outcome: "allowed",
      target: { type: "ai_pending_action", id: row.id },
      metadata: { version: 1, state: "preserved", capability: call.capability },
    },
    tx,
  );
  return true;
};
