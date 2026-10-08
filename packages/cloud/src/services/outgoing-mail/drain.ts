import { sql } from "bun";
import { mailNextDrainDelay } from "./bulk";
import { attemptOutgoingMail } from "./dispatcher";
import type { MessageRow } from "./messages";

export const MAIL_DRAIN_MS = 60_000;
export const claimOutgoingBulkMail = async (
  profileId: string,
): Promise<{ row: MessageRow; slotAt: string; grantedAt: string } | undefined> =>
  sql.begin(async (tx) => {
    // The row update serializes slots across replicas, even if Sync redelivers a run.
    const [slot] = await tx<{ slot_at: string; granted_at: string }[]>`UPDATE outgoing_mail.profiles
      SET next_bulk_slot_at = greatest(next_bulk_slot_at, now()) + (60000.0 / pace_per_minute) * INTERVAL '1 millisecond'
      WHERE id = ${profileId}::uuid AND next_bulk_slot_at <= now() RETURNING next_bulk_slot_at::text AS slot_at, now()::text AS granted_at`;
    if (!slot) return undefined;
    const [row] = await tx<MessageRow[]>`WITH due AS (
      SELECT id FROM outgoing_mail.messages WHERE profile_id = ${profileId}::uuid AND status = 'queued' AND lane = 'bulk'
      AND (next_attempt_at IS NULL OR next_attempt_at <= now() OR deadline_at <= now())
      ORDER BY next_attempt_at NULLS FIRST, created_at, id LIMIT 1 FOR UPDATE SKIP LOCKED
    ) UPDATE outgoing_mail.messages SET status = 'sending', attempt_count = attempt_count + 1, updated_at = now()
      WHERE id IN (SELECT id FROM due) RETURNING *, created_at::text AS cursor_created_at`;
    // An idle claim consumes at most one slot. No refund race or extra state is needed.
    return row ? { row, slotAt: slot.slot_at, grantedAt: slot.granted_at } : undefined;
  });
export const nextOutgoingBulkDelay = async (profileId: string): Promise<number | undefined> => {
  const [next] = await sql<{ slot: Date; due: Date; current: Date }[]>`SELECT p.next_bulk_slot_at AS slot, now() AS current,
    min(least(COALESCE(m.next_attempt_at, now()), m.deadline_at)) AS due
    FROM outgoing_mail.profiles p JOIN outgoing_mail.messages m ON m.profile_id = p.id AND m.lane = 'bulk' AND m.status = 'queued'
    WHERE p.id = ${profileId}::uuid GROUP BY p.id`;
  return next
    ? mailNextDrainDelay(new Date(next.current).getTime(), new Date(next.slot).getTime(), new Date(next.due).getTime())
    : undefined;
};
export const dueOutgoingBulkProfiles = async (): Promise<string[]> => {
  const rows = await sql<{ profile_id: string }[]>`SELECT DISTINCT profile_id FROM outgoing_mail.messages
    WHERE lane = 'bulk' AND status = 'queued' AND profile_id IS NOT NULL
    AND (next_attempt_at IS NULL OR next_attempt_at <= now() OR deadline_at <= now()) LIMIT 1000`;
  return rows.map((row) => row.profile_id);
};
/** Stop at the next closed gate and continue durably instead of occupying a worker while waiting. */
export const drainOutgoingMail = async (
  profileId: string,
  signal?: AbortSignal,
  heartbeat?: () => Promise<void>,
): Promise<number | undefined> => {
  const until = Date.now() + MAIL_DRAIN_MS;
  // The run window bounds claims; only shutdown may cancel the current attempt.
  while (!signal?.aborted && Date.now() < until) {
    const claimed = await claimOutgoingBulkMail(profileId);
    if (!claimed) break;
    await attemptOutgoingMail(claimed.row, signal);
    await heartbeat?.();
  }
  return nextOutgoingBulkDelay(profileId);
};
