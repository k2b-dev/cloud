import { sql } from "bun";
import { mailNextDrainDelay } from "./bulk";
import { attemptOutgoingMail } from "./dispatcher";
import type { MessageRow } from "./messages";

export const MAIL_DRAIN_MS = 60_000;
export const claimOutgoingBulkMail = async (
  profileId: string,
): Promise<{ row: MessageRow; slotAt: string; grantedAt: string } | undefined> =>
  sql.begin(async (tx) => {
    // Wait for acceptance's share lock before reading the clock and reserving a slot.
    await tx`SELECT 1 FROM outgoing_mail.profiles WHERE id = ${profileId}::uuid FOR NO KEY UPDATE`;
    const [slot] = await tx<{ slot_at: string; granted_at: string }[]>`UPDATE outgoing_mail.profiles p
      SET next_bulk_slot_at = greatest(p.next_bulk_slot_at, c.at) + (60000.0 / p.pace_per_minute) * INTERVAL '1 millisecond'
      FROM (SELECT clock_timestamp() AS at) c WHERE p.id = ${profileId}::uuid AND p.next_bulk_slot_at <= c.at
      RETURNING p.next_bulk_slot_at::text AS slot_at, c.at::text AS granted_at`;
    if (!slot) return undefined;
    const [row] = await tx<MessageRow[]>`WITH due AS (
      SELECT id FROM outgoing_mail.messages WHERE profile_id = ${profileId}::uuid AND status = 'queued' AND lane = 'bulk'
      AND (next_attempt_at IS NULL OR next_attempt_at <= now()) AND deadline_at > now()
      ORDER BY COALESCE(next_attempt_at, created_at), id LIMIT 1 FOR UPDATE SKIP LOCKED
    ) UPDATE outgoing_mail.messages SET status = 'sending', attempt_count = attempt_count + 1, updated_at = now()
      WHERE id IN (SELECT id FROM due) RETURNING *, created_at::text AS cursor_created_at`;
    // An idle claim consumes at most one slot. No refund race or extra state is needed.
    return row ? { row, slotAt: slot.slot_at, grantedAt: slot.granted_at } : undefined;
  });
export const nextOutgoingBulkDelay = async (profileId: string): Promise<number | undefined> => {
  const [next] = await sql<{ slot: Date; due: Date; current: Date }[]>`SELECT p.next_bulk_slot_at AS slot, now() AS current, m.due
    FROM outgoing_mail.profiles p CROSS JOIN LATERAL (
      SELECT COALESCE(next_attempt_at, created_at) AS due FROM outgoing_mail.messages
      WHERE profile_id = p.id AND lane = 'bulk' AND status = 'queued' AND deadline_at > now()
      ORDER BY COALESCE(next_attempt_at, created_at), id LIMIT 1
    ) m WHERE p.id = ${profileId}::uuid`;
  return next
    ? mailNextDrainDelay(new Date(next.current).getTime(), new Date(next.slot).getTime(), new Date(next.due).getTime())
    : undefined;
};
export const dueOutgoingBulkProfiles = async (): Promise<string[]> => {
  const rows = await sql<{ id: string }[]>`SELECT p.id FROM outgoing_mail.profiles p WHERE EXISTS (
    SELECT 1 FROM outgoing_mail.messages m WHERE m.profile_id = p.id AND m.lane = 'bulk' AND m.status = 'queued'
    AND COALESCE(m.next_attempt_at, m.created_at) <= now() AND m.deadline_at > now()
  ) LIMIT 1000`;
  return rows.map((row) => row.id);
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
