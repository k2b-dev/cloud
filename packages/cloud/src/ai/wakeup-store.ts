import type { SQL } from "bun";
import { sql } from "../runtime/clients";
import { appendAiWakeupEvent } from "./store";
import type { AiWakeup, AiWakeupEvent } from "./wakeup-contracts";
import { describeAiWakeupRhythm } from "./wakeup-time";

export type AiWakeupRow = {
  id: string; conversation_id: string; created_by: string; next_at: Date | null; cron: string | null;
  timezone: string; ends_at: Date | null; note: string; snoozes: number; status: AiWakeup["status"];
  missed_reason: AiWakeup["missedReason"]; revision: number;
};
export const publicAiWakeup = (row: AiWakeupRow, locale: string): AiWakeup => ({
  id: row.id, at: row.next_at?.toISOString() ?? null, cron: row.cron, timezone: row.timezone,
  endsAt: row.ends_at?.toISOString() ?? null, note: row.note, snoozes: row.snoozes,
  status: row.status, missedReason: row.missed_reason, revision: Number(row.revision), rhythm: describeAiWakeupRhythm(row.cron, locale),
});

export async function migrateAiWakeups() {
  await sql`CREATE TABLE IF NOT EXISTS ai.wakeups (
    id uuid PRIMARY KEY, conversation_id uuid NOT NULL REFERENCES ai.conversations(id) ON DELETE CASCADE,
    created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    next_at timestamptz, cron text, timezone text NOT NULL, ends_at timestamptz,
    note text NOT NULL CHECK(char_length(note) BETWEEN 1 AND 200), snoozes integer NOT NULL DEFAULT 0 CHECK(snoozes BETWEEN 0 AND 3),
    status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','missed','expired','done','deleted')),
    missed_reason text CHECK(missed_reason IN ('access','budget','queue_full')), revision integer NOT NULL DEFAULT 0,
    last_message_id uuid, updated_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now()
  )`.simple();
  await sql`CREATE INDEX IF NOT EXISTS ai_wakeups_due ON ai.wakeups(next_at) WHERE status='active'`.simple();
  await sql`CREATE INDEX IF NOT EXISTS ai_wakeups_missed ON ai.wakeups(updated_at) WHERE status='missed'`.simple();
  await sql`CREATE INDEX IF NOT EXISTS ai_wakeups_chat ON ai.wakeups(conversation_id,status)`.simple();
  await sql`DROP TRIGGER IF EXISTS ai_live_wakeups_changed ON ai.wakeups`.simple();
  await sql`CREATE TRIGGER ai_live_wakeups_changed AFTER INSERT OR UPDATE OR DELETE ON ai.wakeups
    FOR EACH ROW EXECUTE FUNCTION ai.live_conversation_child_changed('conversation-detail,conversation-list')`.simple();
}

export async function recordAiWakeupEvent(row: AiWakeupRow, kind: AiWakeupEvent["kind"], locale: string, db: SQL, at = new Date()) {
  await appendAiWakeupEvent({ conversationId: row.conversation_id, event: { id: crypto.randomUUID(), kind, at: at.toISOString(), wakeup: publicAiWakeup(row, locale) }, locale }, db);
}
/** Admission can fail after queuing. Never overwrite a newer occurrence, an edit or a deletion. Caller locks the chat. */
export async function markAiWakeupMissed(conversationId: string, messageId: string, reason: "access" | "budget", locale: string, db: SQL) {
  const [row] = await db<AiWakeupRow[]>`UPDATE ai.wakeups w SET status=CASE WHEN w.cron IS NULL THEN 'missed' ELSE w.status END,
    next_at=CASE WHEN w.cron IS NULL THEN (r.origin->>'scheduledAt')::timestamptz ELSE w.next_at END,
    missed_reason=${reason},revision=w.revision+1,updated_at=clock_timestamp()
    FROM ai.chat_send_receipts r WHERE w.conversation_id=${conversationId}::uuid AND w.last_message_id=${messageId}::uuid
      AND r.id=w.last_message_id AND w.status IN ('active','done','expired') AND w.missed_reason IS NULL RETURNING w.*`;
  if (row) await recordAiWakeupEvent(row, "missed", locale, db);
}
