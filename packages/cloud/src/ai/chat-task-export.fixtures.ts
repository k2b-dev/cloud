import type { SQL } from "bun";
import { retireChatRoutines } from "./retired-routines-migrate";

/** Frozen pre-cut definitions in a private test database; never creates execution authority. */
export async function createArchivedTaskExportFixture(
  db: SQL,
  input: { conversationId: string; ownerUserId: string; shortId: string; extraRows?: number },
) {
  await db`CREATE TABLE ai.chat_tasks (
    id UUID PRIMARY KEY, short_id TEXT, conversation_id UUID, sponsor_user_id UUID, mandate_id UUID,
    title TEXT, prompt TEXT, locale TEXT, schedule_kind TEXT, run_at TIMESTAMPTZ, cron TEXT,
    timezone TEXT, state TEXT, revision INTEGER DEFAULT 1, reason_code TEXT,
    created_at TIMESTAMPTZ DEFAULT '2026-11-06T00:00:00Z', updated_at TIMESTAMPTZ DEFAULT '2026-11-06T00:00:00Z',
    retired_mandate JSONB
  )`;
  const snapshot = {
    id: "44bc0000-0000-4000-8000-999999999998",
    revision: 1,
    state: "paused",
    expires_at: null,
    policy: {
      apps: ["assistant"],
      operations: ["runtime.http"],
      actions: "require_approval",
      grants: [{ kind: "http", fixedInput: { origin: "https://example.test", method: "GET" } }],
    },
  };
  await db`INSERT INTO ai.chat_tasks(id, short_id, conversation_id, sponsor_user_id, prompt, schedule_kind, cron, timezone, state, retired_mandate)
    VALUES ('44bc0000-0000-4000-8000-999999999999', ${input.shortId}, ${input.conversationId}::uuid, ${input.ownerUserId}::uuid,
      'Summarize my mailbox and report here.', 'cron', '0 9 * * 1', 'Europe/Berlin', 'paused', ${JSON.stringify(snapshot)}::text::jsonb)`;
  if (input.extraRows)
    await db`INSERT INTO ai.chat_tasks(id, short_id, conversation_id, sponsor_user_id, prompt, schedule_kind, cron, timezone, state)
      SELECT ('44bc0000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, 'Ex' || lpad(n::text, 4, '0'),
        ${input.conversationId}::uuid, ${input.ownerUserId}::uuid, 'Historical definition', 'cron', '0 9 * * 1', 'Europe/Berlin', 'completed'
      FROM generate_series(1, ${input.extraRows}) n`;
  await retireChatRoutines(db);
}
