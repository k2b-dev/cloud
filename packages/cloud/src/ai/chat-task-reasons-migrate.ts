import type { SQL } from "bun";
import { canonicalLocale } from "../shared/locale";

/** Called in a transaction; the new column and its one-time backfill commit together. */
export const migrateChatTaskReasons = async (sql: SQL): Promise<void> => {
  await sql`ALTER TABLE ai.chat_tasks ADD COLUMN IF NOT EXISTS reason_code TEXT`.simple();
  await sql`ALTER TABLE ai.chat_tasks ADD COLUMN IF NOT EXISTS reason_at TIMESTAMPTZ`.simple();
  await sql`ALTER TABLE ai.chat_tasks ADD COLUMN IF NOT EXISTS title TEXT`.simple();
  const [column] = await sql`SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'ai' AND table_name = 'chat_tasks' AND column_name = 'locale'`;
  if (!column) {
    await sql`ALTER TABLE ai.chat_tasks ADD COLUMN IF NOT EXISTS locale TEXT`.simple();
    // Data-sized work runs only with the new column. A restart never rescans old turns.
    let cursor: string | null = null;
    while (true) {
      const rows: { id: string; locale: string | null }[] = await sql`
        SELECT task.id, COALESCE(
          (SELECT turn.run_config->>'locale' FROM ai.turns turn
            WHERE turn.conversation_id = task.conversation_id AND turn.run_config->>'kind' = 'chat'
              AND NOT (turn.run_config ? 'background') AND turn.created_at <= task.created_at
            ORDER BY turn.created_at DESC, turn.id DESC LIMIT 1),
          (SELECT turn.run_config->>'locale' FROM ai.turns turn
            WHERE turn.conversation_id = task.conversation_id AND turn.run_config->>'kind' = 'chat'
              AND NOT (turn.run_config ? 'background')
            ORDER BY turn.created_at DESC, turn.id DESC LIMIT 1)) AS locale
        FROM ai.chat_tasks task WHERE (${cursor}::uuid IS NULL OR task.id > ${cursor}::uuid)
        ORDER BY task.id LIMIT 500`;
      if (!rows.length) break;
      for (const row of rows) {
        const locale = canonicalLocale(row.locale);
        if (locale) await sql`UPDATE ai.chat_tasks SET locale = ${locale} WHERE id = ${row.id}::uuid`;
      }
      cursor = rows[rows.length - 1]!.id;
    }
  }
  await sql`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_chat_tasks_reason_code_check') THEN
        ALTER TABLE ai.chat_tasks ADD CONSTRAINT ai_chat_tasks_reason_code_check
          CHECK (reason_code IN ('paused', 'chat_archived', 'owner_inactive', 'failed', 'rights_changed', 'needs_approval'));
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_chat_tasks_title_check') THEN
        ALTER TABLE ai.chat_tasks ADD CONSTRAINT ai_chat_tasks_title_check CHECK (char_length(btrim(title)) BETWEEN 1 AND 80);
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_chat_tasks_reason_state_check') THEN
        UPDATE ai.chat_tasks SET reason_code = CASE
          WHEN state = 'paused' THEN 'paused'
          WHEN last_error IN ('Scheduled task mandate revision changed', 'Scheduled task mandate or sponsor is unavailable') THEN 'rights_changed'
          ELSE 'failed' END, reason_at = updated_at
        WHERE reason_code IS NULL AND state IN ('paused', 'needs_attention');
        ALTER TABLE ai.chat_tasks ADD CONSTRAINT ai_chat_tasks_reason_state_check CHECK (
          (state IN ('paused', 'needs_attention')) = (reason_code IS NOT NULL)
          AND (reason_code IS NULL OR
            (state = 'paused' AND reason_code IN ('paused', 'chat_archived', 'owner_inactive')) OR
            (state = 'needs_attention' AND reason_code IN ('failed', 'rights_changed', 'needs_approval')))
        );
      END IF;
    END $$
  `.simple();
};
